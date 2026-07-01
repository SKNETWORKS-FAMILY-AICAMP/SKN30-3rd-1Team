import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..db.mysql import get_connection
from ..pipeline.extractor import extract
from ..pipeline.ingestor import ingest
from ..graph import update_project_memory

router = APIRouter()
logger = logging.getLogger(__name__)


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

    # 1단계: 기존 문서 ID 조회만 (삭제 없음) + 프로젝트 존재 확인
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
            # fetchall: 과거 중복 row가 여러 개 있어도 전부 수집
            old_doc_ids = [row[0] for row in cursor.fetchall()]
    finally:
        conn.close()

    source = body.source or body.filename

    # 2단계: 추출 먼저 수행 — 실패 시 기존 데이터 무결
    items = extract(body.content, default_source=source)

    # 3단계: 신규 문서 INSERT
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "INSERT INTO documents (project_id, filename, doc_type) VALUES (%s, %s, %s)",
                (project_id, body.filename, body.doc_type),
            )
            doc_id = cursor.lastrowid
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    # 4단계: ingest — 실패 시 신규 doc 롤백, 기존 doc은 무결
    try:
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

    # 5단계: 성공 확정 후 기존 문서 전체 정리 (실패해도 신규 문서는 이미 저장됨)
    for old_id in old_doc_ids:
        _delete_document(old_id)

    # 6단계: 프로젝트 메모리 갱신 (best-effort — 요약 실패해도 업로드는 성공 처리)
    try:
        update_project_memory(project_id, items)
    except Exception:
        logger.warning("프로젝트 메모리 갱신 실패 (업로드는 성공): project_id=%s", project_id, exc_info=True)

    counts = {"decision": 0, "action": 0, "issue": 0, "risk": 0}
    for item in items:
        counts[item.category] += 1

    return {"doc_id": doc_id, "extracted": counts}


def _delete_chroma_vectors(doc_id: int):
    try:
        from ..db.chroma import get_collection
        collection = get_collection()
        collection.delete(where={"doc_id": doc_id})
    except Exception:
        logger.warning("ChromaDB vector cleanup failed for doc_id=%s", doc_id, exc_info=True)


def _delete_document(doc_id: int):
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("DELETE FROM memory WHERE doc_id = %s", (doc_id,))
            cursor.execute("DELETE FROM documents WHERE id = %s", (doc_id,))
        conn.commit()
    except Exception:
        logger.warning("MySQL delete failed for doc_id=%s", doc_id, exc_info=True)
    finally:
        conn.close()
    _delete_chroma_vectors(doc_id)


@router.get("/projects/{project_id}/memory")
def get_memory(project_id: int, category: str = None, owner: str = None):
    from ..retriever.mysql_search import search
    return search(project_id, category=category, owner=owner)
