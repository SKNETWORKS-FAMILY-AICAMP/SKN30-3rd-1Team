"""검색 품질 평가 CLI — 임베딩 유사도 + LLM-as-judge.

실행 흐름:
  1) 답변 생성 — workers 수만큼 병렬 (LLM API)
  2) 임베딩    — reference+actual 전체를 API 1회 배치 호출
  3) judge     — (선택) 병렬 호출

사용 예시:
    uv run python scripts/eval.py --qa-file eval/qa/qa_set_A.json --project-id 1 \
        --no-plan --no-judge --workers 5

설정 변경:
    uv run python scripts/eval.py --qa-file eval/qa/qa_set_A.json --project-id 1 \
        --embed-model text-embedding-3-large --chunk-size 400 \
        --llm-provider openai --llm-model gpt-4o
"""
import argparse
import json
import math
import os
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).parent.parent))
from scripts._config import (
    DEFAULT_EMBED_MODEL, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP,
    collection_name, print_config,
)

_print_lock = threading.Lock()


def _safe_print(*args, **kwargs):
    with _print_lock:
        print(*args, **kwargs)


def _cosine_similarity(vec_a: list, vec_b: list) -> float:
    dot = sum(a * b for a, b in zip(vec_a, vec_b))
    norm_a = math.sqrt(sum(a * a for a in vec_a))
    norm_b = math.sqrt(sum(b * b for b in vec_b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _batch_embed(texts: list[str], model: str) -> list[list[float]]:
    """텍스트 목록을 OpenAI API 1회 호출로 임베딩."""
    from openai import OpenAI
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    response = client.embeddings.create(input=texts, model=model)
    return [item.embedding for item in response.data]


def _judge(question: str, reference: str, actual: str, judge_model: str) -> dict:
    from openai import OpenAI
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    prompt = f"""다음은 질문에 대한 모범 답변과 AI 시스템의 실제 답변입니다.
아래 기준으로 실제 답변을 0~10점으로 평가하세요.

평가 기준:
- 10점: 모범 답변의 핵심 정보를 모두 포함하고 정확함
- 7~9점: 핵심 정보 대부분 포함, 일부 세부사항 누락
- 4~6점: 부분적으로 정확하나 중요한 정보 누락
- 1~3점: 관련은 있으나 핵심 정보 대부분 누락 또는 부정확
- 0점: 완전히 틀리거나 관련 없는 답변

질문: {question}
모범 답변: {reference}
실제 답변: {actual}

JSON 형식으로만 응답하세요:
{{"score": <0-10 정수>, "reason": "<한 줄 평가 이유>"}}"""

    response = client.chat.completions.create(
        model=judge_model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
        response_format={"type": "json_object"},
    )
    return json.loads(response.choices[0].message.content)


def _generate_answer(item, idx, total, project_id, search_mode, answer_fn) -> dict:
    """답변 생성만 담당 — 병렬 실행 단위."""
    qid = item.get("id", str(idx))
    question = item["question"]
    t0 = time.time()
    actual = ""
    retrieved_sources = []
    for attempt in range(2):
        try:
            result = answer_fn(project_id=project_id, question=question, search_mode=search_mode)
            actual = result["answer"]
            retrieved_sources = result.get("sources", [])
            break
        except Exception as e:
            _safe_print(f"  [{qid}] ⚠ 답변 실패 (시도 {attempt+1}/2): {type(e).__name__}: {e}")
            if attempt == 1:
                _safe_print(f"  [{qid}] ✗ 재시도 후에도 실패 — 빈 답변으로 기록")
    elapsed = time.time() - t0
    ref_src = item.get("source", "")
    _safe_print(f"[{idx}/{total}] {qid} ({elapsed:.1f}s)")
    _safe_print(f"  모범 출처: {ref_src}")
    _safe_print(f"  검색 출처: {', '.join(retrieved_sources) if retrieved_sources else '(없음)'}")
    return {"idx": idx, "actual": actual, "retrieved_sources": retrieved_sources, "elapsed_sec": round(elapsed, 2)}


def main():
    parser = argparse.ArgumentParser(description="PaiM 검색 품질 평가 (eval용)")
    parser.add_argument("--qa-file", required=True, help="질문-모범답변 JSON 파일 경로")
    parser.add_argument("--project-id", type=int, required=True, help="프로젝트 ID")
    parser.add_argument("--embed-model", default=DEFAULT_EMBED_MODEL, help=f"임베딩 모델 (기본: {DEFAULT_EMBED_MODEL})")
    parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE, help=f"인제스트 당시 청크 크기 (기본: {DEFAULT_CHUNK_SIZE})")
    parser.add_argument("--llm-provider", default=None, help="답변 LLM provider")
    parser.add_argument("--llm-model", default=None, help="답변 LLM 모델명")
    parser.add_argument("--judge-model", default="gpt-4.1-mini", help="평가 LLM 모델 (기본: gpt-4.1-mini)")
    parser.add_argument("--tag", default=None, help="특정 tag만 평가 (예: decision, action)")
    parser.add_argument("--output", default=None, help="결과 저장 경로 (.json)")
    parser.add_argument("--search-mode", default="both", choices=["both", "sql", "vector"],
                        help="검색 모드: both(기본) | sql(MySQL만) | vector(ChromaDB만)")
    parser.add_argument("--no-plan", action="store_true",
                        help="plan_node 건너뜀 — 검색+생성만 직접 호출 (LLM 1회/질문)")
    parser.add_argument("--no-judge", action="store_true", help="LLM-as-judge 건너뜀")
    parser.add_argument("--workers", type=int, default=1,
                        help="답변 생성 병렬 워커 수 (기본: 1, 권장: 3~5)")
    parser.add_argument("--from-results", default=None,
                        help="기존 결과 JSON 경로 — 답변 재생성 없이 judge/유사도만 재실행")
    args = parser.parse_args()

    col = collection_name(args.embed_model, args.chunk_size)
    os.environ["EMBED_MODEL"] = args.embed_model
    os.environ["CHROMA_COLLECTION_NAME"] = col
    if args.llm_provider:
        os.environ["LLM_PROVIDER"] = args.llm_provider
    if args.llm_model:
        provider = args.llm_provider or os.getenv("LLM_PROVIDER", "openai")
        model_env = {"openai": "OPENAI_MODEL", "claude": "CLAUDE_MODEL", "google": "GOOGLE_MODEL"}.get(provider)
        if model_env:
            os.environ[model_env] = args.llm_model

    llm_provider = os.getenv("LLM_PROVIDER", "openai")
    llm_model = os.getenv(
        {"openai": "OPENAI_MODEL", "claude": "CLAUDE_MODEL", "google": "GOOGLE_MODEL"}.get(llm_provider, "OPENAI_MODEL"),
        "gpt-4.1-mini",
    )

    print_config(
        embed_model=args.embed_model,
        chunk_size=args.chunk_size,
        chunk_overlap=DEFAULT_CHUNK_OVERLAP,
        llm_provider=llm_provider,
        llm_model=llm_model,
        langsmith=os.getenv("LANGCHAIN_TRACING_V2") == "true",
    )
    print(f"  JUDGE_MODEL   : {args.judge_model}")
    print(f"  NO_PLAN       : {args.no_plan}")
    print(f"  WORKERS       : {args.workers}\n")

    qa_path = Path(args.qa_file)
    if not qa_path.exists():
        print(f"[오류] QA 파일 없음: {qa_path}", file=sys.stderr)
        sys.exit(1)
    qa_items = json.loads(qa_path.read_text(encoding="utf-8"))
    if args.tag:
        qa_items = [q for q in qa_items if q.get("tag") == args.tag]
    print(f"평가 항목: {len(qa_items)}개 (tag={args.tag or '전체'})\n")

    if args.no_plan:
        from backend.retriever.qa_engine import _build_context, _get_chain

        def answer_fn(project_id, question, search_mode):
            context, sources, _ = _build_context(project_id, question, search_mode=search_mode)
            answer = _get_chain().invoke({"history": [], "context": context, "question": question})
            return {"answer": answer, "sources": sources}
    else:
        from backend.graph import run_qa

        def answer_fn(project_id, question, search_mode):
            return run_qa(project_id=project_id, question=question, search_mode=search_mode)

    t_start = time.time()

    # ── 1단계: 답변 생성 (병렬) 또는 기존 결과 로드 ──────────
    references = [item["answer"] for item in qa_items]

    if args.from_results:
        prior = json.loads(Path(args.from_results).read_text(encoding="utf-8"))
        prior_map = {r["id"]: r for r in prior["results"]}
        actuals = [prior_map.get(item.get("id", str(i+1)), {}).get("actual", "") for i, item in enumerate(qa_items)]
        retrieved_sources_list = [prior_map.get(item.get("id", str(i+1)), {}).get("retrieved_sources", []) for i, item in enumerate(qa_items)]
        elapsed_map = {item.get("id", str(i+1)): prior_map.get(item.get("id", str(i+1)), {}).get("elapsed_sec", 0) for i, item in enumerate(qa_items)}
        print(f"기존 답변 로드: {args.from_results} ({len(actuals)}개)\n")
        t_after_answers = time.time()
    else:
        print("=== 1단계: 답변 생성 ===")
        answer_map = {}
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {
                executor.submit(
                    _generate_answer, item, i, len(qa_items),
                    args.project_id, args.search_mode, answer_fn,
                ): i
                for i, item in enumerate(qa_items, 1)
            }
            for future in as_completed(futures):
                idx = futures[future]
                try:
                    answer_map[idx] = future.result()
                except Exception as e:
                    _safe_print(f"  ⚠ [{idx}] 실패: {e}")
                    answer_map[idx] = {"idx": idx, "actual": "", "elapsed_sec": 0}

        t_after_answers = time.time()
        print(f"\n답변 생성 완료: {t_after_answers - t_start:.1f}s\n")
        actuals = [answer_map.get(i + 1, {}).get("actual", "") for i in range(len(qa_items))]
        retrieved_sources_list = [answer_map.get(i + 1, {}).get("retrieved_sources", []) for i in range(len(qa_items))]
        elapsed_map = {item.get("id", str(i+1)): answer_map.get(i+1, {}).get("elapsed_sec", 0) for i, item in enumerate(qa_items)}

    # ── 2단계: 임베딩 유사도 (배치 1회) ─────────────────────
    print("=== 2단계: 임베딩 유사도 (배치) ===")


    similarities = [None] * len(qa_items)
    try:
        # 빈 actual은 건너뜀 — OpenAI API가 빈 문자열을 거부함
        valid_idx = [i for i in range(len(qa_items)) if actuals[i]]
        valid_refs = [references[i] for i in valid_idx]
        valid_acts = [actuals[i] for i in valid_idx]
        all_texts = valid_refs + valid_acts
        all_vecs = _batch_embed(all_texts, model=args.embed_model)
        ref_vecs = all_vecs[:len(valid_idx)]
        act_vecs = all_vecs[len(valid_idx):]
        for j, i in enumerate(valid_idx):
            similarities[i] = _cosine_similarity(ref_vecs[j], act_vecs[j])
        print(f"임베딩 완료: {time.time() - t_after_answers:.1f}s (API 1회, {len(all_texts)}개 텍스트)\n")
    except Exception as e:
        print(f"⚠ 임베딩 실패: {e}\n")

    # ── 3단계: LLM-as-judge (병렬, 선택) ────────────────────
    judge_scores = [None] * len(qa_items)
    judge_reasons = [None] * len(qa_items)
    if not args.no_judge:
        print("=== 3단계: LLM-as-judge ===")

        def _judge_one(i):
            item = qa_items[i]
            actual = actuals[i]
            if not actual:
                return i, None, None
            try:
                j = _judge(item["question"], item["answer"], actual, args.judge_model)
                return i, j.get("score"), j.get("reason")
            except Exception as e:
                _safe_print(f"  ⚠ [{item.get('id', i+1)}] judge 실패: {e}")
                return i, None, None

        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            for i, score, reason in executor.map(_judge_one, range(len(qa_items))):
                judge_scores[i] = score
                judge_reasons[i] = reason
                qid = qa_items[i].get("id", str(i + 1))
                score_str = f"{score}/10" if score is not None else "N/A"
                _safe_print(f"  [{qid}] judge: {score_str}  {reason or ''}")
        print()

    total_elapsed = time.time() - t_start

    # ── 결과 조합 ────────────────────────────────────────────
    results = []
    for i, item in enumerate(qa_items):
        results.append({
            "id": item.get("id", str(i + 1)),
            "set": item.get("set"),
            "tag": item.get("tag"),
            "question": item["question"],
            "reference": item["answer"],
            "actual": actuals[i],
            "reference_source": item.get("source"),
            "retrieved_sources": retrieved_sources_list[i],
            "cosine_similarity": similarities[i],
            "judge_score": judge_scores[i],
            "judge_reason": judge_reasons[i],
            "elapsed_sec": elapsed_map.get(item.get("id", str(i + 1)), 0),
        })

    print("=" * 60)
    print("[요약]")
    sims = [r["cosine_similarity"] for r in results if r["cosine_similarity"] is not None]
    scores = [r["judge_score"] for r in results if r["judge_score"] is not None]
    print(f"  임베딩 유사도 평균: {sum(sims)/len(sims):.3f}" if sims else "  임베딩 유사도: N/A")
    print(f"  LLM judge 평균:    {sum(scores)/len(scores):.1f}/10" if scores else "  LLM judge: N/A")
    print(f"  총 소요 시간:      {total_elapsed:.1f}s ({len(qa_items)}개)")

    tags = sorted(set(r["tag"] for r in results if r["tag"]))
    if len(tags) > 1:
        print("\n  [태그별]")
        for tag in tags:
            tr = [r for r in results if r["tag"] == tag]
            t_sims = [r["cosine_similarity"] for r in tr if r["cosine_similarity"] is not None]
            t_scores = [r["judge_score"] for r in tr if r["judge_score"] is not None]
            sim_avg = f"{sum(t_sims)/len(t_sims):.3f}" if t_sims else "N/A"
            score_avg = f"{sum(t_scores)/len(t_scores):.1f}" if t_scores else "N/A"
            print(f"    {tag:10s}: 유사도 {sim_avg}  judge {score_avg}/10  ({len(tr)}건)")

    print(f"\n  컬렉션: {col}  검색: {args.search_mode}")
    print(f"  LLM: {llm_provider}/{llm_model}")
    print("=" * 60)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps({
            "config": {
                "embed_model": args.embed_model,
                "chunk_size": args.chunk_size,
                "collection": col,
                "llm_provider": llm_provider,
                "llm_model": llm_model,
                "judge_model": args.judge_model,
                "search_mode": args.search_mode,
                "no_plan": args.no_plan,
                "workers": args.workers,
            },
            "summary": {
                "cosine_similarity_avg": round(sum(sims)/len(sims), 4) if sims else None,
                "judge_score_avg": round(sum(scores)/len(scores), 2) if scores else None,
                "count": len(results),
                "total_elapsed_sec": round(total_elapsed, 1),
            },
            "results": results,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n결과 저장: {out_path}")


if __name__ == "__main__":
    main()
