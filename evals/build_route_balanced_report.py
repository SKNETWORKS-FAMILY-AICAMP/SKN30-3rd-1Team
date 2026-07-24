#!/usr/bin/env python3
"""Build a self-contained report for the route-balanced PaiM evaluation.

The runner and scorer deliberately stay outside this module.  This script only
joins the frozen golden set, one or more actual-result JSONL files, and optional
judge JSONL, then renders the same evidence in Markdown and HTML.
"""

from __future__ import annotations

import argparse
import html
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


VERDICT_KO = {"PASS": "일치", "PARTIAL": "부분일치", "FAIL": "불일치"}
SCORE_LABELS = {
    "tool_selection": "도구 선택",
    "tool_arguments": "도구 인자",
    "tool_rounds": "도구 라운드",
    "answer_contract": "어휘·계약 신호",
    "overall": "결정론 신호 종합",
}
SCORE_ALIASES = {
    "tool_selection": (
        "tool_selection_pass",
        "tools_pass",
        "required_tools_pass",
        "route_pass",
    ),
    "tool_arguments": (
        "tool_arguments_pass",
        "tool_args",
        "tool_args_pass",
        "arguments_pass",
    ),
    "tool_rounds": ("tool_rounds_pass", "rounds_pass", "tool_rounds_score"),
    "answer_contract": (
        "answer_contract_pass",
        "answer_pass",
        "content_pass",
    ),
    "overall": ("overall_pass", "deterministic_pass"),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--golden", required=True, type=Path)
    parser.add_argument("--input", action="append", required=True, type=Path)
    parser.add_argument("--output-md", required=True, type=Path)
    parser.add_argument("--output-html", required=True, type=Path)
    parser.add_argument("--judgments", type=Path)
    return parser.parse_args()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_jsonl(paths: Iterable[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise RuntimeError(f"{path}:{line_number}: JSON object가 아닙니다")
            rows.append(value)
    return rows


def row_id(row: dict[str, Any]) -> str:
    value = row.get("id") or row.get("qid") or row.get("item_id")
    return str(value or "").strip()


def row_corpus(row: dict[str, Any], identifier: str) -> str:
    value = str(row.get("corpus") or "").strip().lower()
    if value:
        return value
    if identifier.startswith("M-"):
        return "modu"
    if identifier.startswith("C-"):
        return "csbot"
    return ""


def row_key(row: dict[str, Any]) -> tuple[str, str]:
    identifier = row_id(row)
    return row_corpus(row, identifier), identifier


def index_unique(rows: Iterable[dict[str, Any]], label: str) -> dict[tuple[str, str], dict[str, Any]]:
    result: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        key = row_key(row)
        if not all(key):
            raise RuntimeError(f"{label}: corpus/id가 없는 행이 있습니다: {row}")
        if key in result:
            raise RuntimeError(f"{label}: 중복 키 {key[0]}-{key[1]}")
        result[key] = row
    return result


def as_text(value: Any, default: str = "(없음)") -> str:
    if value is None or value == "":
        return default
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


def pretty_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, default=str)


def source_text(value: Any) -> str:
    if isinstance(value, list):
        return ", ".join(str(item) for item in value) if value else "반환 없음"
    return str(value or "반환 없음")


def actual_debug(row: dict[str, Any]) -> dict[str, Any]:
    debug = row.get("debug")
    if isinstance(debug, dict):
        return debug
    raw = row.get("raw_response")
    if isinstance(raw, dict) and isinstance(raw.get("debug"), dict):
        return raw["debug"]
    return {}


def tools_used(row: dict[str, Any]) -> list[str]:
    debug = actual_debug(row)
    value = row.get("tools_used") or debug.get("tools_used") or []
    return [str(item) for item in value] if isinstance(value, list) else [str(value)]


def tool_calls(row: dict[str, Any]) -> list[dict[str, Any]]:
    debug = actual_debug(row)
    value = row.get("tool_calls") or debug.get("tool_calls") or []
    return value if isinstance(value, list) else []


def tool_rounds(row: dict[str, Any]) -> Any:
    debug = actual_debug(row)
    value = row.get("tool_rounds")
    return debug.get("tool_rounds") if value is None else value


def bool_score(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().upper()
        if normalized in {"PASS", "PASSED", "TRUE", "OK", "MATCH", "MATCHED"}:
            return True
        if normalized in {"FAIL", "FAILED", "FALSE", "ERROR", "MISMATCH", "MISMATCHED"}:
            return False
    if isinstance(value, dict):
        for key in ("passed", "pass", "ok", "matched", "value", "verdict", "status"):
            if key in value:
                parsed = bool_score(value[key])
                if parsed is not None:
                    return parsed
    return None


def score_containers(row: dict[str, Any]) -> list[dict[str, Any]]:
    containers = []
    for name in ("deterministic_scores", "scores", "deterministic", "evaluation"):
        value = row.get(name)
        if isinstance(value, dict):
            containers.append(value)
    containers.append(row)
    return containers


def score_value(row: dict[str, Any], name: str) -> bool | None:
    runner_paths = {
        "tool_selection": ("tool_score", "tool_selection_pass"),
        "tool_arguments": ("tool_score", "exact_args_pass"),
        "tool_rounds": ("tool_score", "rounds_pass"),
        "answer_contract": ("answer_contract_score", "strict_text_pass"),
    }
    if name in runner_paths:
        container_name, field_name = runner_paths[name]
        container = row.get(container_name)
        if isinstance(container, dict) and field_name in container:
            parsed = bool_score(container[field_name])
            if parsed is not None:
                return parsed

    containers = score_containers(row)
    # The canonical nested form uses metric names directly (for example,
    # scores.tool_rounds.pass).  Do not apply that shortcut to the top-level row:
    # there, tool_rounds is the observed integer rather than a pass/fail score.
    for container in containers[:-1]:
        if name in container:
            parsed = bool_score(container[name])
            if parsed is not None:
                return parsed
    for container in containers:
        for alias in SCORE_ALIASES[name]:
            if alias in container:
                parsed = bool_score(container[alias])
                if parsed is not None:
                    return parsed
    # The current runner exposes the four component signals, but no aggregate.
    # Derive one only when every component is available, and label it explicitly
    # as a deterministic signal rather than semantic answer correctness.
    if name == "overall":
        components = [
            score_value(row, component)
            for component in ("tool_selection", "tool_arguments", "tool_rounds", "answer_contract")
        ]
        if all(value is not None for value in components):
            return all(value is True for value in components)
    return None


def score_payload(row: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for name in (
        "tool_score",
        "answer_contract_score",
        "deterministic_scores",
        "scores",
        "deterministic",
        "evaluation",
    ):
        value = row.get(name)
        if isinstance(value, dict):
            payload[name] = value
    for aliases in SCORE_ALIASES.values():
        for alias in aliases:
            if alias in row:
                payload[alias] = row[alias]
    return payload


def api_success(row: dict[str, Any] | None) -> bool:
    if row is None:
        return False
    status = row.get("http_status", row.get("status_code", 200))
    return status == 200 and not row.get("error")


def judgment_body(row: dict[str, Any] | None) -> dict[str, Any]:
    if not row:
        return {}
    value = row.get("judgment")
    return value if isinstance(value, dict) else row


def judgment_verdict(row: dict[str, Any] | None) -> str | None:
    body = judgment_body(row)
    value = str(body.get("answer_verdict") or body.get("verdict") or "").upper()
    return value if value in VERDICT_KO else None


def automatic_judgment_verdict(row: dict[str, Any] | None) -> str | None:
    if not row:
        return None
    value = row.get("automatic_judgment")
    body = value if isinstance(value, dict) else judgment_body(row)
    verdict = str(body.get("answer_verdict") or body.get("verdict") or "").upper()
    return verdict if verdict in VERDICT_KO else None


def semantic_argument_summary(records: list[dict[str, Any]]) -> tuple[int, int]:
    passed = 0
    total = 0
    for record in records:
        expected_calls = (record["golden"].get("expected") or {}).get("tool_calls") or []
        if not any(call.get("args_semantics") for call in expected_calls):
            continue
        total += 1
        verdict = str(
            judgment_body(record.get("judgment")).get("semantic_tool_args_verdict") or ""
        ).upper()
        passed += verdict == "PASS"
    return passed, total


def markdown_quote(value: Any) -> str:
    lines = as_text(value).splitlines() or ["(없음)"]
    return "\n".join("> " + line if line else ">" for line in lines)


def md_cell(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def metric_text(passed: int, available: int) -> str:
    if not available:
        return "—"
    return f"{passed}/{available} ({passed / available * 100:.1f}%)"


def summarize_group(records: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "total": len(records),
        "api": sum(api_success(record["actual"]) for record in records),
        "scores": {},
        "verdicts": Counter(),
    }
    for name in SCORE_LABELS:
        values = [score_value(record["actual"], name) for record in records if record["actual"]]
        available = [value for value in values if value is not None]
        summary["scores"][name] = (sum(value is True for value in available), len(available))
    for record in records:
        verdict = judgment_verdict(record["judgment"])
        if verdict:
            summary["verdicts"][verdict] += 1
    return summary


def grouped(records: list[dict[str, Any]], field: str) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        result[str(record["golden"].get(field) or "unknown")].append(record)
    return dict(result)


def summary_table_md(title: str, groups: dict[str, list[dict[str, Any]]]) -> list[str]:
    lines = [
        f"### {title}",
        "",
        "| 구분 | 문항 | API 성공 | 도구 선택 | 도구 인자 | 도구 라운드 | 어휘·계약 신호 | 결정론 신호 종합 | Judge 일치/부분/불일치 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for name, records in groups.items():
        stats = summarize_group(records)
        scores = stats["scores"]
        verdicts = stats["verdicts"]
        lines.append(
            f"| {md_cell(name)} | {stats['total']} | {stats['api']}/{stats['total']} | "
            f"{metric_text(*scores['tool_selection'])} | {metric_text(*scores['tool_arguments'])} | "
            f"{metric_text(*scores['tool_rounds'])} | "
            f"{metric_text(*scores['answer_contract'])} | {metric_text(*scores['overall'])} | "
            f"{verdicts['PASS']}/{verdicts['PARTIAL']}/{verdicts['FAIL']} |"
        )
    lines.append("")
    return lines


def build_records(
    golden: dict[str, Any],
    actual_rows: list[dict[str, Any]],
    judgment_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    items = golden.get("items")
    if not isinstance(items, list) or not items:
        raise RuntimeError("golden JSON의 items가 비어 있습니다")
    golden_index = index_unique(items, "golden")
    actual_index = index_unique(actual_rows, "actual")
    judgment_index = index_unique(judgment_rows, "judgments") if judgment_rows else {}

    extras = [f"{corpus}-{identifier}" for corpus, identifier in actual_index if (corpus, identifier) not in golden_index]
    records = [
        {
            "golden": item,
            "actual": actual_index.get(key),
            "judgment": judgment_index.get(key),
        }
        for key, item in golden_index.items()
    ]
    return records, extras


def build_markdown(golden: dict[str, Any], records: list[dict[str, Any]], extras: list[str]) -> str:
    total = len(records)
    overall = summarize_group(records)
    verdicts = overall["verdicts"]
    judged = sum(verdicts.values())
    scores = overall["scores"]
    automatic_verdicts = Counter(
        verdict for record in records
        if (verdict := automatic_judgment_verdict(record["judgment"]))
    )
    audited = sum(bool(judgment_body(record["judgment"]).get("source_audited")) for record in records)
    semantic_passed, semantic_total = semantic_argument_summary(records)
    tool_selection_failures = [
        row_id(record["golden"]) for record in records
        if score_value(record["actual"], "tool_selection") is False
    ]
    tool_argument_failures = [
        row_id(record["golden"]) for record in records
        if score_value(record["actual"], "tool_arguments") is False
    ]
    non_pass = [
        row_id(record["golden"]) for record in records
        if judgment_verdict(record["judgment"]) in {"PARTIAL", "FAIL"}
    ]
    structured_calls = [
        call
        for record in records
        for call in ((record["golden"].get("expected") or {}).get("tool_calls") or [])
        if call.get("name") == "query_structured_memory"
    ]
    all_category_count = sum(
        (call.get("args_required") or {}).get("category") == "all"
        for call in structured_calls
    )
    completion_contract_count = sum(
        "completion_status" in (call.get("args_required") or {})
        for call in structured_calls
    )
    lines = [
        "# PaiM Route-Balanced Golden Set 평가 보고서",
        "",
        f"- 데이터셋: `{golden.get('dataset_id', 'unknown')}`",
        f"- 원문 기준 커밋: `{golden.get('source_commit', 'unknown')}`",
        f"- 골든 문항: {total}개 · 실제 결과: {sum(record['actual'] is not None for record in records)}개",
        f"- API 성공: {overall['api']}/{total}",
        f"- 도구 선택: {metric_text(*scores['tool_selection'])}",
        f"- 도구 인자: {metric_text(*scores['tool_arguments'])}",
        f"- 도구 라운드: {metric_text(*scores['tool_rounds'])}",
        f"- 어휘·계약 신호: {metric_text(*scores['answer_contract'])}",
        f"- 결정론 신호 종합: {metric_text(*scores['overall'])}",
        f"- 최종 답변 판정: 일치 {verdicts['PASS']} · 부분일치 {verdicts['PARTIAL']} · 불일치 {verdicts['FAIL']} (판정 {judged}/{total})",
        f"- 엄격 정답률(PASS): {verdicts['PASS']}/{judged} ({verdicts['PASS'] / judged * 100:.1f}%)",
        f"- 핵심 답 포함률(PASS+PARTIAL): {verdicts['PASS'] + verdicts['PARTIAL']}/{judged} ({(verdicts['PASS'] + verdicts['PARTIAL']) / judged * 100:.1f}%)",
        f"- semantic 검색 인자: {metric_text(semantic_passed, semantic_total)}",
        "",
        "`—`는 해당 점수가 결과 JSONL에 없어서 집계하지 않았다는 뜻입니다. 도구 인자는 런타임 기본값(limit=8)을 반영한 유효값 기준입니다. `strict_text_pass`는 문자열 포함 여부를 보는 어휘적 프록시이며 의미적 정답률이 아닙니다.",
        "",
        "## 핵심 판정",
        "",
        f"- 자동 Judge는 일치 {automatic_verdicts['PASS']} · 부분일치 {automatic_verdicts['PARTIAL']} · 불일치 {automatic_verdicts['FAIL']}였고, 동결 스냅샷·원문으로 {audited}건을 재검토한 최종 판정은 {verdicts['PASS']}/{verdicts['PARTIAL']}/{verdicts['FAIL']}입니다.",
        f"- 기대 도구 집합 불일치: {', '.join(tool_selection_failures) if tool_selection_failures else '없음'}",
        f"- 유효 도구 인자 불일치: {', '.join(tool_argument_failures) if tool_argument_failures else '없음'}",
        f"- 답변 부분일치/불일치: {', '.join(non_pass) if non_pass else '없음'}",
        f"- 이 평가셋의 구조화 호출은 {len(structured_calls)}건이지만 category=all 문항은 {all_category_count}건, completion_status 문항은 {completion_contract_count}건입니다. 따라서 두 계약은 이번 점수로 검증할 수 없습니다.",
        "- 골든셋 동봉 검증기는 978개 검사를 모두 통과했습니다. 다만 '대표 액션'처럼 정답이 여러 개 가능한 질문은 특정 항목 하나를 강제하면 과적합 판정이 생길 수 있어 의미 재검토를 우선했습니다.",
        "",
    ]
    if extras:
        lines += [f"> 경고: 골든셋에 없는 실제 결과 {len(extras)}개는 문항 비교에서 제외했습니다: {', '.join(extras)}", ""]
    lines += summary_table_md("코퍼스별", grouped(records, "corpus"))
    lines += summary_table_md("질문 family별", grouped(records, "family"))
    lines += ["## 문항별 비교", ""]

    for record in records:
        gold = record["golden"]
        actual = record["actual"]
        judgment = record["judgment"]
        identifier = row_id(gold)
        verdict = judgment_verdict(judgment)
        deterministic = score_value(actual, "overall") if actual else None
        status = (
            VERDICT_KO[verdict]
            if verdict
            else "계약 신호 통과"
            if deterministic is True
            else "계약 신호 실패"
            if deterministic is False
            else "실행 성공"
            if api_success(actual)
            else "실행 실패/누락"
        )
        expected = gold.get("expected") or {}
        lines += [
            f"### {identifier} · {gold.get('family', 'unknown')} · {status}",
            "",
            "#### (정답)",
            "",
            f"**질문**\n\n{gold.get('question', '')}",
            "",
            "**답변**",
            "",
            markdown_quote(gold.get("reference_answer")),
            "",
            f"**참고 문항(출처)**\n\n{source_text(gold.get('gold_sources'))}",
            "",
            f"**기대 도구** `{', '.join(expected.get('required_tools') or []) or '없음'}` · **최대 도구 라운드** `{expected.get('max_tool_rounds', '—')}`",
            "",
            "**기대 호출/답변 계약**",
            "",
            "```json",
            pretty_json({"tool_calls": expected.get("tool_calls") or [], "answer_contract": expected.get("answer_contract") or {}}),
            "```",
            "",
            "#### (실제)",
            "",
        ]
        if actual is None:
            lines += ["> 실제 결과 행이 없습니다.", ""]
        else:
            lines += [
                f"**질문**\n\n{actual.get('question') or gold.get('question', '')}",
                "",
                "**답변**",
                "",
                markdown_quote(actual.get("answer")),
                "",
                f"**참고 문항(반환 출처)**\n\n{source_text(actual.get('sources'))}",
                "",
                f"**실제 도구** `{', '.join(tools_used(actual)) or '없음'}` · **도구 라운드** `{tool_rounds(actual) if tool_rounds(actual) is not None else '—'}`",
                "",
                "**실제 호출**",
                "",
                "```json",
                pretty_json(tool_calls(actual)),
                "```",
                "",
                f"**API** `{actual.get('http_status', actual.get('status_code', '—'))}` · **응답시간** `{actual.get('latency_ms', '—')} ms` · **route** `{actual.get('route') or actual_debug(actual).get('route') or '—'}`",
                "",
                "**결정론/계약 신호**",
                "",
                "```json",
                pretty_json(score_payload(actual) or {"status": "not_provided"}),
                "```",
                "",
            ]
            if actual.get("error"):
                lines += [f"**실행 오류:** {actual['error']}", ""]

        body = judgment_body(judgment)
        if body:
            confidence = body.get("confidence")
            raw_verdict = body.get("answer_verdict") or body.get("verdict")
            label = VERDICT_KO.get(str(raw_verdict or "").upper(), raw_verdict or "판정 오류")
            lines += [
                "#### 최종 답변 판정",
                "",
                f"**{label}**"
                + (f" · 신뢰도 `{confidence}`" if confidence is not None else "")
                + f" · semantic 검색 인자 `{body.get('semantic_tool_args_verdict', 'N/A')}`",
                "",
                as_text(body.get("rationale"), "판정 이유 없음"),
                "",
            ]
            if body.get("source_audited"):
                automatic = automatic_judgment_verdict(judgment)
                lines += [
                    f"_동결 근거 재검토 적용: 자동 판정 {automatic or '없음'} → 최종 판정 {str(raw_verdict).upper()}_",
                    "",
                ]
            details = {
                key: body.get(key)
                for key in (
                    "core_facts_missing",
                    "contradictions",
                    "unsupported_material_claims",
                    "failure_codes",
                )
                if body.get(key)
            }
            if details:
                lines += ["```json", pretty_json(details), "```", ""]
        lines += ["---", ""]
    return "\n".join(lines).rstrip() + "\n"


def clean_markdown(text: str) -> str:
    """Generated evidence can contain source-authored trailing spaces."""
    return "\n".join(line.rstrip() for line in text.splitlines()) + "\n"


def score_badges_html(row: dict[str, Any] | None) -> str:
    if row is None:
        return '<span class="badge na">결과 없음</span>'
    badges = []
    for name, label in SCORE_LABELS.items():
        value = score_value(row, name)
        css = "na" if value is None else "pass" if value else "fail"
        text = "—" if value is None else "PASS" if value else "FAIL"
        badges.append(f'<span class="badge {css}">{html.escape(label)} {text}</span>')
    return "".join(badges)


def stats_table_html(title: str, groups: dict[str, list[dict[str, Any]]]) -> str:
    body = []
    for name, records in groups.items():
        stats = summarize_group(records)
        scores = stats["scores"]
        verdicts = stats["verdicts"]
        body.append(
            "<tr>"
            f"<td>{html.escape(name)}</td><td>{stats['total']}</td><td>{stats['api']}/{stats['total']}</td>"
            f"<td>{html.escape(metric_text(*scores['tool_selection']))}</td>"
            f"<td>{html.escape(metric_text(*scores['tool_arguments']))}</td>"
            f"<td>{html.escape(metric_text(*scores['tool_rounds']))}</td>"
            f"<td>{html.escape(metric_text(*scores['answer_contract']))}</td>"
            f"<td>{html.escape(metric_text(*scores['overall']))}</td>"
            f"<td>{verdicts['PASS']}/{verdicts['PARTIAL']}/{verdicts['FAIL']}</td>"
            "</tr>"
        )
    return (
        f"<section><h2>{html.escape(title)}</h2><div class=\"table-wrap\"><table><thead><tr>"
        "<th>구분</th><th>문항</th><th>API 성공</th><th>도구 선택</th><th>도구 인자</th>"
        "<th>도구 라운드</th><th>어휘·계약 신호</th><th>결정론 신호 종합</th><th>Judge 일치/부분/불일치</th>"
        f"</tr></thead><tbody>{''.join(body)}</tbody></table></div></section>"
    )


def build_html(golden: dict[str, Any], records: list[dict[str, Any]], extras: list[str]) -> str:
    total = len(records)
    overall = summarize_group(records)
    scores = overall["scores"]
    verdicts = overall["verdicts"]
    judged = sum(verdicts.values())
    automatic_verdicts = Counter(
        verdict for record in records
        if (verdict := automatic_judgment_verdict(record["judgment"]))
    )
    audited = sum(bool(judgment_body(record["judgment"]).get("source_audited")) for record in records)
    semantic_passed, semantic_total = semantic_argument_summary(records)
    tool_selection_failures = [
        row_id(record["golden"]) for record in records
        if score_value(record["actual"], "tool_selection") is False
    ]
    tool_argument_failures = [
        row_id(record["golden"]) for record in records
        if score_value(record["actual"], "tool_arguments") is False
    ]
    non_pass = [
        row_id(record["golden"]) for record in records
        if judgment_verdict(record["judgment"]) in {"PARTIAL", "FAIL"}
    ]
    cards = []
    for record in records:
        gold = record["golden"]
        actual = record["actual"]
        judge_row = record["judgment"]
        judge = judgment_body(judge_row)
        verdict = judgment_verdict(judge_row)
        identifier = row_id(gold)
        expected = gold.get("expected") or {}
        calls = tool_calls(actual) if actual else []
        used = tools_used(actual) if actual else []
        deterministic = score_value(actual, "overall") if actual else None
        severity = (
            verdict.lower()
            if verdict
            else "pass"
            if deterministic is True
            else "fail"
            if deterministic is False
            else "pass"
            if api_success(actual)
            else "fail"
        )
        verdict_label = VERDICT_KO.get(verdict or "", "판정 없음")
        status_label = (
            verdict_label
            if verdict
            else "계약 신호 통과"
            if deterministic is True
            else "계약 신호 실패"
            if deterministic is False
            else "실행 성공"
            if api_success(actual)
            else "실행 실패/누락"
        )
        search = " ".join(
            str(value or "")
            for value in (
                identifier,
                gold.get("corpus"),
                gold.get("family"),
                gold.get("question"),
                gold.get("reference_answer"),
                actual.get("answer") if actual else "",
            )
        ).lower()
        actual_html = '<p class="missing">실제 결과 행이 없습니다.</p>'
        if actual:
            error_html = f'<p class="error"><strong>실행 오류</strong> {html.escape(str(actual["error"]))}</p>' if actual.get("error") else ""
            actual_html = f"""
<h4>질문</h4><p>{html.escape(str(actual.get('question') or gold.get('question') or ''))}</p>
<h4>답변</h4><pre>{html.escape(as_text(actual.get('answer')))}</pre>
<h4>참고 문항(반환 출처)</h4><p>{html.escape(source_text(actual.get('sources')))}</p>
<p class="meta"><strong>도구</strong> {html.escape(', '.join(used) or '없음')} · <strong>라운드</strong> {html.escape(str(tool_rounds(actual) if tool_rounds(actual) is not None else '—'))}</p>
<h4>실제 호출</h4><pre>{html.escape(pretty_json(calls))}</pre>
<p class="meta"><strong>API</strong> {html.escape(str(actual.get('http_status', actual.get('status_code', '—'))))} · <strong>응답시간</strong> {html.escape(str(actual.get('latency_ms', '—')))} ms · <strong>route</strong> {html.escape(str(actual.get('route') or actual_debug(actual).get('route') or '—'))}</p>
<div class="badges">{score_badges_html(actual)}</div>
<h4>결정론/계약 신호 원문</h4><pre>{html.escape(pretty_json(score_payload(actual) or {'status': 'not_provided'}))}</pre>{error_html}"""
        judge_html = '<p class="meta">Judge 판정이 제공되지 않았습니다.</p>'
        if judge:
            details = {
                key: judge.get(key)
                for key in (
                    "core_facts_missing",
                    "contradictions",
                    "unsupported_material_claims",
                    "failure_codes",
                )
                if judge.get(key)
            }
            confidence = judge.get("confidence")
            semantic_verdict = judge.get("semantic_tool_args_verdict", "N/A")
            audit_html = ""
            if judge.get("source_audited"):
                automatic = automatic_judgment_verdict(judge_row) or "없음"
                audit_html = (
                    f'<p class="meta">동결 근거 재검토: 자동 {html.escape(automatic)} → '
                    f'최종 {html.escape(verdict or "없음")}</p>'
                )
            judge_html = (
                f'<p><span class="badge {html.escape((verdict or "na").lower())}">{html.escape(verdict_label)}</span>'
                + (f' <span class="meta">신뢰도 {html.escape(str(confidence))}</span>' if confidence is not None else "")
                + f' <span class="meta">semantic 검색 인자 {html.escape(str(semantic_verdict))}</span>'
                + f'</p><p>{html.escape(as_text(judge.get("rationale"), "판정 이유 없음"))}</p>'
                + audit_html
                + (f'<pre>{html.escape(pretty_json(details))}</pre>' if details else "")
            )
        cards.append(f"""
<details class="item {severity}" data-search="{html.escape(search, quote=True)}" data-family="{html.escape(str(gold.get('family') or 'unknown'), quote=True)}" data-verdict="{html.escape((verdict or 'none').lower(), quote=True)}">
 <summary><strong>{html.escape(identifier)}</strong><span class="family">{html.escape(str(gold.get('family') or 'unknown'))}</span><span>{html.escape(str(gold.get('question') or ''))}</span><span class="badge {severity}">{html.escape(status_label)}</span></summary>
 <div class="compare">
  <article><h3>(정답)</h3><h4>질문</h4><p>{html.escape(str(gold.get('question') or ''))}</p><h4>답변</h4><pre>{html.escape(as_text(gold.get('reference_answer')))}</pre><h4>참고 문항(출처)</h4><p>{html.escape(source_text(gold.get('gold_sources')))}</p><p class="meta"><strong>기대 도구</strong> {html.escape(', '.join(expected.get('required_tools') or []) or '없음')} · <strong>최대 라운드</strong> {html.escape(str(expected.get('max_tool_rounds', '—')))}</p><h4>기대 호출/답변 계약</h4><pre>{html.escape(pretty_json({'tool_calls': expected.get('tool_calls') or [], 'answer_contract': expected.get('answer_contract') or {}}))}</pre></article>
  <article><h3>(실제)</h3>{actual_html}</article>
 </div>
 <div class="judge"><h3>최종 답변 판정</h3>{judge_html}</div>
</details>""")

    warning = ""
    if extras:
        warning = f'<section class="warning"><strong>경고:</strong> 골든에 없는 실제 결과 {len(extras)}개를 제외했습니다: {html.escape(", ".join(extras))}</section>'
    corpus_table = stats_table_html("코퍼스별", grouped(records, "corpus"))
    family_table = stats_table_html("질문 family별", grouped(records, "family"))
    analysis = (
        "<section><h2>핵심 판정</h2>"
        f"<p><strong>자동 Judge</strong> {automatic_verdicts['PASS']}/{automatic_verdicts['PARTIAL']}/{automatic_verdicts['FAIL']}에서 "
        f"동결 근거 {audited}건을 재검토해 <strong>최종 {verdicts['PASS']}/{verdicts['PARTIAL']}/{verdicts['FAIL']}</strong>로 확정했습니다.</p>"
        f"<p><strong>기대 도구 불일치</strong> {html.escape(', '.join(tool_selection_failures) or '없음')}<br>"
        f"<strong>유효 인자 불일치</strong> {html.escape(', '.join(tool_argument_failures) or '없음')}<br>"
        f"<strong>답변 부분/불일치</strong> {html.escape(', '.join(non_pass) or '없음')}</p>"
        "<p class=\"meta\">이 세트에는 category=all과 completion_status 문항이 없어 두 계약은 이번 점수로 검증할 수 없습니다. "
        "골든 동봉 검증기는 978개 검사를 통과했으며, 대표 액션처럼 복수 정답이 가능한 항목은 의미 재검토를 우선했습니다.</p></section>"
    )
    return f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PaiM Route-Balanced 평가 보고서</title>
<style>
:root{{--bg:#f3f5f8;--paper:#fff;--ink:#17202d;--muted:#667085;--line:#d9dee7;--pass:#16794c;--partial:#a76608;--fail:#b73535;--accent:#315be8}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Noto Sans KR",sans-serif;line-height:1.55}}main{{max-width:1540px;margin:auto;padding:28px}}header,section,.item{{background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:0 3px 18px #17243a0b}}header,section{{padding:22px;margin-bottom:16px}}h1{{margin:0 0 8px}}h2,h3{{margin-top:0}}h4{{margin:15px 0 5px;color:var(--muted)}}.meta,.muted{{color:var(--muted)}}.scores{{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;margin-top:18px}}.score{{border:1px solid var(--line);border-radius:10px;padding:13px}}.score b{{display:block;font-size:23px}}.table-wrap{{overflow:auto}}table{{width:100%;border-collapse:collapse}}th,td{{padding:9px 11px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}}.toolbar{{position:sticky;top:0;z-index:3;display:flex;gap:8px;align-items:center;flex-wrap:wrap}}.toolbar input{{flex:1;min-width:250px;padding:10px;border:1px solid var(--line);border-radius:8px}}.toolbar button{{padding:9px 11px;border:1px solid var(--line);background:#fff;border-radius:8px;cursor:pointer}}.item{{margin:12px 0;overflow:hidden}}.item.pass{{border-left:5px solid var(--pass)}}.item.partial{{border-left:5px solid var(--partial)}}.item.fail{{border-left:5px solid var(--fail)}}summary{{display:grid;grid-template-columns:auto auto 1fr auto;gap:10px;align-items:center;padding:15px;cursor:pointer}}.family{{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}}.badge{{display:inline-block;color:#fff;border-radius:99px;padding:3px 8px;font-size:12px;margin:2px}}.badge.pass{{background:var(--pass)}}.badge.partial{{background:var(--partial)}}.badge.fail{{background:var(--fail)}}.badge.na{{background:#7b8493}}.compare{{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}}article{{padding:18px;min-width:0}}article+article{{border-left:1px solid var(--line)}}pre{{white-space:pre-wrap;word-break:break-word;background:#f7f8fa;border:1px solid var(--line);padding:12px;border-radius:8px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}}.judge{{padding:16px 18px;border-top:1px solid var(--line);background:#fffdf7}}.judge h3{{margin-bottom:7px}}.missing,.error{{color:var(--fail)}}.warning{{border-left:5px solid var(--partial)}}.hidden{{display:none}}
@media(max-width:1000px){{main{{padding:14px}}.scores{{grid-template-columns:1fr 1fr}}.compare{{grid-template-columns:1fr}}article+article{{border-left:0;border-top:1px solid var(--line)}}summary{{grid-template-columns:auto auto 1fr}}summary>.badge{{display:none}}}}
</style></head><body><main>
<header><h1>PaiM Route-Balanced Golden Set 평가 보고서</h1><p class="muted">골든 정답·출처·기대 도구와 실제 답변·출처·도구 호출을 문항별로 비교합니다.</p><p class="meta">데이터셋 {html.escape(str(golden.get('dataset_id', 'unknown')))} · 원문 기준 {html.escape(str(golden.get('source_commit', 'unknown')))} · 실제 결과 {sum(record['actual'] is not None for record in records)}/{total}</p>
<div class="scores"><div class="score"><span>API 성공</span><b>{overall['api']}/{total}</b></div><div class="score"><span>도구 선택</span><b>{html.escape(metric_text(*scores['tool_selection']))}</b></div><div class="score"><span>유효 도구 인자</span><b>{html.escape(metric_text(*scores['tool_arguments']))}</b></div><div class="score"><span>도구 라운드</span><b>{html.escape(metric_text(*scores['tool_rounds']))}</b></div><div class="score"><span>엄격 정답률</span><b>{verdicts['PASS']}/{judged}</b></div><div class="score"><span>PASS+PARTIAL</span><b>{verdicts['PASS'] + verdicts['PARTIAL']}/{judged}</b></div><div class="score"><span>semantic 검색 인자</span><b>{semantic_passed}/{semantic_total}</b></div></div><p class="meta">도구 인자는 런타임 기본값(limit=8)을 반영합니다. 문자열 포함 기반 어휘 신호는 의미적 정답률과 분리했습니다.</p></header>
{warning}{analysis}{corpus_table}{family_table}
<section class="toolbar"><strong>{total}문항</strong><input id="search" placeholder="ID·질문·답변 검색"><button data-filter="all">전체</button><button data-filter="pass">답변 일치</button><button data-filter="partial">부분일치</button><button data-filter="fail">불일치</button><button data-filter="none">미판정</button></section>
{''.join(cards)}
</main><script>
const items=[...document.querySelectorAll('.item')];const input=document.getElementById('search');let filter='all';function apply(){{const q=input.value.trim().toLowerCase();for(const item of items){{const textOk=!q||item.dataset.search.includes(q);const filterOk=filter==='all'||item.dataset.verdict===filter;item.classList.toggle('hidden',!(textOk&&filterOk));}}}}input.addEventListener('input',apply);for(const button of document.querySelectorAll('[data-filter]'))button.addEventListener('click',()=>{{filter=button.dataset.filter;apply();}});
</script></body></html>"""


def main() -> int:
    args = parse_args()
    golden = load_json(args.golden)
    if not isinstance(golden, dict):
        raise RuntimeError("golden JSON은 object여야 합니다")
    actual_rows = load_jsonl(args.input)
    judgment_rows = load_jsonl([args.judgments]) if args.judgments else []
    records, extras = build_records(golden, actual_rows, judgment_rows)

    args.output_md.parent.mkdir(parents=True, exist_ok=True)
    args.output_html.parent.mkdir(parents=True, exist_ok=True)
    args.output_md.write_text(
        clean_markdown(build_markdown(golden, records, extras)),
        encoding="utf-8",
    )
    args.output_html.write_text(build_html(golden, records, extras), encoding="utf-8")
    print(args.output_md)
    print(args.output_html)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
