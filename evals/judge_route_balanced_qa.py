#!/usr/bin/env python3
"""Independently judge route-balanced answers and semantic search arguments."""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel, Field


class RouteBalancedJudgment(BaseModel):
    answer_verdict: Literal["PASS", "PARTIAL", "FAIL"]
    semantic_tool_args_verdict: Literal["PASS", "FAIL", "N/A"]
    confidence: float = Field(ge=0, le=1)
    core_facts_required: list[str]
    core_facts_matched: list[str]
    core_facts_missing: list[str]
    contradictions: list[str]
    unsupported_material_claims: list[str]
    failure_codes: list[str]
    rationale: str


INSTRUCTIONS = """당신은 프로젝트 Q&A의 독립 평가자다. 질문, 검증된 골든 답변,
답변 계약, 실제 답변을 비교해 의미 기준으로 엄격히 채점한다. route/tool 점수와 답변
점수를 섞지 않는다.

answer_verdict:
- PASS: 질문이 요구한 핵심 사실과 관계를 모두 충족하고 중요한 오류나 날조가 없다.
- PARTIAL: 중심 결론은 맞지만 요청한 목록·수치·이유 중 일부가 빠졌거나 경미한 오류가 있다.
- FAIL: 핵심 결론·수치·담당 관계가 틀렸거나, 답할 수 있는데 기권했거나, 없는 값을 만들었다.
- "전부/모두" 목록 질문은 골든 답변의 전체 항목이 필요하다. 일부만 맞으면 PARTIAL이다.
- 표현이 달라도 의미가 같으면 인정한다. 단순 문자열 포함 여부로 판단하지 않는다.
- must_abstain 질문은 요청한 값이 기록에 없다고 명확히 말해야 한다. 골든이 함께 제시한
  범위 내 관련 사실을 덧붙이는 것은 허용한다.
- category count는 질문/answer_contract의 required_facts·required_terms에 명시된 경우에만
  필수로 본다. 참고용 category_counts가 있다는 이유만으로 강제하지 않는다.

semantic_tool_args_verdict:
- expected tool_calls에 args_semantics가 없으면 N/A다.
- 있으면 실제 search_project_evidence 호출의 query와 alternate_queries가 그 의미를
  보존하며 필요한 핵심 대상을 검색하도록 작성됐는지 본다.
- 관련 호출이 없거나 핵심 관계·수치 대상을 빠뜨렸으면 FAIL이다.

failure_codes는 해당되는 것만 다음 중 고른다:
MISSING_FACT, WRONG_FACT, RELATION_INVERTED, FALSE_ABSTAIN, FAILED_ABSTAIN,
UNSUPPORTED_CLAIM, IRRELEVANT, SEMANTIC_QUERY_MISS, API_ERROR.
PASS이고 semantic 인자도 PASS/N/A이면 빈 목록이다. 실제 답변에 없는 사실을 추정하지 않는다.
판정 이유는 한국어로 짧고 구체적으로 쓴다.
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", action="append", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", default="gpt-4.1")
    parser.add_argument("--max-attempts", type=int, default=3)
    return parser.parse_args()


def load_rows(paths: list[Path]) -> list[dict]:
    rows = []
    for path in paths:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    ids = [row["id"] for row in rows]
    if len(rows) != 40 or len(set(ids)) != 40:
        raise RuntimeError(f"expected 40 unique answer rows, got {len(rows)} rows/{len(set(ids))} ids")
    return rows


def main() -> int:
    args = parse_args()
    repo = Path(__file__).resolve().parents[1]
    load_dotenv(repo / ".env")
    client = OpenAI(timeout=180.0, max_retries=2)
    rows = load_rows(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")

    with temporary.open("w", encoding="utf-8") as handle:
        for index, row in enumerate(rows, start=1):
            expected_calls = row["expected"].get("tool_calls") or []
            actual_calls = (row.get("debug") or {}).get("tool_calls") or []
            prompt = json.dumps({
                "id": row["id"],
                "family": row["family"],
                "question": row["question"],
                "gold_reference_answer": row["reference_answer"],
                "answer_contract": row["expected"]["answer_contract"],
                "actual_answer": row.get("answer") or "",
                "api_status": row.get("http_status"),
                "expected_tool_calls": expected_calls,
                "actual_tool_calls": actual_calls,
            }, ensure_ascii=False, indent=2)

            judgment = None
            error = None
            attempts = 0
            while attempts < max(1, args.max_attempts):
                attempts += 1
                try:
                    response = client.responses.parse(
                        model=args.model,
                        instructions=INSTRUCTIONS,
                        input=prompt,
                        text_format=RouteBalancedJudgment,
                        temperature=0,
                        store=False,
                    )
                    judgment = response.output_parsed
                    if judgment is None:
                        raise RuntimeError("judge returned no parsed output")
                    break
                except Exception as exc:
                    error = f"{type(exc).__name__}: {exc}"
                    if attempts < args.max_attempts:
                        time.sleep(min(2 ** attempts, 8))

            has_semantic_contract = any(
                call.get("args_semantics") for call in expected_calls
            )
            if judgment is not None and not has_semantic_contract:
                judgment.semantic_tool_args_verdict = "N/A"

            record = {
                "id": row["id"],
                "corpus": row["corpus"],
                "family": row["family"],
                "judge_model": args.model,
                "judged_at": datetime.now(timezone.utc).isoformat(),
                "attempts": attempts,
                "error": error if judgment is None else None,
                "judgment": judgment.model_dump() if judgment is not None else None,
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            verdict = judgment.answer_verdict if judgment is not None else "ERROR"
            semantic = judgment.semantic_tool_args_verdict if judgment is not None else "ERROR"
            print(f"[{index:02d}/40] {row['id']} answer={verdict} semantic_args={semantic}", flush=True)

    temporary.replace(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
