import io
import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from ..db.mysql import get_connection
from ..pipeline.extractor import extract
from ..pipeline.ingestor import ingest
from ..storage import save_file, delete_file
from .auth import require_project_access

router = APIRouter()
logger = logging.getLogger(__name__)

_ALLOWED_SUFFIXES = {".md", ".txt", ".pdf"}


# ── 파일 텍스트 추출 ──────────────────────────────────────────────

def _read_pdf(data: bytes) -> str:
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception:
        return ""


def _extract_text(filename: str, data: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        return _read_pdf(data)
    return data.decode("utf-8", errors="replace")


# ── 내부 헬퍼 ─────────────────────────────────────────────────────

def _delete_chroma_vectors(doc_id: int):
    try:
        from ..db.chroma import get_collection
        get_collection().delete(where={"doc_id": doc_id})
    except Exception:
        logger.warning("ChromaDB vector cleanup failed for doc_id=%s", doc_id, exc_info=True)


def _delete_document(doc_id: int):
    """MySQL memory/documents 행 삭제 + ChromaDB 벡터 삭제 + 원본 파일 삭제."""
    conn = get_connection()
    file_path = None
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT file_path FROM documents WHERE id = %s", (doc_id,))
            row = cursor.fetchone()
            if row:
                file_path = row.get("file_path")
            cursor.execute("DELETE FROM memory WHERE doc_id = %s", (doc_id,))
            cursor.execute("DELETE FROM documents WHERE id = %s", (doc_id,))
        conn.commit()
    except Exception:
        logger.warning("MySQL delete failed for doc_id=%s", doc_id, exc_info=True)
    finally:
        conn.close()
    _delete_chroma_vectors(doc_id)
    if file_path:
        delete_file(file_path)


def _delete_doc_memory(doc_id: int):
    """ingest 실패 시 부분 커밋된 memory 행 정리 (documents 행은 유지)."""
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("DELETE FROM memory WHERE doc_id = %s", (doc_id,))
        conn.commit()
    except Exception:
        logger.warning("memory cleanup failed doc_id=%s", doc_id, exc_info=True)
    finally:
        conn.close()


def _set_doc_status(doc_id: int, status: str, last_error: Optional[str] = None):
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "UPDATE documents SET status=%s, last_error=%s WHERE id=%s",
                (status, last_error, doc_id),
            )
        conn.commit()
    except Exception:
        logger.warning("documents status update failed doc_id=%s", doc_id, exc_info=True)
    finally:
        conn.close()


# ── 백그라운드 처리 ───────────────────────────────────────────────

def _process_upload(
    project_id: int,
    doc_id: int,
    old_doc_ids: list,
    content: str,
    filename: str,
    date: str,
    doc_type: str,
    file_path: str,
):
    """LLM extract → ingest → status 갱신 → 이전 문서 정리."""
    try:
        items = extract(content, default_source=filename)
    except Exception as exc:
        logger.error("extract 실패 doc_id=%s", doc_id, exc_info=True)
        delete_file(file_path)
        _set_doc_status(doc_id, "failed", last_error=str(exc))
        return

    try:
        ingest(
            project_id=project_id,
            doc_id=doc_id,
            items=items,
            raw_text=content,
            source=filename,
            date=date,
            doc_type=doc_type,
            source_metadata={
                "source_kind": "document",
                "source_type": doc_type,
                "source_path": filename,
            },
        )
    except Exception as exc:
        logger.error("ingest 실패 doc_id=%s", doc_id, exc_info=True)
        _delete_doc_memory(doc_id)
        _delete_chroma_vectors(doc_id)
        delete_file(file_path)
        _set_doc_status(doc_id, "failed", last_error=str(exc))
        return

    _set_doc_status(doc_id, "indexed")
    for old_id in old_doc_ids:
        _delete_document(old_id)


# ── Documents ─────────────────────────────────────────────────────

@router.post("/projects/{project_id}/documents", status_code=201)
async def upload_document(
    project_id: int,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    doc_type: str = Form(...),
    date: str = Form(""),
):
    require_project_access(project_id, min_role="member")
    filename = Path(file.filename).name
    if Path(filename).suffix.lower() not in _ALLOWED_SUFFIXES:
        raise HTTPException(status_code=400, detail="지원하지 않는 파일 형식입니다. (.md / .txt / .pdf)")

    data = await file.read()
    content = _extract_text(filename, data)
    if not content.strip():
        raise HTTPException(status_code=400, detail="content must not be empty")

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Project not found")
            cursor.execute(
                "SELECT id FROM documents WHERE project_id = %s AND filename = %s",
                (project_id, filename),
            )
            old_doc_ids = [row["id"] for row in cursor.fetchall()]
    finally:
        conn.close()

    file_path = save_file(project_id, filename, data)

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "INSERT INTO documents (project_id, filename, doc_type, status, file_path)"
                " VALUES (%s, %s, %s, 'processing', %s)",
                (project_id, filename, doc_type, file_path),
            )
            doc_id = cursor.lastrowid
        conn.commit()
    except Exception:
        conn.rollback()
        delete_file(file_path)
        raise
    finally:
        conn.close()

    background_tasks.add_task(
        _process_upload, project_id, doc_id, old_doc_ids,
        content, filename, date, doc_type, file_path,
    )

    return {"doc_id": doc_id, "status": "processing"}


@router.get("/projects/{project_id}/documents")
def list_documents(project_id: int):
    require_project_access(project_id)
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Project not found")
            cursor.execute(
                "SELECT id, filename, doc_type, status, uploaded_at"
                " FROM documents WHERE project_id = %s ORDER BY uploaded_at DESC",
                (project_id,),
            )
            return cursor.fetchall()
    finally:
        conn.close()


@router.get("/projects/{project_id}/documents/{doc_id}/status")
def get_document_status(project_id: int, doc_id: int):
    require_project_access(project_id)
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT id, status, last_error FROM documents WHERE id = %s AND project_id = %s",
                (doc_id, project_id),
            )
            row = cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Document not found")
            cursor.execute(
                "SELECT category, COUNT(*) as cnt FROM memory WHERE doc_id = %s GROUP BY category",
                (doc_id,),
            )
            counts = {"decision": 0, "action": 0, "issue": 0, "risk": 0}
            for r in cursor.fetchall():
                if r["category"] in counts:
                    counts[r["category"]] = r["cnt"]
    finally:
        conn.close()
    return {
        "doc_id": row["id"],
        "status": row["status"],
        "last_error": row.get("last_error"),
        "extracted": counts,
    }


@router.delete("/projects/{project_id}/documents/{doc_id}", status_code=204)
def delete_document(project_id: int, doc_id: int):
    require_project_access(project_id, min_role="member")
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT id FROM documents WHERE id = %s AND project_id = %s",
                (doc_id, project_id),
            )
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Document not found")
    finally:
        conn.close()
    _delete_document(doc_id)


# ── Memory ────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/memory")
def get_memory(project_id: int, category: str = None, owner: str = None):
    require_project_access(project_id)
    from ..retriever.mysql_search import search
    return search(project_id, category=category, owner=owner)


class MemoryCreate(BaseModel):
    category: str
    content: str
    owner: Optional[str] = None
    date: Optional[str] = None
    topic: Optional[str] = None
    reason: Optional[str] = None


@router.post("/projects/{project_id}/memory", status_code=201)
def create_memory(project_id: int, body: MemoryCreate):
    require_project_access(project_id, min_role="member")
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Project not found")
            cursor.execute(
                "INSERT INTO memory"
                " (project_id, doc_id, category, content, reason, topic, owner, date, created_by, is_user_verified)"
                " VALUES (%s, NULL, %s, %s, %s, %s, %s, %s, 'user', 1)",
                (project_id, body.category, body.content, body.reason, body.topic, body.owner, body.date or None),
            )
            memory_id = cursor.lastrowid
        conn.commit()
        with conn.cursor() as cursor:
            cursor.execute("SELECT * FROM memory WHERE id = %s", (memory_id,))
            return cursor.fetchone()
    finally:
        conn.close()


class MemoryUpdate(BaseModel):
    category: Optional[str] = None
    content: Optional[str] = None
    owner: Optional[str] = None
    date: Optional[str] = None
    topic: Optional[str] = None
    reason: Optional[str] = None


@router.patch("/projects/{project_id}/memory/{memory_id}")
def update_memory(project_id: int, memory_id: int, body: MemoryUpdate):
    require_project_access(project_id, min_role="member")
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=400, detail="수정할 필드가 없습니다.")

    fields["updated_by"] = "user"
    fields["is_user_verified"] = 1

    set_clause = ", ".join(f"{k} = %s" for k in fields)
    values = list(fields.values()) + [memory_id, project_id]

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                f"UPDATE memory SET {set_clause} WHERE id = %s AND project_id = %s",
                values,
            )
            if cursor.rowcount == 0:
                raise HTTPException(status_code=404, detail="Memory item not found")
        conn.commit()
        with conn.cursor() as cursor:
            cursor.execute("SELECT * FROM memory WHERE id = %s", (memory_id,))
            return cursor.fetchone()
    finally:
        conn.close()


@router.delete("/projects/{project_id}/memory/{memory_id}", status_code=204)
def delete_memory(project_id: int, memory_id: int):
    require_project_access(project_id, min_role="member")
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "DELETE FROM memory WHERE id = %s AND project_id = %s",
                (memory_id, project_id),
            )
            if cursor.rowcount == 0:
                raise HTTPException(status_code=404, detail="Memory item not found")
        conn.commit()
    finally:
        conn.close()
