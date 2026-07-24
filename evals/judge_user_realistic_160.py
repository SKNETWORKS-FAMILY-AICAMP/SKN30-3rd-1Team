#!/usr/bin/env python3
"""Independently judge answers for the source-grounded 160-question contract."""

from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel, Field


class Judgment(BaseModel):
    answer_verdict: Literal["PASS", "PARTIAL", "FAIL"]
    confidence: float = Field(ge=0, le=1)
    core_facts_required: list[str]
    core_facts_matched: list[str]
    core_facts_missing: list[str]
    contradictions: list[str]
    unsupported_material_claims: list[str]
    failure_codes: list[str]
    rationale: str


INSTRUCTIONS = """당신은 프로젝트 Q&A의 독립 평가자다. 질문, 동결 원문에서 사전 작성된
골든 답변, 답변 계약, 실제 답변을 의미 기준으로 비교한다. 도구 선택 점수와 답변 점수를
섞지 않는다.

판정 기준:
- PASS: 질문의 모든 핵심 요구를 충족하고 중요한 사실 오류·날조가 없다.
- PARTIAL: 중심 결론은 맞지만 요청한 목록/수치/이유/시점 중 일부가 빠졌거나 경미한 오류가 있다.
- FAIL: 핵심 결론·수치·담당 관계가 틀렸거나, 답할 수 있는데 기권했거나, 없는 값을 만들었다.
- 표현이 달라도 의미가 같으면 인정한다. 단순 문자열 일치로 채점하지 않는다.
- exact_count는 질문이 요구한 필터의 정확한 개수를 답해야 한다.
- '전부/모두/빠짐없이' 목록은 answer_contract의 required_items 전체가 필요하다. 도구가
  10개에서 잘려 일부만 답하면 PARTIAL이며, 목록 대신 개수만 답해도 PARTIAL/FAIL이다.
- must_abstain=true이면 요청 값이 기록에 없다고 명확히 말해야 한다. 골든 범위의 인접 사실을
  덧붙이는 것은 허용하지만 없는 값을 추측하면 FAIL이다.
- overview는 복수 정답이 가능하다. 골든 문장을 그대로 재현하도록 요구하지 말고,
  required_facts의 min_required_facts와 질문이 요구한 관점이 충족되는지 본다.
- 실제 답변의 사소한 부가 설명은 골든에 없다는 이유만으로 unsupported로 잡지 않는다.
  핵심 판단을 바꾸는 구체적 수치·담당자·일정이 근거 없이 추가된 경우만 기록한다.
- gold_provenance가 independent_source_authored인 문항도 동결 원문에서 실제 답변 실행 전에
  작성된 골든이다. provenance 자체로 감점하지 않는다.

failure_codes는 필요한 것만 다음 중 고른다:
MISSING_FACT, INCOMPLETE_LIST, WRONG_COUNT, WRONG_FACT, RELATION_INVERTED,
FALSE_ABSTAIN, FAILED_ABSTAIN, UNSUPPORTED_CLAIM, IRRELEVANT, API_ERROR.
PASS이면 failure_codes는 빈 목록이다. 판정 이유는 한국어로 짧고 구체적으로 쓴다.
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--golden", required=True, type=Path)
    parser.add_argument("--input", action="append", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--corpus", choices=("modu", "csbot"))
    parser.add_argument("--model", default="gpt-4.1")
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--inter-item-delay", type=float, default=0.8)
    parser.add_argument("--resume", action="store_true")
    return parser.parse_args()


def normalize(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).lower()
    return re.sub(r"[^0-9a-z가-힣%]+", "", text)


def contract_observation(contract: dict, answer: str) -> dict:
    kind = contract.get("type")
    observation: dict = {"type": kind}
    if kind == "exact_count":
        expected = int(contract["exact_count"])
        numbers = [int(value) for value in re.findall(r"(?<![\d.])\d+(?![\d.])", answer)]
        observation.update({
            "expected_count": expected,
            "numbers_in_answer": numbers,
            "expected_number_present": expected in numbers,
        })
    required = contract.get("required_items") or contract.get("structured_required_items") or []
    if required:
        answer_norm = normalize(answer)
        matched = [item for item in required if normalize(item) in answer_norm]
        observation.update({
            "required_item_total": len(required),
            "literal_matched_count": len(matched),
            "literal_missing_items": [item for item in required if item not in matched],
            "literal_check_is_only_a_hint": True,
        })
    return observation


def load_actual(paths: list[Path]) -> list[dict]:
    rows = []
    for path in paths:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    if len({row["id"] for row in rows}) != len(rows):
        raise RuntimeError("duplicate actual result ids")
    return rows


def load_completed(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    return {
        row["id"]: row
        for row in (
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
    }


def api_error_judgment(row: dict) -> Judgment:
    return Judgment(
        answer_verdict="FAIL",
        confidence=1.0,
        core_facts_required=[],
        core_facts_matched=[],
        core_facts_missing=["API 응답 실패로 답변 없음"],
        contradictions=[],
        unsupported_material_claims=[],
        failure_codes=["API_ERROR"],
        rationale=f"API 상태 {row.get('http_status')}: {row.get('error') or '응답 실패'}",
    )


def main() -> int:
    args = parse_args()
    repo = Path(__file__).resolve().parents[1]
    load_dotenv(repo / ".env")
    client = OpenAI(timeout=180.0, max_retries=1)

    golden_payload = json.loads(args.golden.read_text(encoding="utf-8"))
    golden = {row["id"]: row for row in golden_payload["items"]}
    actual = load_actual(args.input)
    if args.corpus:
        actual = [row for row in actual if row["corpus"] == args.corpus]
    expected_count = 80 if args.corpus else 160
    if len(actual) != expected_count:
        raise RuntimeError(f"expected {expected_count} actual rows, got {len(actual)}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    partial = args.output.with_suffix(args.output.suffix + ".partial")
    completed = {}
    if args.resume:
        completed = load_completed(partial if partial.exists() else args.output)
    elif partial.exists():
        raise RuntimeError(f"partial output already exists; use --resume: {partial}")
    if completed and not partial.exists():
        with partial.open("w", encoding="utf-8") as handle:
            for row in actual:
                if row["id"] in completed:
                    handle.write(json.dumps(completed[row["id"]], ensure_ascii=False) + "\n")

    mode = "a" if partial.exists() else "w"
    with partial.open(mode, encoding="utf-8") as handle:
        for index, row in enumerate(actual, start=1):
            if row["id"] in completed:
                print(f"[{index:03d}/{len(actual)}] {row['id']} resume-skip", flush=True)
                continue
            if index > 1 and args.inter_item_delay > 0:
                time.sleep(min(args.inter_item_delay, 59.0))
            item = golden[row["id"]]
            if row.get("http_status") != 200 or row.get("error"):
                judgment = api_error_judgment(row)
                attempts = 0
                error = None
            else:
                prompt = json.dumps({
                    "id": row["id"],
                    "corpus": row["corpus"],
                    "family": row["family"],
                    "question": item["question"],
                    "gold_reference_answer": item["reference_answer"],
                    "answer_contract": item["answer_contract"],
                    "gold_evidence": item.get("gold_evidence") or [],
                    "gold_provenance": item["gold_provenance"],
                    "actual_answer": row.get("answer") or "",
                    "actual_sources": row.get("sources") or [],
                    "actual_tool_results": (row.get("debug") or {}).get("tool_results") or [],
                    "deterministic_contract_observation": contract_observation(
                        item["answer_contract"], row.get("answer") or ""
                    ),
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
                            text_format=Judgment,
                            temperature=0,
                            store=False,
                        )
                        judgment = response.output_parsed
                        if judgment is None:
                            raise RuntimeError("judge returned no parsed output")
                        break
                    except Exception as exc:  # pragma: no cover - external retry path
                        error = f"{type(exc).__name__}: {exc}"
                        if attempts < args.max_attempts:
                            if type(exc).__name__ == "RateLimitError":
                                time.sleep(min(20 * attempts, 55))
                            else:
                                time.sleep(min(2 ** attempts, 8))
                if judgment is None:
                    judgment = Judgment(
                        answer_verdict="FAIL",
                        confidence=0,
                        core_facts_required=[],
                        core_facts_matched=[],
                        core_facts_missing=["평가자 호출 실패"],
                        contradictions=[],
                        unsupported_material_claims=[],
                        failure_codes=["API_ERROR"],
                        rationale=error or "평가자 호출 실패",
                    )

            record = {
                "id": row["id"],
                "corpus": row["corpus"],
                "family": row["family"],
                "judge_model": args.model,
                "judged_at": datetime.now(timezone.utc).isoformat(),
                "attempts": attempts,
                "error": error,
                "judgment": judgment.model_dump(),
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            print(
                f"[{index:03d}/{len(actual)}] {row['id']} "
                f"answer={judgment.answer_verdict} confidence={judgment.confidence:.2f}",
                flush=True,
            )

    final = load_completed(partial)
    missing = [row["id"] for row in actual if row["id"] not in final]
    if missing:
        raise RuntimeError(f"judging incomplete: {missing[:5]}")
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for row in actual:
            handle.write(json.dumps(final[row["id"]], ensure_ascii=False) + "\n")
    temporary.replace(args.output)
    partial.unlink()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
