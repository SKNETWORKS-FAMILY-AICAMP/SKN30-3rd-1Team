from typing import List, Dict
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..db.mysql import get_connection
from ..pipeline.extractor import extract
from ..pipeline.ingestor import ingest
from ..graph import update_project_memory, run_qa
from .upload import _delete_document

router = APIRouter()


class QueryRequest(BaseModel):
    question: str
    history: List[Dict] = []


@router.post("/projects/{project_id}/query")
def query(project_id: int, body: QueryRequest):
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Project not found")
    finally:
        conn.close()

    # 출력 그래프(run_qa) 실행 → {answer, plan, sources, debug}
    # 기존 answer()와 달리 프로젝트 메모리 읽기 + 자동 todo(plan) + 검증 루프가 포함된다.
    try:
        return run_qa(
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

    # 프로젝트 메모리 갱신 (best-effort — 요약 실패해도 업로드는 성공 처리)
    try:
        update_project_memory(project_id, items)
    except Exception:
        import logging
        logging.getLogger(__name__).warning(
            "프로젝트 메모리 갱신 실패 (git 업로드는 성공): project_id=%s", project_id, exc_info=True
        )

    counts = {"decision": 0, "action": 0, "issue": 0, "risk": 0}
    for item in items:
        counts[item.category] += 1

    return {"doc_id": doc_id, "extracted": counts}
