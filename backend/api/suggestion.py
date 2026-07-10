import json

from fastapi import APIRouter, HTTPException

from ..db.mysql import get_connection
from .auth import get_current_user_id, require_project_access

router = APIRouter()

_STATUSES = {"pending", "accepted", "rejected"}


def _decode_evidence(value):
    """MySQL JSON 반환값을 API 응답용 dict로 정규화한다."""
    if isinstance(value, dict):
        return value
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    if isinstance(value, str):
        return json.loads(value)
    return value


def _suggestion_response(row: dict) -> dict:
    """DB row를 suggestions API 응답 형태로 변환한다."""
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "memory_id": row["memory_id"],
        "kind": row["kind"],
        "evidence": _decode_evidence(row["evidence"]),
        "rationale": row["rationale"],
        "confidence": row["confidence"],
        "status": row["status"],
        "created_at": row["created_at"],
        "resolved_at": row.get("resolved_at"),
        "resolved_by": row.get("resolved_by"),
    }


def _suggestion_or_404(cursor, project_id: int, suggestion_id: int) -> dict:
    """프로젝트에 속한 suggestion과 대상 action을 함께 조회한다."""
    cursor.execute(
        "SELECT s.*, m.completed_at AS memory_completed_at"
        " FROM memory_suggestions s"
        " JOIN memory m ON m.id = s.memory_id AND m.project_id = s.project_id"
        " WHERE s.id = %s AND s.project_id = %s AND m.category = 'action'",
        (suggestion_id, project_id),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    return row


@router.get("/projects/{project_id}/suggestions")
def list_suggestions(project_id: int, status: str = "pending"):
    require_project_access(project_id)
    if status not in _STATUSES:
        raise HTTPException(status_code=400, detail="Invalid suggestion status")

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Project not found")
            cursor.execute(
                "SELECT * FROM memory_suggestions"
                " WHERE project_id = %s AND status = %s"
                " ORDER BY created_at DESC",
                (project_id, status),
            )
            return [_suggestion_response(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def _resolve_suggestion(project_id: int, suggestion_id: int, status: str) -> dict:
    """suggestion을 accepted/rejected로 닫고, accepted면 대상 action 완료일을 보장한다."""
    # 상태를 변경하는 동작이므로 member 이상 권한 필요 — 타 프로젝트 무단 조작(IDOR) 방지.
    require_project_access(project_id, min_role="member")
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            row = _suggestion_or_404(cursor, project_id, suggestion_id)
            if row["status"] != "pending":
                raise HTTPException(status_code=400, detail="Suggestion already resolved")

            if status == "accepted" and not row.get("memory_completed_at"):
                cursor.execute(
                    "UPDATE memory SET completed_at = NOW(), updated_by = 'user'"
                    " WHERE id = %s AND project_id = %s",
                    (row["memory_id"], project_id),
                )

            cursor.execute(
                "UPDATE memory_suggestions SET status = %s, resolved_at = NOW(), resolved_by = %s"
                " WHERE id = %s AND project_id = %s",
                (status, get_current_user_id(), suggestion_id, project_id),
            )
            cursor.execute(
                "SELECT * FROM memory_suggestions WHERE id = %s AND project_id = %s",
                (suggestion_id, project_id),
            )
            updated = cursor.fetchone() or {**row, "status": status}
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return _suggestion_response(updated)


@router.post("/projects/{project_id}/suggestions/{suggestion_id}/accept")
def accept_suggestion(project_id: int, suggestion_id: int):
    return _resolve_suggestion(project_id, suggestion_id, "accepted")


@router.post("/projects/{project_id}/suggestions/{suggestion_id}/reject")
def reject_suggestion(project_id: int, suggestion_id: int):
    return _resolve_suggestion(project_id, suggestion_id, "rejected")
