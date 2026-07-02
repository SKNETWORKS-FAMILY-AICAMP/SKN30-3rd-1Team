"""질의 CLI — 검색 품질 테스트 및 모델 비교용.

컬렉션명은 --embed-model + --chunk-size 조합으로 자동 결정됩니다.
인제스트할 때와 동일한 설정을 사용해야 벡터가 맞습니다.

사용 예시:
    # 기본 설정으로 질의
    uv run python scripts/query.py --project-id 1 --question "현재 리스크가 뭐야?"

    # 임베딩/청크 설정 맞춰서 질의
    uv run python scripts/query.py --project-id 1 --question "..." \
        --embed-model text-embedding-3-large --chunk-size 400

    # LLM 변경 (재인덱싱 불필요)
    uv run python scripts/query.py --project-id 1 --question "..." \
        --llm-provider claude
    uv run python scripts/query.py --project-id 1 --question "..." \
        --llm-provider openai --llm-model gpt-4o

    # LangSmith 트레이싱 + 디버그
    LANGCHAIN_TRACING_V2=true LANGCHAIN_API_KEY=ls__... \
        uv run python scripts/query.py --project-id 1 --question "..." --debug
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
    parser = argparse.ArgumentParser(description="PaiM 질의 CLI (eval용)")
    parser.add_argument("--project-id", type=int, required=True, help="프로젝트 ID")
    parser.add_argument("--question", required=True, help="질문")
    parser.add_argument("--embed-model", default=DEFAULT_EMBED_MODEL, help=f"임베딩 모델 (기본: {DEFAULT_EMBED_MODEL})")
    parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE, help=f"인제스트 당시 청크 크기 (컬렉션 결정에 사용, 기본: {DEFAULT_CHUNK_SIZE})")
    parser.add_argument("--llm-provider", default=None, help="LLM provider (openai / claude / google / local)")
    parser.add_argument("--llm-model", default=None, help="LLM 모델명 (예: gpt-4o, claude-opus-4-8)")
    parser.add_argument("--search-mode", default="both", choices=["both", "sql", "vector"],
                        help="검색 모드: both(기본) | sql(MySQL만) | vector(ChromaDB만)")
    parser.add_argument("--debug", action="store_true", help="MySQL rows / ChromaDB chunks 상세 출력")
    args = parser.parse_args()

    col = collection_name(args.embed_model, args.chunk_size)

    # backend import 전에 env var 설정
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

    from backend.graph import run_qa

    print(f"[질문] {args.question}")
    print(f"[검색] {args.search_mode}\n")
    print("처리 중...")

    result = run_qa(project_id=args.project_id, question=args.question, search_mode=args.search_mode)

    print(f"\n[답변]\n{result['answer']}")

    if result.get("plan"):
        print(f"\n[TODO Plan]")
        for item in result["plan"]:
            print(f"  - {item}")

    if result.get("sources"):
        print(f"\n[출처] {', '.join(result['sources'])}")

    if args.debug and result.get("debug"):
        debug = result["debug"]
        print(f"\n[디버그] 필터: {debug.get('filters')}")
        print(f"  MySQL rows ({len(debug.get('mysql_rows', []))}건):")
        for r in debug.get("mysql_rows", []):
            print(f"    [{r['category']}] {r['content'][:80]} (출처: {r['source']})")
        print(f"  ChromaDB chunks ({len(debug.get('chroma_chunks', []))}건):")
        for c in debug.get("chroma_chunks", []):
            print(f"    {c['text'][:80]}... (출처: {c['source']}, 날짜: {c['date']})")


if __name__ == "__main__":
    main()
