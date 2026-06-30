from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..db.mysql import get_connection
from ..pipeline.extractor import extract
from ..pipeline.ingestor import ingest

router = APIRouter()


class DocumentUpload(BaseModel):
    filename: str
    doc_type: str
    content: str
    source: str = ""
    date: str = ""


@router.post("/projects/{project_id}/documents", status_code=201)
def upload_document(project_id: int, body: DocumentUpload):
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="content must not be empty")

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Project not found")
            cursor.execute(
                "SELECT id FROM documents WHERE project_id = %s AND filename = %s",
                (project_id, body.filename)
            )
            existing_doc = cursor.fetchone()
            if existing_doc:
                # 중복 방지를 위해 기존 도큐먼트 ID와 연관된 MySQL/ChromaDB 데이터 모두 삭제
                _delete_document(existing_doc[0])
            cursor.execute(
                "INSERT INTO documents (project_id, filename, doc_type) VALUES (%s, %s, %s)",
                (project_id, body.filename, body.doc_type),
            )
            doc_id = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()

    source = body.source or body.filename
    
    try:
        items = extract(body.content, default_source=source)
        ingest(
            project_id=project_id,
            doc_id=doc_id,
            items=items,
            raw_text=body.content,
            source=source,
            date=body.date,
            doc_type=body.doc_type,
        )
    except Exception:
        _delete_document(doc_id)
        raise

    counts = {"decision": 0, "action": 0, "issue": 0, "risk": 0}
    for item in items:
        counts[item.category] += 1

    return {"doc_id": doc_id, "extracted": counts}


def _delete_document(doc_id: int):
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("DELETE FROM memory WHERE doc_id = %s", (doc_id,))
            cursor.execute("DELETE FROM documents WHERE id = %s", (doc_id,))
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()
    try:
        from ..db.chroma import get_collection
        collection = get_collection()
        # 해당 doc_id를 메타데이터로 가진 벡터 삭제
        collection.delete(where={"doc_id": doc_id})
    except Exception:
        pass


@router.get("/projects/{project_id}/memory")
def get_memory(project_id: int, category: str = None, owner: str = None):
    from ..retriever.mysql_search import search
    return search(project_id, category=category, owner=owner)
