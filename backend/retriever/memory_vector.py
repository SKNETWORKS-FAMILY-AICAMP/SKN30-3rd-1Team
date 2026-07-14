"""memory 행을 ChromaDB에 보조 인덱싱한다."""
from typing import Dict, Iterable, List, Optional, Set

from ..db.chroma import get_collection
from ..db.mysql import get_connection

_NO_ID = -1


def memory_vector_id(memory_id: int) -> str:
    """memory_id 기반 ChromaDB id."""
    return f"memory:{memory_id}"


def format_memory_document(row: Dict) -> str:
    """memory row를 의미 검색용 짧은 문서로 만든다."""
    parts = [
        f"분류: {row.get('category') or ''}",
        f"내용: {row.get('content') or ''}",
    ]
    if row.get("topic"):
        parts.append(f"주제: {row['topic']}")
    if row.get("reason"):
        parts.append(f"근거: {row['reason']}")
    if row.get("owner"):
        parts.append(f"담당: {row['owner']}")
    if row.get("due_date"):
        parts.append(f"마감: {str(row['due_date'])[:10]}")
    if row.get("completed_at"):
        parts.append(f"완료: {str(row['completed_at'])[:10]}")
    return "\n".join(parts)


def _metadata(row: Dict) -> Dict:
    """문서/저장소 삭제 정합성을 위해 doc_id/repo_id도 같이 저장한다."""
    return {
        "item_type": "memory",
        "project_id": row["project_id"],
        "memory_id": row["id"],
        "doc_id": row.get("doc_id") if row.get("doc_id") is not None else _NO_ID,
        "repo_id": row.get("repo_id") if row.get("repo_id") is not None else _NO_ID,
        "category": row.get("category") or "",
        "owner": row.get("owner") or "",
        "source": row.get("source") or "",
    }


def upsert_memory_vector(row: Dict) -> None:
    """memory row 하나를 ChromaDB에 upsert한다."""
    get_collection().upsert(
        ids=[memory_vector_id(row["id"])],
        documents=[format_memory_document(row)],
        metadatas=[_metadata(row)],
    )


def upsert_memory_vectors(rows: Iterable[Dict]) -> int:
    """memory row 여러 개를 ChromaDB에 upsert한다."""
    rows = list(rows)
    if not rows:
        return 0
    get_collection().upsert(
        ids=[memory_vector_id(row["id"]) for row in rows],
        documents=[format_memory_document(row) for row in rows],
        metadatas=[_metadata(row) for row in rows],
    )
    return len(rows)


def find_similar_memories(
    project_id: int,
    text: str,
    category: Optional[str] = None,
    n_results: int = 5,
    exclude_ids: Optional[Set[int]] = None,
) -> List[int]:
    """의미 유사한 memory 후보의 memory_id 목록을 ChromaDB에서 조회한다.

    supersede 판별의 후보 recall에 사용. 같은 project·item_type=memory 범위에서
    category까지 좁혀 검색하고, exclude_ids(자기 자신 등)는 제외한 memory_id를 반환한다.
    """
    if not (text or "").strip():
        return []

    exclude = exclude_ids or set()

    conditions: List[Dict] = [{"project_id": project_id}, {"item_type": "memory"}]
    if category:
        conditions.append({"category": category})
    # 제외 대상을 쿼리 단계에서 걸러 top-N 슬롯을 소모하지 않게 한다. 사후 필터로만 제외하면
    # 방금 upsert한 신규 decision(자기 자신)이 상위 결과를 차지해 실제 기존 후보가 밀려날 수 있다.
    if exclude:
        conditions.append({"memory_id": {"$nin": sorted(exclude)}})
    where = conditions[0] if len(conditions) == 1 else {"$and": conditions}

    results = get_collection().query(
        query_texts=[text],
        where=where,
        n_results=n_results,
    )
    metas = (results.get("metadatas") or [[]])[0]
    ids: List[int] = []
    seen: Set[int] = set()
    for meta in metas:
        mid = (meta or {}).get("memory_id")
        if mid is None:
            continue
        mid = int(mid)
        if mid in exclude or mid in seen:
            continue
        seen.add(mid)
        ids.append(mid)
    return ids


def delete_memory_vector(memory_id: int) -> None:
    """memory_id에 해당하는 ChromaDB memory 벡터를 삭제한다."""
    get_collection().delete(ids=[memory_vector_id(memory_id)])


def cleanup_orphan_memory_vectors() -> int:
    """MySQL에 없는 project_id/memory_id를 가리키는 memory 벡터를 삭제한다."""
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM projects")
            project_ids = {row["id"] for row in cursor.fetchall()}
            cursor.execute("SELECT id FROM memory")
            memory_ids = {row["id"] for row in cursor.fetchall()}
    finally:
        conn.close()

    collection = get_collection()
    raw = collection.get()
    delete_ids = []
    for vector_id, metadata in zip(raw.get("ids") or [], raw.get("metadatas") or []):
        metadata = metadata or {}
        if not (str(vector_id).startswith("memory:") or metadata.get("item_type") == "memory"):
            continue
        if metadata.get("project_id") not in project_ids or metadata.get("memory_id") not in memory_ids:
            delete_ids.append(vector_id)

    if delete_ids:
        collection.delete(ids=delete_ids)
    return len(delete_ids)


def backfill_memory_vectors() -> int:
    """아직 ChromaDB에 없는 기존 memory row만 1회 백필한다."""
    cleanup_orphan_memory_vectors()

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT * FROM memory ORDER BY id ASC")
            rows = cursor.fetchall()
    finally:
        conn.close()

    if not rows:
        return 0

    ids = [memory_vector_id(row["id"]) for row in rows]
    collection = get_collection()
    existing = set(collection.get(ids=ids).get("ids") or [])
    missing = [row for row in rows if memory_vector_id(row["id"]) not in existing]
    return upsert_memory_vectors(missing)
