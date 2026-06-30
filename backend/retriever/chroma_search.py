from typing import List, Dict
from ..db.chroma import get_collection


def search(project_id: int, query: str, n_results: int = 5) -> List[Dict]:
    collection = get_collection()
    results = collection.query(
        query_texts=[query],
        where={"project_id": project_id},
        n_results=n_results,
    )

    docs = results.get("documents", [[]])[0]
    metas = results.get("metadatas", [[]])[0]

    return [
        {"text": doc, "metadata": meta}
        for doc, meta in zip(docs, metas)
    ]
