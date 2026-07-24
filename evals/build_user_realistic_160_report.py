#!/usr/bin/env python3
"""Build the PaiM user-realistic 160-question evaluation report.

This module is deliberately report-only.  It joins a completed golden JSON,
one or more actual-result JSONL files, and a judgment JSONL file, then writes
the same evidence as Markdown, self-contained HTML, row-level CSV, and a
machine-readable summary JSON.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


VERDICTS = ("PASS", "PARTIAL", "FAIL")
VERDICT_KO = {
    "PASS": "일치",
    "PARTIAL": "부분일치",
    "FAIL": "불일치",
    "UNJUDGED": "미판정",
}
GOLDEN_LIMITATION = (
    "원본 160문항 CSV에는 정답이 없으므로, 이 보고서의 완성 골든은 기존 골든 "
    "100문항을 재사용하고 나머지 60문항을 원문에서 독립 복원한 결과다. 따라서 "
    "정답률은 원본 질문 CSV 자체가 아니라 제공된 reference_answer, gold_sources, "
    "answer_contract, gold_provenance의 품질을 전제로 해석해야 한다."
)
GOLDEN_REQUIRED_FIELDS = {
    "id",
    "corpus",
    "family",
    "question",
    "reference_answer",
    "gold_sources",
    "expected_tools",
    "answer_contract",
    "gold_provenance",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the PaiM user-realistic 160-question evaluation report."
    )
    parser.add_argument("--golden", required=True, type=Path)
    parser.add_argument("--actual", action="append", required=True, type=Path)
    parser.add_argument("--judgments", required=True, type=Path)
    parser.add_argument("--output-html", required=True, type=Path)
    parser.add_argument("--output-md", required=True, type=Path)
    parser.add_argument("--output-csv", required=True, type=Path)
    parser.add_argument("--summary-json", required=True, type=Path)
    parser.add_argument("--diagnostics", type=Path)
    return parser.parse_args()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def load_jsonl(paths: Iterable[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        text = path.read_text(encoding="utf-8-sig")
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise RuntimeError(f"{path}:{line_number}: JSON object가 아닙니다")
            rows.append(value)
    return rows


def row_id(row: dict[str, Any]) -> str:
    return str(row.get("id") or row.get("qid") or row.get("item_id") or "").strip()


def index_unique(
    rows: Iterable[dict[str, Any]], label: str
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        identifier = row_id(row)
        if not identifier:
            raise RuntimeError(f"{label}: id가 없는 행이 있습니다: {row}")
        if identifier in result:
            raise RuntimeError(f"{label}: 중복 id {identifier}")
        result[identifier] = row
    return result


def validate_golden(golden: Any) -> list[dict[str, Any]]:
    if not isinstance(golden, dict):
        raise RuntimeError("golden JSON은 object여야 합니다")
    items = golden.get("items")
    if not isinstance(items, list) or not items:
        raise RuntimeError("golden JSON의 items가 비어 있습니다")
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise RuntimeError(f"golden items[{index}]가 object가 아닙니다")
        missing = sorted(GOLDEN_REQUIRED_FIELDS - set(item))
        if missing:
            raise RuntimeError(
                f"golden items[{index}] ({row_id(item) or 'id 없음'}) 필드 누락: "
                + ", ".join(missing)
            )
        if not isinstance(item.get("answer_contract"), dict):
            raise RuntimeError(
                f"golden {row_id(item)}: answer_contract는 object여야 합니다"
            )
    index_unique(items, "golden")
    return items


def as_text(value: Any, default: str = "(없음)") -> str:
    if value is None or value == "":
        return default
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, default=str)


def pretty_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, default=str)


def string_list(value: Any, *, split_tools: bool = False) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return []
        values = raw.split("+") if split_tools and "+" in raw else [raw]
    elif isinstance(value, (list, tuple, set)):
        values = list(value)
    else:
        values = [value]

    result: list[str] = []
    for item in values:
        if isinstance(item, dict):
            text = str(item.get("name") or item.get("tool") or "").strip()
        else:
            text = str(item).strip()
        if text and text not in result:
            result.append(text)
    return result


def source_list(value: Any) -> list[str]:
    return string_list(value)


def source_text(value: Any) -> str:
    values = source_list(value)
    return ", ".join(values) if values else "출처 없음"


def expected_tools(golden: dict[str, Any]) -> list[str]:
    return string_list(golden.get("expected_tools"), split_tools=True)


def actual_debug(actual: dict[str, Any] | None) -> dict[str, Any]:
    if not actual:
        return {}
    value = actual.get("debug")
    return value if isinstance(value, dict) else {}


def actual_tool_eval(actual: dict[str, Any] | None) -> dict[str, Any]:
    if not actual:
        return {}
    value = actual.get("tool_eval")
    return value if isinstance(value, dict) else {}


def actual_tools(actual: dict[str, Any] | None) -> tuple[list[str], bool]:
    """Return deduplicated tool names and whether tool evidence was present."""
    if actual is None:
        return [], False

    debug = actual_debug(actual)
    tool_eval = actual_tool_eval(actual)
    direct_candidates = (
        (actual, "tools_used"),
        (debug, "tools_used"),
        (tool_eval, "actual_tools"),
        (tool_eval, "tools_used"),
    )
    for container, key in direct_candidates:
        if key in container:
            return string_list(container.get(key), split_tools=True), True

    call_candidates = (
        actual.get("tool_calls"),
        debug.get("tool_calls"),
        tool_eval.get("actual_tool_calls"),
    )
    for calls in call_candidates:
        if isinstance(calls, list):
            return string_list(calls), True
    return [], False


def actual_tool_calls(actual: dict[str, Any] | None) -> list[dict[str, Any]]:
    if actual is None:
        return []
    debug = actual_debug(actual)
    for value in (
        actual.get("tool_calls"),
        debug.get("tool_calls"),
        actual_tool_eval(actual).get("actual_tool_calls"),
    ):
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def bool_value(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().upper()
        if normalized in {"PASS", "PASSED", "TRUE", "OK", "MATCH", "MATCHED"}:
            return True
        if normalized in {
            "FAIL",
            "FAILED",
            "FALSE",
            "ERROR",
            "MISMATCH",
            "MISMATCHED",
        }:
            return False
    if isinstance(value, dict):
        for key in ("pass", "passed", "ok", "matched", "value", "status"):
            if key in value:
                parsed = bool_value(value[key])
                if parsed is not None:
                    return parsed
    return None


def tool_eval_fallback(actual: dict[str, Any] | None, kind: str) -> bool | None:
    if actual is None:
        return None
    aliases = {
        "exact": (
            "exact_match",
            "exact",
            "expected_tools_exact",
            "tool_selection_exact",
            "exact_tools_match",
        ),
        "required": (
            "required_coverage",
            "required_tools_covered",
            "required_tools_pass",
            "coverage_pass",
            "tool_selection_pass",
        ),
    }
    tool_eval = actual_tool_eval(actual)
    for container in (tool_eval, actual):
        for key in aliases[kind]:
            if key in container:
                parsed = bool_value(container[key])
                if parsed is not None:
                    return parsed
    return None


def api_success(actual: dict[str, Any] | None) -> bool:
    if actual is None or actual.get("error"):
        return False
    status = actual.get("http_status", actual.get("status_code"))
    try:
        return int(status) == 200
    except (TypeError, ValueError):
        return False


def latency_value(actual: dict[str, Any] | None) -> float | None:
    if actual is None:
        return None
    value = actual.get("latency_ms")
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def judgment_body(row: dict[str, Any] | None) -> dict[str, Any]:
    if row is None:
        return {}
    value = row.get("judgment")
    return value if isinstance(value, dict) else row


def judgment_verdict(row: dict[str, Any] | None) -> str | None:
    body = judgment_body(row)
    raw = body.get("answer_verdict") or body.get("verdict")
    normalized = str(raw or "").strip().upper()
    return normalized if normalized in VERDICTS else None


def failure_codes(row: dict[str, Any] | None) -> list[str]:
    values = string_list(judgment_body(row).get("failure_codes"))
    return list(dict.fromkeys(values))


def build_records(
    golden_items: list[dict[str, Any]],
    actual_rows: list[dict[str, Any]],
    judgment_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, list[str]]]:
    golden_index = index_unique(golden_items, "golden")
    actual_index = index_unique(actual_rows, "actual")
    judgment_index = index_unique(judgment_rows, "judgments")

    records: list[dict[str, Any]] = []
    for identifier, gold in golden_index.items():
        actual = actual_index.get(identifier)
        judge_row = judgment_index.get(identifier)
        wanted = expected_tools(gold)
        observed, has_tool_evidence = actual_tools(actual)
        if has_tool_evidence:
            exact: bool | None = set(observed) == set(wanted)
            required: bool | None = set(wanted).issubset(set(observed))
        else:
            exact = tool_eval_fallback(actual, "exact")
            required = tool_eval_fallback(actual, "required")
        records.append(
            {
                "golden": gold,
                "actual": actual,
                "judgment": judge_row,
                "expected_tools": wanted,
                "actual_tools": observed,
                "tool_evidence_present": has_tool_evidence,
                "tools_exact": exact,
                "required_tools_covered": required,
                "verdict": judgment_verdict(judge_row),
                "failure_codes": failure_codes(judge_row),
            }
        )

    extras = {
        "actual": sorted(set(actual_index) - set(golden_index)),
        "judgments": sorted(set(judgment_index) - set(golden_index)),
        "missing_actual": sorted(set(golden_index) - set(actual_index)),
        "missing_judgments": sorted(set(golden_index) - set(judgment_index)),
    }
    return records, extras


def percentile(values: Sequence[float], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 6) if denominator else None


def tool_metric_summary(
    records: list[dict[str, Any]], field: str
) -> dict[str, Any]:
    values = [record[field] for record in records]
    passed = sum(value is True for value in values)
    failed = sum(value is False for value in values)
    evaluated = passed + failed
    total = len(records)
    return {
        "passed": passed,
        "failed": failed,
        "unavailable": total - evaluated,
        "evaluated": evaluated,
        "total": total,
        "strict_rate": rate(passed, total),
        "evaluated_rate": rate(passed, evaluated),
    }


def latency_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    values = [
        value
        for record in records
        if (value := latency_value(record["actual"])) is not None
    ]
    if not values:
        return {
            "samples": 0,
            "avg": None,
            "median": None,
            "p95": None,
            "min": None,
            "max": None,
        }
    return {
        "samples": len(values),
        "avg": round(statistics.fmean(values), 1),
        "median": round(statistics.median(values), 1),
        "p95": round(percentile(values, 0.95) or 0.0, 1),
        "min": round(min(values), 1),
        "max": round(max(values), 1),
    }


def summarize_group(records: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(records)
    verdicts = Counter(record["verdict"] for record in records if record["verdict"])
    judged = sum(verdicts.values())
    api_passed = sum(api_success(record["actual"]) for record in records)
    code_counts = Counter(
        code for record in records for code in record["failure_codes"]
    )
    return {
        "total": total,
        "actual_results": sum(record["actual"] is not None for record in records),
        "judged": judged,
        "judgment_coverage": rate(judged, total),
        "verdicts": {
            "PASS": verdicts["PASS"],
            "PARTIAL": verdicts["PARTIAL"],
            "FAIL": verdicts["FAIL"],
            "UNJUDGED": total - judged,
        },
        # Missing judgments remain outside PASS and therefore lower the strict rate.
        "strict_pass_rate": rate(verdicts["PASS"], total),
        "pass_or_partial_rate": rate(
            verdicts["PASS"] + verdicts["PARTIAL"], total
        ),
        "api_success": {
            "passed": api_passed,
            "total": total,
            "rate": rate(api_passed, total),
        },
        "expected_tools_exact": tool_metric_summary(records, "tools_exact"),
        "expected_tools_required_coverage": tool_metric_summary(
            records, "required_tools_covered"
        ),
        "latency_ms": latency_summary(records),
        "failure_codes": dict(
            sorted(code_counts.items(), key=lambda item: (-item[1], item[0]))
        ),
    }


def group_records(
    records: list[dict[str, Any]], field: str
) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        key = str(record["golden"].get(field) or "unknown")
        result[key].append(record)
    return dict(result)


def build_summary(
    golden: dict[str, Any],
    records: list[dict[str, Any]],
    extras: dict[str, list[str]],
) -> dict[str, Any]:
    return {
        "report_version": "user-realistic-160-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset_id": golden.get("dataset_id"),
        "source_commit": golden.get("source_commit"),
        "golden_limitation": GOLDEN_LIMITATION,
        "input_integrity": extras,
        "overall": summarize_group(records),
        "by_corpus": {
            name: summarize_group(group)
            for name, group in group_records(records, "corpus").items()
        },
        "by_family": {
            name: summarize_group(group)
            for name, group in group_records(records, "family").items()
        },
    }


def percent_text(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def count_rate_text(metric: dict[str, Any], *, count_key: str = "passed") -> str:
    metric_rate = (
        metric["strict_rate"] if "strict_rate" in metric else metric.get("rate")
    )
    return (
        f"{metric[count_key]}/{metric['total']} "
        f"({percent_text(metric_rate)})"
    )


def tool_metric_text(metric: dict[str, Any]) -> str:
    value = count_rate_text(metric)
    if metric["unavailable"]:
        value += f" · 평가 불가 {metric['unavailable']}"
    return value


def latency_text(metric: dict[str, Any]) -> str:
    if not metric["samples"]:
        return "—"
    return (
        f"평균 {metric['avg']:.1f} · 중앙 {metric['median']:.1f} · "
        f"p95 {metric['p95']:.1f} ms (n={metric['samples']})"
    )


def md_escape(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def markdown_quote(value: Any) -> str:
    return "\n".join(
        f"> {line}" if line else ">" for line in as_text(value).splitlines()
    )


def group_table_md(
    title: str, groups: dict[str, list[dict[str, Any]]]
) -> list[str]:
    lines = [
        f"## {title}",
        "",
        "| 구분 | 문항 | PASS/PARTIAL/FAIL/미판정 | 엄격 PASS | API 성공 | 기대 도구 정확 일치 | 필수 도구 포함 | 지연시간 |",
        "|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for name, records in groups.items():
        stats = summarize_group(records)
        verdicts = stats["verdicts"]
        lines.append(
            f"| {md_escape(name)} | {stats['total']} | "
            f"{verdicts['PASS']}/{verdicts['PARTIAL']}/{verdicts['FAIL']}/{verdicts['UNJUDGED']} | "
            f"{percent_text(stats['strict_pass_rate'])} | "
            f"{stats['api_success']['passed']}/{stats['total']} | "
            f"{tool_metric_text(stats['expected_tools_exact'])} | "
            f"{tool_metric_text(stats['expected_tools_required_coverage'])} | "
            f"{latency_text(stats['latency_ms'])} |"
        )
    lines.append("")
    return lines


def list_detail_md(label: str, value: Any) -> list[str]:
    values = string_list(value)
    if not values:
        return [f"- **{label}:** 없음"]
    return [f"- **{label}:** " + "; ".join(values)]


def diagnostics_markdown(value: Any) -> list[str]:
    if not isinstance(value, dict) or not value:
        return []
    lines = [f"## {value.get('title', '핵심 진단')}", ""]
    if value.get("headline"):
        lines += [str(value["headline"]), ""]
    metrics = value.get("metrics") or []
    if metrics:
        lines += ["| 지표 | 결과 | 해석 |", "|---|---:|---|"]
        for metric in metrics:
            lines.append(
                f"| {md_escape(metric.get('label', ''))} | {md_escape(metric.get('value', ''))} | "
                f"{md_escape(metric.get('detail', ''))} |"
            )
        lines.append("")
    for finding in value.get("findings") or []:
        lines += [f"### {finding.get('title', '진단')}", "", str(finding.get("summary") or ""), ""]
        evidence = finding.get("evidence") or []
        lines += [f"- {item}" for item in evidence]
        if evidence:
            lines.append("")
    limitations = value.get("limitations") or []
    if limitations:
        lines += ["### 해석 한계", ""] + [f"- {item}" for item in limitations] + [""]
    return lines


def build_markdown(
    golden: dict[str, Any],
    records: list[dict[str, Any]],
    extras: dict[str, list[str]],
    summary: dict[str, Any],
) -> str:
    overall = summary["overall"]
    verdicts = overall["verdicts"]
    lines = [
        "# PaiM 실제 사용자형 160문항 평가 보고서",
        "",
        f"> **골든 구성 한계:** {GOLDEN_LIMITATION}",
        "",
        f"- 데이터셋: `{golden.get('dataset_id', 'unknown')}`",
        f"- 원문 기준 커밋: `{golden.get('source_commit', 'unknown')}`",
        f"- 골든 문항: {overall['total']}개",
        f"- 실제 결과: {overall['actual_results']}/{overall['total']}",
        f"- Judge 판정: {overall['judged']}/{overall['total']}",
        f"- 최종 판정: PASS {verdicts['PASS']} · PARTIAL {verdicts['PARTIAL']} · FAIL {verdicts['FAIL']} · 미판정 {verdicts['UNJUDGED']}",
        f"- 엄격 PASS 정답률: {verdicts['PASS']}/{overall['total']} ({percent_text(overall['strict_pass_rate'])})",
        f"- API 성공: {overall['api_success']['passed']}/{overall['total']} ({percent_text(overall['api_success']['rate'])})",
        f"- 기대 도구 정확 일치: {tool_metric_text(overall['expected_tools_exact'])}",
        f"- 필수 기대 도구 포함: {tool_metric_text(overall['expected_tools_required_coverage'])}",
        f"- 응답시간: {latency_text(overall['latency_ms'])}",
        "",
        "엄격 PASS 정답률의 분모는 전체 골든 문항입니다. 실행 또는 판정이 누락된 문항은 PASS로 계산하지 않습니다. 기대 도구 정확 일치는 실제 도구 집합과 기대 도구 집합이 같은 경우이고, 필수 도구 포함은 기대 집합이 실제 집합의 부분집합인 경우입니다.",
        "",
    ]
    warnings = []
    if extras["missing_actual"]:
        warnings.append(f"실제 결과 누락 {len(extras['missing_actual'])}개")
    if extras["missing_judgments"]:
        warnings.append(f"Judge 판정 누락 {len(extras['missing_judgments'])}개")
    if extras["actual"]:
        warnings.append(f"골든에 없는 실제 결과 {len(extras['actual'])}개 제외")
    if extras["judgments"]:
        warnings.append(f"골든에 없는 Judge 결과 {len(extras['judgments'])}개 제외")
    if warnings:
        lines += ["> **입력 경고:** " + " · ".join(warnings), ""]

    lines += diagnostics_markdown(summary.get("diagnostics"))
    lines += group_table_md("코퍼스별", group_records(records, "corpus"))
    lines += group_table_md("질문 family별", group_records(records, "family"))
    lines += ["## 실패 코드", ""]
    if overall["failure_codes"]:
        lines += ["| 코드 | 문항 수 |", "|---|---:|"]
        lines += [
            f"| `{md_escape(code)}` | {count} |"
            for code, count in overall["failure_codes"].items()
        ]
        lines.append("")
    else:
        lines += ["집계된 실패 코드가 없습니다.", ""]

    lines += ["## 문항별 정답·실제 비교", ""]
    for record in records:
        gold = record["golden"]
        actual = record["actual"]
        judge = judgment_body(record["judgment"])
        verdict = record["verdict"] or "UNJUDGED"
        exact = record["tools_exact"]
        required = record["required_tools_covered"]
        lines += [
            f"### {row_id(gold)} · {gold.get('corpus')} · {gold.get('family')} · {VERDICT_KO[verdict]}",
            "",
            "#### (정답)",
            "",
            "**질문**",
            "",
            str(gold.get("question") or ""),
            "",
            "**답변**",
            "",
            markdown_quote(gold.get("reference_answer")),
            "",
            f"**참고문항(출처)**\n\n{source_text(gold.get('gold_sources'))}",
            "",
            f"**기대 도구** `{', '.join(record['expected_tools']) or '없음'}`",
            "",
            "**답변 계약**",
            "",
            "```json",
            pretty_json(gold.get("answer_contract") or {}),
            "```",
            "",
            "**골든 구성 근거**",
            "",
            "```json",
            pretty_json(gold.get("gold_provenance")),
            "```",
            "",
        ]
        if gold.get("gold_manual_review_note"):
            lines += [f"**골든 수동 교정:** {gold['gold_manual_review_note']}", ""]
        if gold.get("gold_semantic_caveat"):
            lines += [f"> **의미상 주의:** {gold['gold_semantic_caveat']}", ""]
        lines += [
            "#### (실제)",
            "",
            "**질문**",
            "",
            str(gold.get("question") or ""),
            "",
        ]
        if actual is None:
            lines += ["> 실제 결과 행이 없습니다.", ""]
        else:
            lines += [
                "**답변**",
                "",
                markdown_quote(actual.get("answer")),
                "",
                f"**참고문항(실제 sources)**\n\n{source_text(actual.get('sources'))}",
                "",
                f"**실제 도구** `{', '.join(record['actual_tools']) or '없음'}`",
                "",
                f"**도구 판정** 정확 일치 `{exact if exact is not None else 'N/A'}` · 필수 포함 `{required if required is not None else 'N/A'}`",
                "",
                f"**API** `{actual.get('http_status', '—')}` · **응답시간** `{actual.get('latency_ms', '—')} ms`",
                "",
            ]
            if actual.get("error"):
                lines += [f"**실행 오류:** {actual['error']}", ""]
            calls = actual_tool_calls(actual)
            if calls:
                lines += [
                    "**실제 도구 호출**",
                    "",
                    "```json",
                    pretty_json(calls),
                    "```",
                    "",
                ]

        lines += [
            "#### 판정 이유",
            "",
            f"**{VERDICT_KO[verdict]}**"
            + (
                f" · 신뢰도 `{judge.get('confidence')}`"
                if judge.get("confidence") is not None
                else ""
            ),
            "",
            as_text(judge.get("rationale"), "Judge 판정 이유가 없습니다."),
            "",
        ]
        judgment_meta = record.get("judgment") or {}
        if judgment_meta.get("manual_review"):
            automatic_verdict = (judgment_meta.get("automatic_judgment") or {}).get("answer_verdict")
            lines += [
                f"**판정 방식:** 원문 수동 전수 감사 · 자동 Judge `{automatic_verdict or 'N/A'}` → "
                f"최종 `{verdict}`{' (수정)' if judgment_meta.get('manual_override') else ''}",
                "",
            ]
        lines += list_detail_md("누락 핵심 사실", judge.get("core_facts_missing"))
        lines += list_detail_md("모순", judge.get("contradictions"))
        lines += list_detail_md(
            "근거 없는 중요 주장", judge.get("unsupported_material_claims")
        )
        lines += list_detail_md("실패 코드", judge.get("failure_codes"))
        lines += ["", "---", ""]
    return "\n".join(lines).rstrip() + "\n"


def clean_markdown(text: str) -> str:
    """Generated evidence can contain source-authored trailing spaces."""
    return "\n".join(line.rstrip() for line in text.splitlines()) + "\n"


def html_value(value: Any, default: str = "(없음)") -> str:
    return html.escape(as_text(value, default))


def metric_badge(value: bool | None, true_label: str, false_label: str) -> str:
    css = "na" if value is None else "pass" if value else "fail"
    label = "N/A" if value is None else true_label if value else false_label
    return f'<span class="badge {css}">{html.escape(label)}</span>'


def group_table_html(
    title: str, groups: dict[str, list[dict[str, Any]]]
) -> str:
    rows = []
    for name, records in groups.items():
        stats = summarize_group(records)
        verdicts = stats["verdicts"]
        rows.append(
            "<tr>"
            f"<td>{html.escape(name)}</td>"
            f"<td>{stats['total']}</td>"
            f"<td>{verdicts['PASS']}/{verdicts['PARTIAL']}/{verdicts['FAIL']}/{verdicts['UNJUDGED']}</td>"
            f"<td>{html.escape(percent_text(stats['strict_pass_rate']))}</td>"
            f"<td>{stats['api_success']['passed']}/{stats['total']}</td>"
            f"<td>{html.escape(tool_metric_text(stats['expected_tools_exact']))}</td>"
            f"<td>{html.escape(tool_metric_text(stats['expected_tools_required_coverage']))}</td>"
            f"<td>{html.escape(latency_text(stats['latency_ms']))}</td>"
            "</tr>"
        )
    return f"""
<section><h2>{html.escape(title)}</h2><div class="table-wrap"><table>
<thead><tr><th>구분</th><th>문항</th><th>PASS/PARTIAL/FAIL/미판정</th><th>엄격 PASS</th><th>API 성공</th><th>기대 도구 정확 일치</th><th>필수 도구 포함</th><th>지연시간</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table></div></section>"""


def detail_list_html(label: str, value: Any) -> str:
    values = string_list(value)
    if not values:
        return f"<li><strong>{html.escape(label)}</strong>: 없음</li>"
    return (
        f"<li><strong>{html.escape(label)}</strong>: "
        + "; ".join(html.escape(item) for item in values)
        + "</li>"
    )


def diagnostics_html(value: Any) -> str:
    if not isinstance(value, dict) or not value:
        return ""
    metric_rows = "".join(
        "<tr>"
        f"<td>{html.escape(str(item.get('label', '')))}</td>"
        f"<td><strong>{html.escape(str(item.get('value', '')))}</strong></td>"
        f"<td>{html.escape(str(item.get('detail', '')))}</td>"
        "</tr>"
        for item in value.get("metrics") or []
    )
    metrics = (
        "<div class='table-wrap'><table><thead><tr><th>지표</th><th>결과</th><th>해석</th></tr></thead>"
        f"<tbody>{metric_rows}</tbody></table></div>" if metric_rows else ""
    )
    findings = "".join(
        f"<h3>{html.escape(str(item.get('title', '진단')))}</h3>"
        f"<p>{html.escape(str(item.get('summary', '')))}</p>"
        + (
            "<ul>" + "".join(f"<li>{html.escape(str(evidence))}</li>" for evidence in item.get("evidence") or []) + "</ul>"
            if item.get("evidence") else ""
        )
        for item in value.get("findings") or []
    )
    limitations = value.get("limitations") or []
    limit_html = (
        "<h3>해석 한계</h3><ul>" + "".join(f"<li>{html.escape(str(item))}</li>" for item in limitations) + "</ul>"
        if limitations else ""
    )
    return (
        f"<section class='callout'><h2>{html.escape(str(value.get('title', '핵심 진단')))}</h2>"
        f"<p>{html.escape(str(value.get('headline', '')))}</p>{metrics}{findings}{limit_html}</section>"
    )


def build_html(
    golden: dict[str, Any],
    records: list[dict[str, Any]],
    extras: dict[str, list[str]],
    summary: dict[str, Any],
) -> str:
    overall = summary["overall"]
    verdicts = overall["verdicts"]
    warning_parts = []
    if extras["missing_actual"]:
        warning_parts.append(f"실제 결과 누락 {len(extras['missing_actual'])}개")
    if extras["missing_judgments"]:
        warning_parts.append(f"Judge 판정 누락 {len(extras['missing_judgments'])}개")
    if extras["actual"]:
        warning_parts.append(f"골든에 없는 실제 결과 {len(extras['actual'])}개 제외")
    if extras["judgments"]:
        warning_parts.append(f"골든에 없는 Judge 결과 {len(extras['judgments'])}개 제외")
    input_warning = (
        '<section class="callout warning"><strong>입력 경고:</strong> '
        + html.escape(" · ".join(warning_parts))
        + "</section>"
        if warning_parts
        else ""
    )

    failure_rows = "".join(
        f"<tr><td><code>{html.escape(code)}</code></td><td>{count}</td></tr>"
        for code, count in overall["failure_codes"].items()
    )
    failure_section = (
        f'<section><h2>실패 코드</h2><div class="table-wrap"><table><thead><tr><th>코드</th><th>문항 수</th></tr></thead><tbody>{failure_rows}</tbody></table></div></section>'
        if failure_rows
        else '<section><h2>실패 코드</h2><p class="muted">집계된 실패 코드가 없습니다.</p></section>'
    )

    cards: list[str] = []
    for record in records:
        gold = record["golden"]
        actual = record["actual"]
        judge = judgment_body(record["judgment"])
        verdict = record["verdict"] or "UNJUDGED"
        css_verdict = verdict.lower()
        expected = ", ".join(record["expected_tools"]) or "없음"
        observed = ", ".join(record["actual_tools"]) or "없음"
        actual_panel = '<p class="missing">실제 결과 행이 없습니다.</p>'
        if actual is not None:
            calls = actual_tool_calls(actual)
            calls_html = (
                f"<h4>실제 도구 호출</h4><pre>{html.escape(pretty_json(calls))}</pre>"
                if calls
                else ""
            )
            error_html = (
                f'<p class="error"><strong>실행 오류:</strong> {html.escape(str(actual.get("error")))}</p>'
                if actual.get("error")
                else ""
            )
            actual_panel = f"""
<h4>질문</h4><p>{html.escape(str(gold.get('question') or ''))}</p>
<h4>답변</h4><pre>{html_value(actual.get('answer'))}</pre>
<h4>참고문항(실제 sources)</h4><p>{html.escape(source_text(actual.get('sources')))}</p>
<h4>실제 도구</h4><p><code>{html.escape(observed)}</code></p>
<p>{metric_badge(record['tools_exact'], '기대 도구 정확 일치', '기대 도구 불일치')}{metric_badge(record['required_tools_covered'], '필수 도구 포함', '필수 도구 누락')}</p>
<p class="meta"><strong>API</strong> {html.escape(str(actual.get('http_status', '—')))} · <strong>응답시간</strong> {html.escape(str(actual.get('latency_ms', '—')))} ms</p>
{calls_html}{error_html}"""

        confidence = judge.get("confidence")
        confidence_html = (
            f' · 신뢰도 <code>{html.escape(str(confidence))}</code>'
            if confidence is not None
            else ""
        )
        rationale = html_value(judge.get("rationale"), "Judge 판정 이유가 없습니다.")
        judgment_meta = record.get("judgment") or {}
        manual_html = ""
        if judgment_meta.get("manual_review"):
            automatic_verdict = (judgment_meta.get("automatic_judgment") or {}).get("answer_verdict") or "N/A"
            suffix = " (수정)" if judgment_meta.get("manual_override") else ""
            manual_html = (
                "<p class='meta'><strong>판정 방식:</strong> 원문 수동 전수 감사 · "
                f"자동 Judge <code>{html.escape(str(automatic_verdict))}</code> → "
                f"최종 <code>{html.escape(verdict)}</code>{suffix}</p>"
            )
        gold_review_html = (
            f"<p class='meta'><strong>골든 수동 교정:</strong> {html.escape(str(gold.get('gold_manual_review_note')))}</p>"
            if gold.get("gold_manual_review_note") else ""
        )
        gold_caveat_html = (
            f"<p class='error'><strong>의미상 주의:</strong> {html.escape(str(gold.get('gold_semantic_caveat')))}</p>"
            if gold.get("gold_semantic_caveat") else ""
        )
        open_attr = " open" if verdict != "PASS" else ""
        cards.append(
            f"""
<details class="item {css_verdict}"{open_attr}>
 <summary><strong>{html.escape(row_id(gold))}</strong><span class="family">{html.escape(str(gold.get('corpus')))} · {html.escape(str(gold.get('family')))}</span><span class="question">{html.escape(str(gold.get('question') or ''))}</span><span class="badge {css_verdict}">{html.escape(VERDICT_KO[verdict])}</span></summary>
 <div class="compare">
  <article class="gold"><h3>(정답)</h3>
   <h4>질문</h4><p>{html.escape(str(gold.get('question') or ''))}</p>
   <h4>답변</h4><pre>{html_value(gold.get('reference_answer'))}</pre>
   <h4>참고문항(출처)</h4><p>{html.escape(source_text(gold.get('gold_sources')))}</p>
   <h4>기대 도구</h4><p><code>{html.escape(expected)}</code></p>
   <h4>답변 계약</h4><pre>{html.escape(pretty_json(gold.get('answer_contract') or {}))}</pre>
   <h4>골든 구성 근거</h4><pre>{html.escape(pretty_json(gold.get('gold_provenance')))}</pre>
   {gold_review_html}{gold_caveat_html}
  </article>
  <article class="actual"><h3>(실제)</h3>{actual_panel}</article>
 </div>
 <div class="judgment"><h3>판정 이유</h3><p><span class="badge {css_verdict}">{html.escape(VERDICT_KO[verdict])}</span>{confidence_html}</p>{manual_html}<pre>{rationale}</pre>
  <ul>{detail_list_html('누락 핵심 사실', judge.get('core_facts_missing'))}{detail_list_html('모순', judge.get('contradictions'))}{detail_list_html('근거 없는 중요 주장', judge.get('unsupported_material_claims'))}{detail_list_html('실패 코드', judge.get('failure_codes'))}</ul>
 </div>
</details>"""
        )

    return f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PaiM 실제 사용자형 160문항 평가 보고서</title>
<style>
:root{{--bg:#f3f5f8;--paper:#fff;--ink:#17202d;--muted:#667085;--line:#d9dee7;--pass:#16794c;--partial:#a76608;--fail:#b73535;--unjudged:#6d7582;--accent:#315be8}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Noto Sans KR",sans-serif;line-height:1.55}}main{{max-width:1540px;margin:auto;padding:28px}}header,section,.item{{background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:0 3px 18px #17243a0b}}header,section{{padding:22px;margin-bottom:16px}}h1{{margin:0 0 8px}}h2,h3{{margin-top:0}}h4{{margin:16px 0 5px;color:var(--muted)}}.muted,.meta{{color:var(--muted)}}.callout{{border-left:5px solid var(--accent)}}.callout.warning{{border-left-color:var(--partial)}}.scores{{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:10px;margin-top:18px}}.score{{border:1px solid var(--line);border-radius:10px;padding:13px}}.score b{{display:block;font-size:22px;margin-top:3px}}.table-wrap{{overflow:auto}}table{{width:100%;border-collapse:collapse}}th,td{{padding:9px 11px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}}code{{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent)}}.item{{margin:12px 0;overflow:hidden}}.item.pass{{border-left:5px solid var(--pass)}}.item.partial{{border-left:5px solid var(--partial)}}.item.fail{{border-left:5px solid var(--fail)}}.item.unjudged{{border-left:5px solid var(--unjudged)}}summary{{display:grid;grid-template-columns:auto auto 1fr auto;gap:10px;align-items:center;padding:15px;cursor:pointer}}.family{{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}}.question{{min-width:0}}.badge{{display:inline-block;color:#fff;border-radius:99px;padding:3px 8px;font-size:12px;margin:2px}}.badge.pass{{background:var(--pass)}}.badge.partial{{background:var(--partial)}}.badge.fail{{background:var(--fail)}}.badge.unjudged,.badge.na{{background:var(--unjudged)}}.compare{{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}}article{{padding:18px;min-width:0}}article+article{{border-left:1px solid var(--line)}}pre{{white-space:pre-wrap;word-break:break-word;background:#f7f8fa;border:1px solid var(--line);padding:12px;border-radius:8px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}}.judgment{{padding:17px 18px;border-top:1px solid var(--line);background:#fffdf7}}.judgment h3{{margin-bottom:7px}}.missing,.error{{color:var(--fail)}}
@media(max-width:1000px){{main{{padding:14px}}.scores{{grid-template-columns:1fr 1fr}}.compare{{grid-template-columns:1fr}}article+article{{border-left:0;border-top:1px solid var(--line)}}summary{{grid-template-columns:auto auto 1fr}}summary>.badge{{display:none}}}}
</style></head><body><main>
<header><h1>PaiM 실제 사용자형 160문항 평가 보고서</h1><p class="muted">골든 정답·출처와 실제 답변·출처, 기대/실제 도구, 최종 판정 근거를 문항별로 직접 비교합니다.</p><p class="meta">데이터셋 {html.escape(str(golden.get('dataset_id', 'unknown')))} · 원문 기준 {html.escape(str(golden.get('source_commit', 'unknown')))} · 실제 결과 {overall['actual_results']}/{overall['total']} · Judge {overall['judged']}/{overall['total']}</p>
<div class="scores"><div class="score"><span>엄격 PASS</span><b>{verdicts['PASS']}/{overall['total']} · {percent_text(overall['strict_pass_rate'])}</b></div><div class="score"><span>PASS/PARTIAL/FAIL</span><b>{verdicts['PASS']}/{verdicts['PARTIAL']}/{verdicts['FAIL']}</b></div><div class="score"><span>API 성공</span><b>{overall['api_success']['passed']}/{overall['total']}</b></div><div class="score"><span>기대 도구 정확 일치</span><b>{html.escape(tool_metric_text(overall['expected_tools_exact']))}</b></div><div class="score"><span>필수 도구 포함</span><b>{html.escape(tool_metric_text(overall['expected_tools_required_coverage']))}</b></div><div class="score"><span>지연시간</span><b>{html.escape(latency_text(overall['latency_ms']))}</b></div></div></header>
<section class="callout warning"><strong>골든 구성 한계:</strong> {html.escape(GOLDEN_LIMITATION)}<p class="meta">엄격 PASS의 분모는 전체 골든 문항입니다. 실행·판정 누락은 PASS로 계산하지 않습니다. 기대 도구 정확 일치는 두 도구 집합이 같은 경우이고, 필수 도구 포함은 기대 집합이 실제 집합의 부분집합인 경우입니다.</p></section>
{input_warning}
{diagnostics_html(summary.get('diagnostics'))}
{group_table_html('코퍼스별', group_records(records, 'corpus'))}
{group_table_html('질문 family별', group_records(records, 'family'))}
{failure_section}
<section><h2>문항별 정답·실제 비교</h2><p class="muted">문항을 열면 (정답)과 (실제)를 나란히 확인할 수 있습니다. PARTIAL·FAIL·미판정 문항은 기본으로 펼쳐집니다.</p></section>
{''.join(cards)}
</main></body></html>"""


CSV_FIELDS = [
    "id",
    "corpus",
    "family",
    "question",
    "reference_answer",
    "gold_sources",
    "gold_provenance",
    "answer_contract",
    "expected_tools",
    "http_status",
    "api_success",
    "latency_ms",
    "actual_answer",
    "actual_sources",
    "actual_tools",
    "expected_tools_exact",
    "required_tools_covered",
    "answer_verdict",
    "confidence",
    "core_facts_missing",
    "contradictions",
    "unsupported_material_claims",
    "failure_codes",
    "rationale",
    "error",
]


def csv_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def bool_csv(value: bool | None) -> str:
    return "" if value is None else "true" if value else "false"


def build_csv_rows(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for record in records:
        gold = record["golden"]
        actual = record["actual"] or {}
        judge = judgment_body(record["judgment"])
        rows.append(
            {
                "id": row_id(gold),
                "corpus": gold.get("corpus"),
                "family": gold.get("family"),
                "question": gold.get("question"),
                "reference_answer": gold.get("reference_answer"),
                "gold_sources": csv_json(source_list(gold.get("gold_sources"))),
                "gold_provenance": csv_json(gold.get("gold_provenance")),
                "answer_contract": csv_json(gold.get("answer_contract")),
                "expected_tools": csv_json(record["expected_tools"]),
                "http_status": actual.get("http_status", ""),
                "api_success": "true" if api_success(record["actual"]) else "false",
                "latency_ms": actual.get("latency_ms", ""),
                "actual_answer": actual.get("answer", ""),
                "actual_sources": csv_json(source_list(actual.get("sources"))),
                "actual_tools": csv_json(record["actual_tools"]),
                "expected_tools_exact": bool_csv(record["tools_exact"]),
                "required_tools_covered": bool_csv(
                    record["required_tools_covered"]
                ),
                "answer_verdict": record["verdict"] or "",
                "confidence": judge.get("confidence", ""),
                "core_facts_missing": csv_json(
                    string_list(judge.get("core_facts_missing"))
                ),
                "contradictions": csv_json(
                    string_list(judge.get("contradictions"))
                ),
                "unsupported_material_claims": csv_json(
                    string_list(judge.get("unsupported_material_claims"))
                ),
                "failure_codes": csv_json(
                    string_list(judge.get("failure_codes"))
                ),
                "rationale": judge.get("rationale", ""),
                "error": actual.get("error", ""),
            }
        )
    return rows


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    args = parse_args()
    golden = load_json(args.golden)
    golden_items = validate_golden(golden)
    actual_rows = load_jsonl(args.actual)
    judgment_rows = load_jsonl([args.judgments])
    records, extras = build_records(golden_items, actual_rows, judgment_rows)
    summary = build_summary(golden, records, extras)
    if args.diagnostics:
        summary["diagnostics"] = load_json(args.diagnostics)

    for path in (
        args.output_html,
        args.output_md,
        args.output_csv,
        args.summary_json,
    ):
        path.parent.mkdir(parents=True, exist_ok=True)

    args.output_md.write_text(
        clean_markdown(build_markdown(golden, records, extras, summary)),
        encoding="utf-8",
    )
    args.output_html.write_text(
        build_html(golden, records, extras, summary), encoding="utf-8"
    )
    write_csv(args.output_csv, build_csv_rows(records))
    args.summary_json.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True, default=str)
        + "\n",
        encoding="utf-8",
    )

    print(args.output_html)
    print(args.output_md)
    print(args.output_csv)
    print(args.summary_json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
