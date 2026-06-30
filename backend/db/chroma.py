import os
import chromadb

_client = None
_collection = None


def get_collection():
    global _client, _collection
    if _collection is None:
        persist_dir = os.getenv("CHROMA_PERSIST_DIR", ".chroma")
        _client = chromadb.PersistentClient(path=persist_dir)
        _collection = _client.get_or_create_collection("paiM")
    return _collection
