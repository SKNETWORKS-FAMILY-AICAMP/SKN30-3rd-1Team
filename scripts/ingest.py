"""문서 인제스트 CLI — 검색 품질 평가용.

컬렉션명은 임베딩 모델 + 청크 크기 조합으로 자동 생성됩니다.
  text-embedding-3-small + 600  →  paiM_3small_c600  (기본)
  text-embedding-3-large + 400  →  paiM_3large_c400

사용 예시:
    # 기본 설정
    uv run python scripts/ingest.py --file meeting_notes/sprint1.md --project-id 1

    # 청크 크기 변경
    uv run python scripts/ingest.py --file ... --project-id 1 --chunk-size 400 --chunk-overlap 80

    # 임베딩 모델 변경 (컬렉션 자동 분리)
    uv run python scripts/ingest.py --file ... --project-id 1 --embed-model text-embedding-3-large

    # LangSmith 트레이싱
    LANGCHAIN_TRACING_V2=true LANGCHAIN_API_KEY=ls__... uv run python scripts/ingest.py ...
"""
import argparse
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).parent.parent))
from scripts._config import (
    DEFAULT_EMBED_MODEL, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP,
    collection_name, print_config,
)


def main():
    parser = argparse.ArgumentParser(description="PaiM 문서 인제스트 (eval용)")
    parser.add_argument("--file", required=True, help="인제스트할 파일 경로 (.md / .txt / .pdf)")
    parser.add_argument("--project-id", type=int, required=True, help="프로젝트 ID")
    parser.add_argument("--doc-type", default="meeting", help="문서 유형 (기본: meeting)")
    parser.add_argument("--date", default="", help="문서 날짜 YYYY-MM-DD")
    parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE, help=f"청크 크기 문자 수 (기본: {DEFAULT_CHUNK_SIZE})")
    parser.add_argument("--chunk-overlap", type=int, default=DEFAULT_CHUNK_OVERLAP, help=f"청크 오버랩 문자 수 (기본: {DEFAULT_CHUNK_OVERLAP})")
    parser.add_argument("--embed-model", default=DEFAULT_EMBED_MODEL, help=f"임베딩 모델 (기본: {DEFAULT_EMBED_MODEL})")
    args = parser.parse_args()

    col = collection_name(args.embed_model, args.chunk_size)

    # backend import 전에 env var 설정
    os.environ["EMBED_MODEL"] = args.embed_model
    os.environ["CHROMA_COLLECTION_NAME"] = col

    print_config(
        embed_model=args.embed_model,
        chunk_size=args.chunk_size,
        chunk_overlap=args.chunk_overlap,
        langsmith=os.getenv("LANGCHAIN_TRACING_V2") == "true",
    )

    filepath = Path(args.file)
    if not filepath.exists():
        print(f"[오류] 파일을 찾을 수 없습니다: {filepath}", file=sys.stderr)
        sys.exit(1)

    suffix = filepath.suffix.lower()
    if suffix == ".pdf":
        import io
        from pypdf import PdfReader
        content = "\n".join(
            page.extract_text() or ""
            for page in PdfReader(io.BytesIO(filepath.read_bytes())).pages
        )
    else:
        content = filepath.read_text(encoding="utf-8", errors="replace")

    if not content.strip():
        print("[오류] 파일 내용이 비어 있습니다.", file=sys.stderr)
        sys.exit(1)

    from backend.db.mysql import get_connection
    from backend.pipeline.extractor import extract
    from backend.pipeline.ingestor import ingest

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM projects WHERE id = %s", (args.project_id,))
            if not cur.fetchone():
                print(f"[오류] project_id={args.project_id} 가 존재하지 않습니다.", file=sys.stderr)
                sys.exit(1)
            cur.execute(
                "INSERT INTO documents (project_id, filename, doc_type, status) VALUES (%s, %s, %s, 'processing')",
                (args.project_id, filepath.name, args.doc_type),
            )
            doc_id = cur.lastrowid
        conn.commit()
    finally:
        conn.close()

    print(f"[1/3] 추출 중... (doc_id={doc_id}, file={filepath.name})")
    items = extract(content, default_source=filepath.name)
    counts = {"decision": 0, "action": 0, "issue": 0, "risk": 0}
    for item in items:
        if item.category in counts:
            counts[item.category] += 1
    print(f"      추출 결과: {counts}")

    print(f"[2/3] 인제스트 중... → 컬렉션: {col}")
    ingest(
        project_id=args.project_id,
        doc_id=doc_id,
        items=items,
        raw_text=content,
        source=filepath.name,
        date=args.date,
        doc_type=args.doc_type,
        source_metadata={"source_kind": "document", "source_type": args.doc_type, "source_path": filepath.name},
        chunk_size=args.chunk_size,
        chunk_overlap=args.chunk_overlap,
    )

    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE documents SET status='indexed' WHERE id=%s", (doc_id,))
        conn.commit()
    finally:
        conn.close()

    print(f"[3/3] 완료. doc_id={doc_id}, collection={col}")


if __name__ == "__main__":
    main()
