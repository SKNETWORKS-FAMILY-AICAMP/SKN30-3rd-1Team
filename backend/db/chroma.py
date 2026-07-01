import os
import chromadb
from chromadb.utils import embedding_functions

_client = None
_collection = None


def get_collection():
    global _client, _collection
    if _collection is None:
        persist_dir = os.getenv("CHROMA_PERSIST_DIR", ".chroma")
        _client = chromadb.PersistentClient(path=persist_dir)
        # 임베딩은 OpenAI(text-embedding-3-small) 사용 — 한국어 검색 품질 확보.
        # 검색측(qa_engine)도 반드시 같은 모델을 써야 벡터가 맞으므로 EMBED_MODEL로 공유한다.
        openai_ef = embedding_functions.OpenAIEmbeddingFunction(
            api_key=os.getenv("OPENAI_API_KEY"),
            model_name=os.getenv("EMBED_MODEL", "text-embedding-3-small"),
        )
        _collection = _client.get_or_create_collection("paiM", embedding_function=openai_ef)
    return _collection
