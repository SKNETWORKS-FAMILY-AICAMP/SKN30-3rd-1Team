"""평가 파이프라인 CLI — 인제스트 → eval → TSV 비교표 생성.

실행 흐름:
  1) 인제스트  : (embed_model × chunk_size) 조합마다 문서 적재
  2) eval     : (embed_model × chunk_size × search_mode) 조합마다 평가
  3) TSV 생성 : 전체 결과 비교표

사용 예시:
    # 기본 (3small, c600, 3개 검색모드)
    uv run python scripts/run_pipeline.py \
        --docs-dir eval/docs --qa-file eval/qa/qa_set_A.json --project-id 12

    # 임베딩 모델 + 청크 크기 복수 실험
    uv run python scripts/run_pipeline.py \
        --docs-dir eval/docs --qa-file eval/qa/qa_set_A.json --project-id 12 \
        --embed-models text-embedding-3-small text-embedding-3-large \
        --chunk-sizes 300 600 \
        --search-modes sql vector both \
        --workers 5

    # 이미 인제스트된 컬렉션 건너뜀
    uv run python scripts/run_pipeline.py \
        --docs-dir eval/docs --qa-file eval/qa/qa_set_A.json --project-id 12 \
        --skip-ingest --workers 5
"""
import argparse
import json
import math
import os
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from itertools import product
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).parent.parent))
from scripts._config import collection_name, DEFAULT_EMBED_MODEL, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP

_print_lock = threading.Lock()


def _safe_print(*args, **kwargs):
    with _print_lock:
        print(*args, **kwargs)


# ── 유틸 ────────────────────────────────────────────────────────

def _cosine_similarity(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def _batch_embed(texts, model):
    from openai import OpenAI
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    resp = client.embeddings.create(input=texts, model=model)
    return [item.embedding for item in resp.data]


def _judge(question, reference, actual, judge_model):
    from openai import OpenAI
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    prompt = f"""다음은 질문에 대한 모범 답변과 AI 시스템의 실제 답변입니다.
아래 기준으로 실제 답변을 0~10점으로 평가하세요.
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
    resp = client.chat.completions.create(
        model=judge_model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
        response_format={"type": "json_object"},
    )
    return json.loads(resp.choices[0].message.content)


def _collection_exists(col_name, persist_dir):
    """ChromaDB에 컬렉션이 이미 있는지 확인."""
    try:
        import chromadb
        client = chromadb.PersistentClient(path=persist_dir)
        existing = [c.name for c in client.list_collections()]
        return col_name in existing
    except Exception:
        return False


# ── 1단계: 인제스트 ─────────────────────────────────────────────

def run_ingest(docs_dir, project_id, embed_model, chunk_size, chunk_overlap, skip_ingest, persist_dir):
    col = collection_name(embed_model, chunk_size)

    if skip_ingest and _collection_exists(col, persist_dir):
        print(f"  [SKIP] 컬렉션 이미 존재: {col}")
        return col

    os.environ["EMBED_MODEL"] = embed_model
    os.environ["CHROMA_COLLECTION_NAME"] = col

    from backend.db.mysql import get_connection
    from backend.pipeline.extractor import extract
    from backend.pipeline.ingestor import ingest

    doc_files = sorted(Path(docs_dir).glob("*.md")) + sorted(Path(docs_dir).glob("*.txt"))
    if not doc_files:
        print(f"  ⚠ 문서 없음: {docs_dir}")
        return col

    print(f"  → {col} ({len(doc_files)}개 문서, chunk={chunk_size}, overlap={chunk_overlap})")

    for fpath in doc_files:
        content = fpath.read_text(encoding="utf-8", errors="replace")
        if not content.strip():
            continue

        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO documents (project_id, filename, doc_type, status) VALUES (%s,%s,'meeting','processing')",
                    (project_id, fpath.name),
                )
                doc_id = cur.lastrowid
            conn.commit()
        finally:
            conn.close()

        items = extract(content, default_source=fpath.name)
        ingest(
            project_id=project_id, doc_id=doc_id, items=items,
            raw_text=content, source=fpath.name, date="", doc_type="meeting",
            source_metadata={"source_kind": "document", "source_type": "meeting", "source_path": fpath.name},
            chunk_size=chunk_size, chunk_overlap=chunk_overlap,
        )

        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("UPDATE documents SET status='indexed' WHERE id=%s", (doc_id,))
            conn.commit()
        finally:
            conn.close()

        print(f"    ✓ {fpath.name}")

    return col


# ── 2단계: eval ─────────────────────────────────────────────────

def _answer_one(item, idx, total, project_id, search_mode, answer_fn):
    qid = item.get("id", str(idx))
    question = item["question"]
    t0 = time.time()
    actual, retrieved_sources = "", []
    for attempt in range(2):
        try:
            result = answer_fn(project_id=project_id, question=question, search_mode=search_mode)
            actual = result["answer"]
            retrieved_sources = result.get("sources", [])
            break
        except Exception as e:
            _safe_print(f"  [{qid}] ⚠ 실패 (시도 {attempt+1}/2): {type(e).__name__}: {e}")
    elapsed = time.time() - t0
    _safe_print(f"  [{qid}] {elapsed:.1f}s  검색출처: {', '.join(retrieved_sources) or '(없음)'}")
    return {"idx": idx, "actual": actual, "retrieved_sources": retrieved_sources, "elapsed_sec": round(elapsed, 2)}


def run_eval(qa_items, project_id, embed_model, chunk_size, search_mode,
             workers, no_judge, judge_model, output_path):
    col = collection_name(embed_model, chunk_size)
    os.environ["EMBED_MODEL"] = embed_model
    os.environ["CHROMA_COLLECTION_NAME"] = col

    from backend.retriever.qa_engine import _build_context, _get_chain

    # 컬렉션 바뀔 때 싱글톤 리셋
    import backend.retriever.qa_engine as _qe
    _qe._vectorstore = None
    _qe._chain = None

    def answer_fn(project_id, question, search_mode):
        context, sources, _ = _build_context(project_id, question, search_mode=search_mode)
        answer = _get_chain().invoke({"history": [], "context": context, "question": question})
        return {"answer": answer, "sources": sources}

    # 답변 생성 (병렬)
    answer_map = {}
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(_answer_one, item, i, len(qa_items), project_id, search_mode, answer_fn): i
            for i, item in enumerate(qa_items, 1)
        }
        for future in as_completed(futures):
            idx = futures[future]
            try:
                answer_map[idx] = future.result()
            except Exception as e:
                answer_map[idx] = {"idx": idx, "actual": "", "retrieved_sources": [], "elapsed_sec": 0}

    actuals = [answer_map.get(i + 1, {}).get("actual", "") for i in range(len(qa_items))]
    retrieved_sources_list = [answer_map.get(i + 1, {}).get("retrieved_sources", []) for i in range(len(qa_items))]
    elapsed_list = [answer_map.get(i + 1, {}).get("elapsed_sec", 0) for i in range(len(qa_items))]

    # 임베딩 유사도 (배치)
    references = [item["answer"] for item in qa_items]
    similarities = [None] * len(qa_items)
    try:
        valid_idx = [i for i in range(len(qa_items)) if actuals[i]]
        vecs = _batch_embed([references[i] for i in valid_idx] + [actuals[i] for i in valid_idx], model=embed_model)
        n = len(valid_idx)
        for j, i in enumerate(valid_idx):
            similarities[i] = _cosine_similarity(vecs[j], vecs[n + j])
    except Exception as e:
        print(f"  ⚠ 임베딩 유사도 실패: {e}")

    # judge (병렬)
    judge_scores = [None] * len(qa_items)
    judge_reasons = [None] * len(qa_items)
    if not no_judge:
        def _judge_one(i):
            if not actuals[i]:
                return i, None, None
            try:
                j = _judge(qa_items[i]["question"], qa_items[i]["answer"], actuals[i], judge_model)
                return i, j.get("score"), j.get("reason")
            except Exception as e:
                return i, None, str(e)
        with ThreadPoolExecutor(max_workers=workers) as executor:
            for i, score, reason in executor.map(_judge_one, range(len(qa_items))):
                judge_scores[i] = score
                judge_reasons[i] = reason

    results = []
    for i, item in enumerate(qa_items):
        results.append({
            "id": item.get("id", str(i + 1)),
            "set": item.get("set"),
            "tag": item.get("tag"),
            "question": item["question"],
            "reference": item["answer"],
            "actual": actuals[i],
            "reference_source": item.get("source", ""),
            "retrieved_sources": retrieved_sources_list[i],
            "cosine_similarity": similarities[i],
            "judge_score": judge_scores[i],
            "judge_reason": judge_reasons[i],
            "elapsed_sec": elapsed_list[i],
        })

    sims = [r["cosine_similarity"] for r in results if r["cosine_similarity"] is not None]
    scores = [r["judge_score"] for r in results if r["judge_score"] is not None]

    output_data = {
        "config": {
            "embed_model": embed_model, "chunk_size": chunk_size,
            "collection": col, "search_mode": search_mode,
            "judge_model": judge_model, "workers": workers,
        },
        "summary": {
            "cosine_similarity_avg": round(sum(sims) / len(sims), 4) if sims else None,
            "judge_score_avg": round(sum(scores) / len(scores), 2) if scores else None,
            "count": len(results),
        },
        "results": results,
    }
    Path(output_path).write_text(json.dumps(output_data, ensure_ascii=False, indent=2), encoding="utf-8")
    score_str = f"{output_data['summary']['judge_score_avg']:.1f}/10" if scores else "N/A"
    sim_str = f"{output_data['summary']['cosine_similarity_avg']:.3f}" if sims else "N/A"
    print(f"  → {Path(output_path).name}  judge={score_str}  sim={sim_str}")
    return output_data


# ── 3단계: TSV 생성 ─────────────────────────────────────────────

def build_tsv(all_results, qa_items, output_path):
    """모든 실험 결과를 하나의 TSV로 합침."""
    configs = list(all_results.keys())  # (embed_model, chunk_size, search_mode)

    # 동적 헤더
    headers = ["ID", "TAG", "질문", "예상답변", "모범출처"]
    for cfg in configs:
        em_short = cfg[0].replace("text-embedding-", "")
        label = f"{em_short}_c{cfg[1]}_{cfg[2]}"
        headers += [f"judge_{label}", f"sim_{label}", f"답변_{label}", f"검색출처_{label}"]

    id_order = [item.get("id", str(i + 1)) for i, item in enumerate(qa_items)]

    rows = [headers]
    for qid in id_order:
        base_item = next((it for it in qa_items if it.get("id") == qid), {})
        row = [
            qid,
            base_item.get("tag", ""),
            base_item.get("question", "").replace("\t", " ").replace("\n", " "),
            base_item.get("answer", "").replace("\t", " ").replace("\n", " "),
            base_item.get("source", ""),
        ]
        for cfg in configs:
            result_map = {r["id"]: r for r in all_results[cfg]["results"]}
            r = result_map.get(qid, {})
            row += [
                str(r.get("judge_score") or ""),
                f"{r['cosine_similarity']:.3f}" if r.get("cosine_similarity") is not None else "",
                (r.get("actual") or "").replace("\t", " ").replace("\n", " "),
                ", ".join(r.get("retrieved_sources", [])),
            ]
        rows.append(row)

    Path(output_path).write_text(
        "\n".join("\t".join(r) for r in rows), encoding="utf-8"
    )
    print(f"\n  TSV 저장: {output_path} ({len(rows)-1}행, {len(configs)}개 실험)")


# ── main ────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="PaiM 평가 파이프라인")
    parser.add_argument("--docs-dir", required=True, help="인제스트할 문서 디렉토리")
    parser.add_argument("--qa-file", required=True, help="질문-모범답변 JSON 파일")
    parser.add_argument("--project-id", type=int, required=True, help="프로젝트 ID")
    parser.add_argument("--embed-models", nargs="+", default=[DEFAULT_EMBED_MODEL],
                        help="임베딩 모델 (복수 가능)")
    parser.add_argument("--chunk-sizes", nargs="+", type=int, default=[DEFAULT_CHUNK_SIZE],
                        help="청크 크기 (복수 가능)")
    parser.add_argument("--chunk-overlap", type=int, default=DEFAULT_CHUNK_OVERLAP,
                        help=f"청크 오버랩 (기본: {DEFAULT_CHUNK_OVERLAP})")
    parser.add_argument("--search-modes", nargs="+", default=["sql", "vector", "both"],
                        choices=["sql", "vector", "both"], help="검색 모드")
    parser.add_argument("--workers", type=int, default=5, help="병렬 워커 수 (기본: 5)")
    parser.add_argument("--judge-model", default="gpt-4.1-mini", help="judge LLM 모델")
    parser.add_argument("--skip-ingest", action="store_true", help="기존 컬렉션 있으면 인제스트 건너뜀")
    parser.add_argument("--no-judge", action="store_true", help="LLM-as-judge 건너뜀")
    parser.add_argument("--output-dir", default="eval/results", help="결과 저장 디렉토리")
    parser.add_argument("--tag", default=None, help="특정 tag만 평가")
    args = parser.parse_args()

    persist_dir = os.getenv("CHROMA_PERSIST_DIR", ".chroma")
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    qa_items = json.loads(Path(args.qa_file).read_text(encoding="utf-8"))
    if args.tag:
        qa_items = [q for q in qa_items if q.get("tag") == args.tag]

    combos = list(product(args.embed_models, args.chunk_sizes))
    eval_combos = list(product(args.embed_models, args.chunk_sizes, args.search_modes))

    print(f"\n{'='*60}")
    print(f"PaiM 평가 파이프라인")
    print(f"  embed_models : {args.embed_models}")
    print(f"  chunk_sizes  : {args.chunk_sizes}")
    print(f"  search_modes : {args.search_modes}")
    print(f"  QA 항목      : {len(qa_items)}개")
    print(f"  인제스트 조합 : {len(combos)}개")
    print(f"  eval 조합    : {len(eval_combos)}개")
    print(f"{'='*60}\n")

    # ── 1단계: 인제스트 ──────────────────────────────────────────
    print("=== 1단계: 인제스트 ===")
    for embed_model, chunk_size in combos:
        run_ingest(
            docs_dir=args.docs_dir,
            project_id=args.project_id,
            embed_model=embed_model,
            chunk_size=chunk_size,
            chunk_overlap=args.chunk_overlap,
            skip_ingest=args.skip_ingest,
            persist_dir=persist_dir,
        )
    print()

    # ── 2단계: eval ──────────────────────────────────────────────
    print("=== 2단계: eval ===")
    all_results = {}
    for embed_model, chunk_size, search_mode in eval_combos:
        em_short = embed_model.replace("text-embedding-", "")
        label = f"{em_short}_c{chunk_size}_{search_mode}"
        output_path = out_dir / f"eval_{label}_judged.json"
        print(f"\n[{label}]")
        result = run_eval(
            qa_items=qa_items,
            project_id=args.project_id,
            embed_model=embed_model,
            chunk_size=chunk_size,
            search_mode=search_mode,
            workers=args.workers,
            no_judge=args.no_judge,
            judge_model=args.judge_model,
            output_path=str(output_path),
        )
        all_results[(embed_model, chunk_size, search_mode)] = result
    print()

    # ── 3단계: TSV ───────────────────────────────────────────────
    print("=== 3단계: TSV 생성 ===")
    tsv_path = out_dir / "eval_comparison.tsv"
    build_tsv(all_results, qa_items, str(tsv_path))

    # 최종 요약
    print(f"\n{'='*60}")
    print("[최종 요약]")
    print("{:<35} {:>10} {:>8}".format("실험", "judge", "유사도"))
    print("-" * 55)
    for cfg, result in all_results.items():
        em_short = cfg[0].replace("text-embedding-", "")
        label = f"{em_short}_c{cfg[1]}_{cfg[2]}"
        s = result["summary"]
        judge_str = f"{s['judge_score_avg']:.1f}/10" if s.get("judge_score_avg") else "N/A"
        sim_str = f"{s['cosine_similarity_avg']:.3f}" if s.get("cosine_similarity_avg") else "N/A"
        print("{:<35} {:>10} {:>8}".format(label, judge_str, sim_str))
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
