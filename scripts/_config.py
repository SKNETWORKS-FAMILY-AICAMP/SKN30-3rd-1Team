"""eval 스크립트 공통 설정 헬퍼."""
from backend.pipeline.ingestor import CHUNK_SIZE, CHUNK_OVERLAP


DEFAULT_EMBED_MODEL = "text-embedding-3-small"
DEFAULT_CHUNK_SIZE = CHUNK_SIZE
DEFAULT_CHUNK_OVERLAP = CHUNK_OVERLAP


def collection_name(embed_model: str, chunk_size: int) -> str:
    """임베딩 모델 + 청크 크기 조합으로 컬렉션명 자동 생성.

    예시:
        text-embedding-3-small, 600  → paiM_3small_c600
        text-embedding-3-large, 400  → paiM_3large_c400
        text-embedding-ada-002, 600  → paiM_ada002_c600
    """
    short = embed_model.replace("text-embedding-", "").replace("-", "")
    return f"paiM_{short}_c{chunk_size}"


def print_config(embed_model: str, chunk_size: int, chunk_overlap: int,
                 llm_provider: str = None, llm_model: str = None, langsmith: bool = False):
    """실험 설정 출력."""
    import os
    print("\n[실험 설정]")
    print(f"  EMBED_MODEL   : {embed_model}")
    print(f"  COLLECTION    : {collection_name(embed_model, chunk_size)}")
    print(f"  CHUNK_SIZE    : {chunk_size}")
    print(f"  CHUNK_OVERLAP : {chunk_overlap}")
    if llm_provider:
        print(f"  LLM_PROVIDER  : {llm_provider}")
    if llm_model:
        print(f"  LLM_MODEL     : {llm_model}")
    is_on = os.getenv("LANGCHAIN_TRACING_V2") == "true" or os.getenv("LANGSMITH_TRACING") == "true"
    project = os.getenv("LANGCHAIN_PROJECT") or os.getenv("LANGSMITH_PROJECT", "(기본)")
    print(f"  LANGSMITH     : {'ON ✓  project=' + project if is_on else 'OFF'}")
    print()
