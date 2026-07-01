import os
import chromadb
from chromadb.utils import embedding_functions

_client = None
_collection = None

# 기존 chromadb 기본 임베딩(384-dim)과 분리하기 위해 별도 컬렉션명 사용.
# CHROMA_COLLECTION_NAME 미설정 시 "paiM_openai_v1" 사용.
# 기존 "paiM" 컬렉션 데이터를 재사용하려면 벡터를 전체 재인덱싱해야 한다.
_DEFAULT_COLLECTION = "paiM_openai_v1"


def get_collection():
    global _client, _collection
    if _collection is None:
        api_key = os.getenv("OPENAI_API_KEY", "")
        if not api_key or api_key.startswith("sk-placeholder"):
            raise RuntimeError(
                "OPENAI_API_KEY가 설정되지 않았습니다. "
                "벡터 임베딩에 OpenAI API key가 필요합니다."
            )
        persist_dir = os.getenv("CHROMA_PERSIST_DIR", ".chroma")
        collection_name = os.getenv("CHROMA_COLLECTION_NAME", _DEFAULT_COLLECTION)
        _client = chromadb.PersistentClient(path=persist_dir)
        # 임베딩은 OpenAI(text-embedding-3-small) 사용 — 한국어 검색 품질 확보.
        # 검색측(qa_engine)도 반드시 같은 모델을 써야 벡터가 맞으므로 EMBED_MODEL로 공유한다.
        openai_ef = embedding_functions.OpenAIEmbeddingFunction(
            api_key=api_key,
            model_name=os.getenv("EMBED_MODEL", "text-embedding-3-small"),
        )
        _collection = _client.get_or_create_collection(collection_name, embedding_function=openai_ef)
    return _collection
