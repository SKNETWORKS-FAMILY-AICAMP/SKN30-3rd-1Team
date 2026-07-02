from typing import List, Dict
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..db.mysql import get_connection
from ..pipeline.extractor import extract
from ..pipeline.ingestor import ingest
from ..graph import update_project_memory, run_qa
from ..retriever.query_intent import (
    SemanticFallback,
    answer_filter_lookup,
    answer_overview,
    classify_question,
)
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

    # 질문 의도가 명확하면 SQL/조망형 경로를 쓰고, 아니면 기존 LangGraph RAG로 폴백한다.
    try:
        decision = classify_question(body.question, body.history)
        if decision.route == "filter_lookup":
            try:
                return answer_filter_lookup(
                    project_id, body.question, body.history, decision.router_stage
                )
            except SemanticFallback:
                pass
        elif decision.route == "overview":
            return answer_overview(project_id, body.question, decision.router_stage)

        result = run_qa(
            project_id=project_id,
            question=body.question,
            history=body.history,
        )
        result["route"] = "semantic"
        debug = result.get("debug") or {}
        debug["route"] = "semantic"
        debug["router_stage"] = decision.router_stage
        debug["router_model_tier"] = "fast" if decision.router_stage == "llm" else None
        result["debug"] = debug
        return result
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
