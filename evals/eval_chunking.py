"""Manual chunking quality eval.

Run:
    python -m evals.eval_chunking --runs 3 --provider claude
"""

from __future__ import annotations

import argparse
import json
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable

from dotenv import load_dotenv

from backend.pipeline import extractor
from backend.pipeline.extractor import PartialExtractionError, extract


ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"
RESULTS = ROOT / "results"


def legacy_split_chunks(text: str, chunk_size: int = 3000) -> list[str]:
    """Old character-slice splitter kept here for apples-to-apples eval only."""
    if len(text) <= chunk_size:
        return [text]
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start = end - extractor._CHUNK_OVERLAP
    return chunks


@contextmanager
def patched_split(splitter: Callable[[str], list[str]]):
    original = extractor._split_chunks
    extractor._split_chunks = lambda text, chunk_size=None: splitter(text)
    try:
        yield
    finally:
        extractor._split_chunks = original


def _field(item: Any, name: str) -> Any:
    if isinstance(item, dict):
        return item.get(name)
    return getattr(item, name, None)


def _norm(value: Any) -> str:
    return str(value or "").strip().casefold()


def _matches(item: Any, golden: dict[str, Any]) -> bool:
    content = _norm(_field(item, "content"))
    return _norm(_field(item, "category")) == _norm(golden.get("category")) and all(
        _norm(keyword) in content for keyword in golden.get("must_include", [])
    )


def score_items(extracted: Iterable[Any], golden_items: list[dict[str, Any]]) -> dict[str, Any]:
    extracted = list(extracted)
    matched_extract_ids: set[int] = set()
    matched = []
    duplicates = 0
    owner_hits = owner_total = 0
    date_hits = date_total = 0
    unmatched = []

    for golden in golden_items:
        candidates = [idx for idx, item in enumerate(extracted) if _matches(item, golden)]
        if not candidates:
            unmatched.append(golden)
            continue

        first = candidates[0]
        matched_extract_ids.add(first)
        matched.append((golden, extracted[first]))
        duplicates += max(0, len(candidates) - 1)

        if golden.get("owner") is not None:
            owner_total += 1
            owner_hits += int(_norm(_field(extracted[first], "owner")) == _norm(golden["owner"]))
        if golden.get("date") is not None:
            date_total += 1
            date_hits += int(_norm(_field(extracted[first], "date")) == _norm(golden["date"]))

    total_golden = len(golden_items)
    total_extracted = len(extracted)
    return {
        "recall": len(matched) / total_golden if total_golden else 0.0,
        "precision": len(matched_extract_ids) / total_extracted if total_extracted else 0.0,
        "owner_accuracy": owner_hits / owner_total if owner_total else None,
        "date_accuracy": date_hits / date_total if date_total else None,
        "duplicates": duplicates,
        "matched": len(matched),
        "extracted": total_extracted,
        "unmatched": unmatched,
    }


@dataclass
class Fixture:
    name: str
    text: str
    golden_items: list[dict[str, Any]]


def load_fixtures() -> list[Fixture]:
    fixtures = []
    for doc_path in sorted(FIXTURES.glob("*.md")):
        golden_path = doc_path.with_suffix(".golden.json")
        with golden_path.open(encoding="utf-8") as f:
            golden = json.load(f)
        fixtures.append(Fixture(doc_path.stem, doc_path.read_text(encoding="utf-8"), golden["items"]))
    return fixtures


def _average(rows: list[dict[str, Any]], key: str) -> float | None:
    values = [row[key] for row in rows if row[key] is not None]
    return (sum(values) / len(values)) if values else None


def _fmt(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.2f}"
    return str(value)


def _run_once(fixture: Fixture, mode: str, provider: str | None) -> dict[str, Any]:
    splitter = legacy_split_chunks if mode == "legacy" else extractor._split_chunks
    calls = len(splitter(fixture.text))
    started = time.perf_counter()

    try:
        if mode == "legacy":
            with patched_split(lambda text: legacy_split_chunks(text, 3000)):
                items = extract(fixture.text, provider=provider, default_source=f"{fixture.name}.md")
        else:
            items = extract(fixture.text, provider=provider, default_source=f"{fixture.name}.md")
    except PartialExtractionError as exc:
        items = exc.items

    elapsed = time.perf_counter() - started
    score = score_items(items, fixture.golden_items)
    score.update({"llm_calls": calls, "seconds": elapsed})
    return score


def _mean_run(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "recall": _average(rows, "recall"),
        "precision": _average(rows, "precision"),
        "owner_accuracy": _average(rows, "owner_accuracy"),
        "date_accuracy": _average(rows, "date_accuracy"),
        "duplicates": _average(rows, "duplicates"),
        "llm_calls": _average(rows, "llm_calls"),
        "seconds": _average(rows, "seconds"),
        "unmatched": rows[-1]["unmatched"],
    }


def _table(rows: list[dict[str, Any]], columns: list[str]) -> str:
    widths = {col: max(len(col), *(len(_fmt(row.get(col))) for row in rows)) for col in columns}
    header = " | ".join(col.ljust(widths[col]) for col in columns)
    sep = " | ".join("-" * widths[col] for col in columns)
    body = [" | ".join(_fmt(row.get(col)).ljust(widths[col]) for col in columns) for row in rows]
    return "\n".join([header, sep, *body])


def write_report(rows: list[dict[str, Any]]) -> Path:
    RESULTS.mkdir(exist_ok=True)
    path = RESULTS / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}.md"
    summary = []
    for mode in ("legacy", "new"):
        mode_rows = [row for row in rows if row["mode"] == mode]
        summary.append({
            "mode": mode,
            "recall": _average(mode_rows, "recall"),
            "precision": _average(mode_rows, "precision"),
            "owner_accuracy": _average(mode_rows, "owner_accuracy"),
            "date_accuracy": _average(mode_rows, "date_accuracy"),
            "duplicates": _average(mode_rows, "duplicates"),
            "llm_calls": _average(mode_rows, "llm_calls"),
            "seconds": _average(mode_rows, "seconds"),
        })

    columns = ["mode", "fixture", "recall", "precision", "owner_accuracy", "date_accuracy", "duplicates", "llm_calls", "seconds"]
    lines = [
        "# Chunking Eval",
        "",
        "## Summary",
        "",
        _table(summary, [col for col in columns if col != "fixture"]),
        "",
        "## Fixtures",
        "",
        _table(rows, columns),
        "",
        "## Unmatched Golden Items",
        "",
    ]
    for row in rows:
        lines.append(f"### {row['mode']} / {row['fixture']}")
        if not row["unmatched"]:
            lines.append("- none")
        for item in row["unmatched"]:
            lines.append(f"- {item['category']}: {', '.join(item.get('must_include', []))}")
        lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--provider", default=None)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be >= 1")
    load_dotenv()

    rows = []
    for fixture in load_fixtures():
        for mode in ("legacy", "new"):
            run_rows = [_run_once(fixture, mode, args.provider) for _ in range(args.runs)]
            row = _mean_run(run_rows)
            row.update({"mode": mode, "fixture": fixture.name})
            rows.append(row)

    columns = ["mode", "fixture", "recall", "precision", "owner_accuracy", "date_accuracy", "duplicates", "llm_calls", "seconds"]
    print(_table(rows, columns))
    print(f"\nreport: {write_report(rows)}")


if __name__ == "__main__":
    main()
