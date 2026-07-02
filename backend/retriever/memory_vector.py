"""memory 행을 ChromaDB에 보조 인덱싱한다."""
from typing import Dict, Iterable

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


def delete_memory_vector(memory_id: int) -> None:
    """memory_id에 해당하는 ChromaDB memory 벡터를 삭제한다."""
    get_collection().delete(ids=[memory_vector_id(memory_id)])


def backfill_memory_vectors() -> int:
    """아직 ChromaDB에 없는 기존 memory row만 1회 백필한다."""
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
