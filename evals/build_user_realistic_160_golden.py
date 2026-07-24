#!/usr/bin/env python3
"""Build a source-grounded answer contract for the 160-question user set.

The supplied package intentionally contains questions and expected tool names
only.  This script reuses the 100 previously reviewed answers that are still
available locally, derives structured answers from the frozen memory snapshot,
and authors the remaining open-ended answers from the frozen source corpus
*before* PaiM is run.  It never reads a current PaiM answer.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel, Field


DATA_COMMIT = "5240f4047187073725ff8b6dfaeedf5e9a6d8af7"
CORPORA = ("modu", "csbot")
LEGACY_PATHS = {
    "modu": "backend/test/golden/Test_modu/qa_set_Modu.json",
    "csbot": "backend/test/golden/Test_CS-Bot/paim_qa_testset.json",
}


class AuthoredGold(BaseModel):
    id: str
    reference_answer: str
    answerability: Literal["answerable", "absent", "ambiguous"]
    required_facts: list[str]
    acceptable_alternatives: list[str] = Field(default_factory=list)
    forbidden_claims: list[str] = Field(default_factory=list)
    must_abstain: bool = False
    gold_sources: list[str]
    evidence: list[str]


class AuthoredBatch(BaseModel):
    items: list[AuthoredGold]


AUTHOR_INSTRUCTIONS = """당신은 프로젝트 Q&A 골든 답변 작성자다. 제공된 동결 원문과
동결 memory 행만 사실 근거로 사용한다. PaiM의 실제 출력은 제공되지 않으며 추측하지 않는다.

각 질문에 대해:
- 질문에 직접 답하는 간결하지만 완전한 한국어 reference_answer를 작성한다.
- required_facts는 정답 판정에 꼭 필요한 원자적 사실만 넣는다.
- 기록에 값이 없으면 answerability=absent, must_abstain=true로 하고, 없다는 사실과 문서에
  실제로 있는 인접 사실을 구분한다. 없는 값을 만들지 않는다.
- overview 질문은 복수의 좋은 요약이 가능하다. 특정 문구에 과적합하지 말고 일정/결정,
  대표 액션, 이슈·리스크 가운데 질문에 필요한 공통 핵심만 required_facts로 둔다.
- mixed 질문은 질문의 두 부분을 모두 답한다.
- gold_sources에는 실제 근거 파일의 basename만 넣는다. absence는 전체 코퍼스를 검토했다는
  의미로 관련 파일을 모두 넣어도 된다.
- evidence에는 판정을 뒷받침하는 짧은 근거 문장만 넣고 원문을 길게 복사하지 않는다.
- 질문 ID를 정확히 보존하고, 입력된 모든 질문을 정확히 한 번씩 반환한다.
"""


NEW_STRUCTURED = {
    "M-SC06": {"operation": "count", "categories": ["decision"]},
    "M-SC07": {"operation": "count", "categories": ["issue"]},
    "M-SC08": {"operation": "count", "categories": ["all"]},
    "M-SC09": {"operation": "count", "categories": ["action"], "status": "completed"},
    "M-SC10": {"operation": "count", "categories": ["action"], "status": "unknown"},
    "M-SL06": {"operation": "list", "categories": ["action"], "status": "open"},
    "M-SL07": {"operation": "list", "categories": ["action"], "status": "completed"},
    "M-SL08": {"operation": "list", "categories": ["action"], "status": "unknown"},
    "M-SL09": {"operation": "list", "categories": ["all"], "owner": "박현우"},
    "M-SL10": {"operation": "list", "categories": ["issue", "risk"]},
    "C-SC06": {"operation": "count", "categories": ["decision"]},
    "C-SC07": {"operation": "count", "categories": ["issue"]},
    "C-SC08": {"operation": "count", "categories": ["all"]},
    "C-SC09": {"operation": "count", "categories": ["action"], "status": "completed"},
    "C-SC10": {"operation": "count", "categories": ["action"], "status": "unknown"},
    "C-SL06": {"operation": "list", "categories": ["action"], "status": "open"},
    "C-SL07": {"operation": "list", "categories": ["action"], "status": "completed"},
    "C-SL08": {"operation": "list", "categories": ["action"], "status": "unknown"},
    "C-SL09": {"operation": "list", "categories": ["all"], "owner": "이지훈"},
    "C-SL10": {"operation": "list", "categories": ["issue", "risk"]},
}

NEW_MIXED_LISTS = {
    "M-MX08": {"categories": ["action"], "owner": "박현우"},
    "M-MX09": {"categories": ["action"], "owner": "이수진"},
    "M-MX10": {"categories": ["action"], "owner": "김태호"},
    "C-MX08": {"categories": ["action"], "owner": "윤재혁"},
    "C-MX09": {"categories": ["action"], "owner": "최민준"},
    "C-MX10": {"categories": ["issue"]},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--question-set", required=True, type=Path)
    parser.add_argument("--state-root", required=True, type=Path)
    parser.add_argument("--sources-root", required=True, type=Path)
    parser.add_argument("--route-results", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", default="gpt-4.1")
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--inter-batch-delay", type=float, default=50.0)
    return parser.parse_args()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_json(repo: Path, object_path: str) -> list[dict]:
    raw = subprocess.check_output(
        ["git", "show", f"{DATA_COMMIT}:{object_path}"], cwd=repo
    )
    return json.loads(raw)


def source_paths_for_note(corpus: str, note: str, sources_root: Path) -> list[str]:
    paths = sorted((sources_root / corpus).glob("*.md"))
    dates = {
        f"{int(match.group(1)):02d}-{int(match.group(2)):02d}"
        for match in re.finditer(r"(?<!\d)(\d{1,2})/(\d{1,2})(?!\d)", note or "")
    }
    selected = [path for path in paths if path.name[5:10] in dates]
    if "해당 없음" in (note or "") or not selected:
        selected = paths
    return [f"sources/{corpus}/{path.name}" for path in selected]


def legacy_items(repo: Path, sources_root: Path) -> dict[str, dict]:
    result: dict[str, dict] = {}
    prefix = {"modu": "M", "csbot": "C"}
    for corpus in CORPORA:
        for row in git_json(repo, LEGACY_PATHS[corpus]):
            item_id = f"{prefix[corpus]}-LEG-{row['id'][0]}{int(row['id'][1:]):02d}"
            tag = str(row.get("tag") or "")
            absent = tag in {"hallu", "hallucination"}
            result[item_id] = {
                "reference_answer": row["answer"],
                "gold_sources": source_paths_for_note(corpus, row.get("source") or "", sources_root),
                "answerability": "absent" if absent else "answerable",
                "answer_contract": {
                    "type": "semantic_reference",
                    "required_facts": [],
                    "forbidden_claims": [],
                    "must_abstain": absent,
                    "legacy_tag": tag,
                },
                "gold_provenance": "reviewed_legacy_gold",
                "gold_evidence": [row.get("source") or ""],
            }
    return result


def route_items(route_results: Path) -> dict[str, dict]:
    result = {}
    for corpus in CORPORA:
        path = route_results / f"actual_{corpus}.jsonl"
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            normalized_sources = []
            for source in row.get("gold_sources") or []:
                if source == f"memory_snapshots/{corpus}.json":
                    source = f"state/{corpus}/memory_snapshot.json"
                elif source == f"overview_snapshots/{corpus}.json":
                    source = f"state/{corpus}/overview_snapshot.json"
                normalized_sources.append(source)
            result[row["id"]] = {
                "reference_answer": row["reference_answer"],
                "gold_sources": normalized_sources,
                "answerability": (
                    "absent"
                    if (row.get("expected") or {}).get("answer_contract", {}).get("must_abstain")
                    else "answerable"
                ),
                "answer_contract": (row.get("expected") or {}).get("answer_contract") or {},
                "gold_provenance": "reviewed_route_balanced_gold",
                "gold_evidence": [],
                "prior_expected": row.get("expected") or {},
            }
    return result


def load_memory(state_root: Path, corpus: str) -> list[dict]:
    path = state_root / corpus / "memory_snapshot.json"
    rows = json.loads(path.read_text(encoding="utf-8"))
    return sorted(rows, key=lambda row: int(row["id"]))


def select_rows(rows: list[dict], spec: dict) -> list[dict]:
    categories = set(spec.get("categories") or ["all"])
    selected = []
    for row in rows:
        if "all" not in categories and row.get("category") not in categories:
            continue
        if spec.get("owner") and row.get("owner") != spec["owner"]:
            continue
        if spec.get("status") and row.get("completion_status") != spec["status"]:
            continue
        selected.append(row)
    return selected


def structured_gold(item: dict, rows: list[dict], spec: dict, corpus: str) -> dict:
    selected = select_rows(rows, spec)
    sources = list(dict.fromkeys(
        f"sources/{corpus}/{row['source']}" for row in selected if row.get("source")
    )) or [f"state/{corpus}/memory_snapshot.json"]
    label = "조건에 맞는 기록"
    if spec.get("operation") == "count":
        answer = f"동결된 {corpus} 메모리 스냅샷 기준 {label}은 총 {len(selected)}건이다."
        contract = {
            "type": "exact_count",
            "exact_count": len(selected),
            "required_terms": [str(len(selected))],
            "filters": spec,
        }
    else:
        if selected:
            lines = []
            for row in selected:
                owner = f" (담당: {row['owner']})" if row.get("owner") else ""
                category = f"[{row['category']}] " if len(spec.get("categories") or []) > 1 or "all" in (spec.get("categories") or []) else ""
                lines.append(f"- {category}{row['content']}{owner}")
            answer = (
                f"동결된 {corpus} 메모리 스냅샷 기준 {label}은 총 {len(selected)}건이다.\n"
                + "\n".join(lines)
            )
        else:
            answer = f"동결된 {corpus} 메모리 스냅샷 기준 {label}은 0건이다."
        contract = {
            "type": "unordered_complete_list",
            "expected_total": len(selected),
            "required_items": [row["content"] for row in selected],
            "required_ids": [row["id"] for row in selected],
            "filters": spec,
            "order_matters": False,
            "completeness_required": True,
        }
    return {
        "reference_answer": answer,
        "gold_sources": sources,
        "answerability": "answerable",
        "answer_contract": contract,
        "gold_provenance": "deterministic_frozen_memory",
        "gold_evidence": [f"memory rows: {', '.join(str(row['id']) for row in selected)}"],
    }


def source_bundle(sources_root: Path, corpus: str) -> str:
    sections = []
    for path in sorted((sources_root / corpus).glob("*.md")):
        sections.append(f"\n## SOURCE: {path.name}\n{path.read_text(encoding='utf-8')}")
    return "\n".join(sections)


def compact_memory(rows: list[dict]) -> str:
    payload = [{
        "id": row["id"],
        "category": row.get("category"),
        "content": row.get("content"),
        "reason": row.get("reason"),
        "topic": row.get("topic"),
        "owner": row.get("owner"),
        "date": row.get("date"),
        "due_date": row.get("due_date"),
        "completion_status": row.get("completion_status"),
        "source": row.get("source"),
    } for row in rows]
    return json.dumps(payload, ensure_ascii=False, indent=1)


def author_batches(
    client: OpenAI,
    model: str,
    questions: list[dict],
    sources_root: Path,
    memories: dict[str, list[dict]],
    cache_path: Path,
    max_attempts: int,
    inter_batch_delay: float,
) -> dict[str, dict]:
    cached: dict[str, dict] = {}
    if cache_path.exists():
        for line in cache_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                cached[row["id"]] = row

    pending_groups: dict[tuple[str, str], list[dict]] = {}
    for item in questions:
        if item["id"] not in cached:
            pending_groups.setdefault((item["corpus"], item["family"]), []).append(item)

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with cache_path.open("a", encoding="utf-8") as handle:
        for group_index, ((corpus, family), group) in enumerate(sorted(pending_groups.items())):
            if group_index and inter_batch_delay > 0:
                time.sleep(min(inter_batch_delay, 59.0))
            prompt = json.dumps({
                "corpus": corpus,
                "family": family,
                "questions": [{"id": row["id"], "question": row["question"]} for row in group],
                "allowed_source_basenames": [path.name for path in sorted((sources_root / corpus).glob("*.md"))],
            }, ensure_ascii=False, indent=2)
            prompt += "\n\n[동결 원문]\n" + source_bundle(sources_root, corpus)
            prompt += "\n\n[동결 structured memory]\n" + compact_memory(memories[corpus])

            expected_ids = {row["id"] for row in group}
            parsed = None
            error = None
            for attempt in range(1, max(1, max_attempts) + 1):
                try:
                    response = client.responses.parse(
                        model=model,
                        instructions=AUTHOR_INSTRUCTIONS,
                        input=prompt,
                        text_format=AuthoredBatch,
                        temperature=0,
                        store=False,
                    )
                    parsed = response.output_parsed
                    if parsed is None:
                        raise RuntimeError("gold author returned no parsed output")
                    actual_ids = {row.id for row in parsed.items}
                    if actual_ids != expected_ids or len(parsed.items) != len(expected_ids):
                        raise RuntimeError(
                            f"gold author id mismatch: expected={sorted(expected_ids)} actual={sorted(actual_ids)}"
                        )
                    break
                except Exception as exc:  # pragma: no cover - external retry path
                    error = f"{type(exc).__name__}: {exc}"
                    if attempt < max_attempts:
                        if type(exc).__name__ == "RateLimitError":
                            time.sleep(min(20 * attempt, 55))
                        else:
                            time.sleep(min(2 ** attempt, 8))
            if parsed is None:
                raise RuntimeError(f"failed to author {corpus}/{family}: {error}")

            allowed = {path.name for path in (sources_root / corpus).glob("*.md")}
            for authored in parsed.items:
                row = authored.model_dump()
                row["gold_sources"] = [
                    f"sources/{corpus}/{Path(source).name}"
                    for source in row["gold_sources"]
                    if Path(source).name in allowed
                ]
                if not row["gold_sources"]:
                    row["gold_sources"] = [f"sources/{corpus}/{name}" for name in sorted(allowed)]
                row["gold_provenance"] = "independent_source_authored_gpt-4.1"
                row["authored_model"] = model
                row["authored_at"] = datetime.now(timezone.utc).isoformat()
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
                handle.flush()
                cached[row["id"]] = row
            print(f"[골든 작성] {corpus}/{family}: {len(group)}문항", flush=True)
    return cached


def ensure_mixed_completeness(gold: dict, rows: list[dict], spec: dict) -> dict:
    selected = select_rows(rows, spec)
    required_items = [row["content"] for row in selected]
    missing = [content for content in required_items if content not in gold["reference_answer"]]
    if missing:
        gold["reference_answer"] += (
            f"\n\n구조화 목록 전체 {len(selected)}건:\n"
            + "\n".join(f"- {row['content']}" for row in selected)
        )
    contract = gold["answer_contract"]
    contract.update({
        "structured_expected_total": len(selected),
        "structured_required_items": required_items,
        "structured_required_ids": [row["id"] for row in selected],
        "structured_filters": spec,
        "completeness_required": True,
    })
    for row in selected:
        source = row.get("source")
        path = f"sources/{gold['corpus']}/{source}" if source else None
        if path and path not in gold["gold_sources"]:
            gold["gold_sources"].append(path)
    return gold


def deep_merge(base: dict, override: dict) -> dict:
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def main() -> int:
    args = parse_args()
    repo = Path(__file__).resolve().parents[1]
    load_dotenv(repo / ".env")
    question_payload = json.loads(args.question_set.read_text(encoding="utf-8-sig"))
    questions = question_payload["items"]
    if len(questions) != 160 or len({row["id"] for row in questions}) != 160:
        raise RuntimeError("question set must contain 160 unique items")

    memories = {corpus: load_memory(args.state_root, corpus) for corpus in CORPORA}
    known = legacy_items(repo, args.sources_root)
    overlap = set(known) & set(route_items(args.route_results))
    if overlap:
        raise RuntimeError(f"unexpected legacy/route overlap: {sorted(overlap)}")
    known.update(route_items(args.route_results))
    for item in questions:
        if item["id"] in NEW_STRUCTURED:
            known[item["id"]] = structured_gold(
                item, memories[item["corpus"]], NEW_STRUCTURED[item["id"]], item["corpus"]
            )

    to_author = [row for row in questions if row["id"] not in known]
    if len(known) != 120 or len(to_author) != 40:
        raise RuntimeError(f"expected 120 deterministic/reused + 40 authored, got {len(known)} + {len(to_author)}")

    client = OpenAI(timeout=240.0, max_retries=1)
    cache_path = args.output.with_suffix(".authored.jsonl")
    authored = author_batches(
        client, args.model, to_author, args.sources_root, memories,
        cache_path, args.max_attempts, args.inter_batch_delay,
    )

    review_path = repo / "evals/user_realistic_160_gold_manual_review.json"
    manual_reviews = (
        json.loads(review_path.read_text(encoding="utf-8"))
        if review_path.exists()
        else {}
    )

    output_items = []
    for question in questions:
        base = dict(question)
        if question["id"] in known:
            gold = dict(known[question["id"]])
        else:
            row = dict(authored[question["id"]])
            gold = {
                "reference_answer": row["reference_answer"],
                "gold_sources": row["gold_sources"],
                "answerability": row["answerability"],
                "answer_contract": {
                    "type": "overview_facts" if question["family"] == "overview" else "semantic_facts",
                    "required_facts": row["required_facts"],
                    "acceptable_alternatives": row["acceptable_alternatives"],
                    "forbidden_claims": row["forbidden_claims"],
                    "must_abstain": row["must_abstain"],
                    "min_required_facts": (
                        max(2, math.ceil(len(row["required_facts"]) * 0.7))
                        if question["family"] == "overview" and row["required_facts"]
                        else len(row["required_facts"])
                    ),
                },
                "gold_provenance": row["gold_provenance"],
                "gold_evidence": row["evidence"],
                "authored_model": row.get("authored_model"),
                "authored_at": row.get("authored_at"),
            }
        base.update(gold)
        base["expected_tools"] = list(question["expected_tools"])
        if question["id"] in manual_reviews:
            base = deep_merge(base, manual_reviews[question["id"]])
            base["gold_manual_review"] = {
                "reviewed": True,
                "review_file": str(review_path.relative_to(repo)),
                "reviewed_before_answer_judging": True,
            }
        if question["id"] in NEW_MIXED_LISTS:
            base = ensure_mixed_completeness(
                base, memories[question["corpus"]], NEW_MIXED_LISTS[question["id"]]
            )
        output_items.append(base)

    provenance_counts: dict[str, int] = {}
    for row in output_items:
        provenance_counts[row["gold_provenance"]] = provenance_counts.get(row["gold_provenance"], 0) + 1
    payload = {
        "dataset_id": "paim_user_realistic_160_answer_contract_20260722",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "question_set_sha256": sha256(args.question_set),
        "source_commit": DATA_COMMIT,
        "gold_author_model": args.model,
        "gold_is_original_package_content": False,
        "method_note": (
            "원 질문 패키지에는 답변 골든이 없다. 기존 검토 골든 100개를 재사용하고, "
            "20개 구조화 문항은 동결 memory에서 결정론적으로 산출했으며, 나머지 40개는 "
            "PaiM 실행 전에 동결 원문으로 독립 작성했다."
        ),
        "provenance_counts": provenance_counts,
        "total": len(output_items),
        "items": output_items,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(args.output)
    print(json.dumps({"total": len(output_items), "provenance_counts": provenance_counts}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
