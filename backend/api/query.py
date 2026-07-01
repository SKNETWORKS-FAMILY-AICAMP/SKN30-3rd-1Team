from typing import List, Dict
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..retriever.qa_engine import answer
from ..db.mysql import get_connection
from ..pipeline.extractor import extract
from ..pipeline.ingestor import ingest
from .upload import _delete_document
from .auth import require_project_access

router = APIRouter()


class QueryRequest(BaseModel):
    question: str
    history: List[Dict] = []


@router.post("/projects/{project_id}/query")
def query(project_id: int, body: QueryRequest):
    require_project_access(project_id)
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Project not found")
    finally:
        conn.close()

    try:
        return answer(
            project_id=project_id,
            question=body.question,
            history=body.history,
        )
    except Exception as e:
        import logging
        logging.getLogger(__name__).error("Q&A 처리 오류: %s", e, exc_info=True)
        raise HTTPException(status_code=503, detail="Q&A 처리 중 오류가 발생했습니다. 서버 로그를 확인하세요.")


class GitLogUpload(BaseModel):
    content: str
    source: str = "git log"
    date: str = ""


@router.post("/projects/{project_id}/git", status_code=201)
def upload_git_log(project_id: int, body: GitLogUpload):
    # 동기 처리 — documents.status 추적 없음. 향후 /documents 엔드포인트로 통합 예정
    require_project_access(project_id, min_role="member")
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="content must not be empty")

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Project not found")
            cursor.execute(
                "INSERT INTO documents (project_id, filename, doc_type) VALUES (%s, %s, %s)",
                (project_id, "git_log.txt", "git"),
            )
            doc_id = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()

    try:
        items = extract(body.content, default_source=body.source)
        ingest(
            project_id=project_id,
            doc_id=doc_id,
            items=items,
            raw_text=body.content,
            source=body.source,
            date=body.date,
            doc_type="git",
        )
    except Exception:
        _delete_document(doc_id)
        raise

    counts = {"decision": 0, "action": 0, "issue": 0, "risk": 0}
    for item in items:
        counts[item.category] += 1

    return {"doc_id": doc_id, "extracted": counts}
