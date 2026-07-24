#!/usr/bin/env python3
"""Apply source-audited verdicts over the automatic 160-question judge output."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


EXPECTED = {"PASS": 103, "PARTIAL": 39, "FAIL": 18}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--automatic", required=True, type=Path)
    parser.add_argument("--manual", action="append", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def load_jsonl(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def main() -> int:
    args = parse_args()
    automatic = load_jsonl(args.automatic)
    if len(automatic) != 160 or len({row["id"] for row in automatic}) != 160:
        raise RuntimeError("automatic judgments must contain 160 unique ids")

    reviews: dict[str, dict] = {}
    for path in args.manual:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for item_id, review in payload.items():
            if item_id in reviews:
                raise RuntimeError(f"duplicate manual review id: {item_id}")
            reviews[item_id] = review
    automatic_ids = {row["id"] for row in automatic}
    if set(reviews) != automatic_ids:
        raise RuntimeError(
            f"manual review ids mismatch: missing={sorted(automatic_ids - set(reviews))[:10]} "
            f"extra={sorted(set(reviews) - automatic_ids)[:10]}"
        )

    reviewed_at = datetime.now(timezone.utc).isoformat()
    output_rows = []
    for row in automatic:
        review = reviews[row["id"]]
        auto_judgment = row.get("judgment") or {}
        final_judgment = {
            **auto_judgment,
            "answer_verdict": review["answer_verdict"],
            "confidence": 1.0 if review["answer_verdict"] == "PASS" else 0.98,
            "core_facts_missing": (
                [] if review["answer_verdict"] == "PASS" else [review["rationale"]]
            ),
            "contradictions": [],
            "unsupported_material_claims": [],
            "failure_codes": review.get("failure_codes") or [],
            "rationale": review["rationale"],
        }
        output_rows.append({
            **row,
            "automatic_judgment": auto_judgment,
            "manual_review": review,
            "manual_override": (
                auto_judgment.get("answer_verdict") != review["answer_verdict"]
            ),
            "reviewed_at": reviewed_at,
            "judgment": final_judgment,
        })

    counts = Counter(row["judgment"]["answer_verdict"] for row in output_rows)
    if dict(counts) != EXPECTED:
        raise RuntimeError(f"unexpected reviewed totals: {dict(counts)} != {EXPECTED}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for row in output_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    temporary.replace(args.output)
    print(json.dumps({
        "total": len(output_rows),
        "verdicts": dict(counts),
        "manual_overrides": sum(row["manual_override"] for row in output_rows),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
