import json
import logging

from fastapi import APIRouter, HTTPException

from ..db.mysql import get_connection
from .auth import get_current_user_id, require_project_access

logger = logging.getLogger(__name__)

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


# suggestion.kind별로 대상 memory가 가져야 하는 category — accept 시 잘못된 대상 방지.
_KIND_TARGET_CATEGORY = {
    "complete_action": "action",
    "supersede": "decision",
}


def _suggestion_or_404(cursor, project_id: int, suggestion_id: int) -> dict:
    """프로젝트에 속한 suggestion과 대상 memory 상태를 함께 조회한다.

    kind에 따라 대상 memory의 category가 달라지므로(action/decision) category 필터는
    SQL이 아니라 조회 후 kind 기준으로 검증한다.
    """
    cursor.execute(
        "SELECT s.*, m.category AS memory_category,"
        " m.completed_at AS memory_completed_at,"
        " m.superseded_by AS memory_superseded_by"
        " FROM memory_suggestions s"
        " JOIN memory m ON m.id = s.memory_id AND m.project_id = s.project_id"
        " WHERE s.id = %s AND s.project_id = %s",
        (suggestion_id, project_id),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    expected = _KIND_TARGET_CATEGORY.get(row["kind"])
    if expected is not None and row.get("memory_category") != expected:
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


def _apply_accepted_effect(cursor, project_id: int, row: dict) -> None:
    """accept 시 suggestion.kind에 따라 대상 memory에 효과를 반영한다.

    - complete_action: 미완료 action이면 completed_at=NOW().
    - supersede: 아직 살아있는 decision이면 superseded_by=evidence.superseding_memory_id,
      superseded_at=NOW() 설정(계층1 필터가 이때부터 실효).
    지원하지 않는 kind는 명시적으로 거부한다 — 알 수 없는 kind가 기본 분기로 흘러
    엉뚱한 대상에 completed_at을 설정하는 것을 막는다.
    """
    kind = row["kind"]
    if kind == "supersede":
        evidence = _decode_evidence(row["evidence"]) or {}
        superseding_id = evidence.get("superseding_memory_id")
        if superseding_id is None:
            raise HTTPException(status_code=400, detail="Supersede evidence missing target")
        # 대체(신) 항목을 트랜잭션 안에서 검증 — 제안 생성 후 상태가 바뀌었을 수 있다.
        #   존재+project: 삭제/재동기화로 사라진 id로 기존 decision을 숨기지 않도록.
        #   category='decision': 사용자가 대체 row를 action 등으로 수정한 경우 거부.
        #   superseded_by IS NULL: 이미 번복된 decision은 대체자가 될 수 없다(순환 가드 —
        #     A→B accept 후 B→A를 accept하면 둘 다 숨어 해당 주제 결정이 전멸한다).
        cursor.execute(
            "SELECT id FROM memory WHERE id = %s AND project_id = %s"
            " AND category = 'decision' AND superseded_by IS NULL",
            (superseding_id, project_id),
        )
        if not cursor.fetchone():
            raise HTTPException(
                status_code=409,
                detail="Superseding decision no longer exists or is not a live decision",
            )
        current = row.get("memory_superseded_by")
        if current is not None:
            # 같은 대상으로 이미 처리됐으면 멱등, 다른 대상이면 충돌로 거부해
            # API 승인 이력과 실제 superseded_by 불일치를 방지한다.
            if int(current) == int(superseding_id):
                return
            raise HTTPException(status_code=409, detail="Decision already superseded by another decision")
        # 조건부 UPDATE + rowcount 확인: 읽은 뒤 다른 요청이 먼저 설정한 경합도 충돌로 거부.
        cursor.execute(
            "UPDATE memory SET superseded_by = %s, superseded_at = NOW(), updated_by = 'user'"
            " WHERE id = %s AND project_id = %s AND superseded_by IS NULL",
            (superseding_id, row["memory_id"], project_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=409, detail="Decision already superseded by another decision")
        return

    if kind == "complete_action":
        # 미완료 action 완료 처리.
        if not row.get("memory_completed_at"):
            cursor.execute(
                "UPDATE memory SET completed_at = NOW(), updated_by = 'user'"
                " WHERE id = %s AND project_id = %s",
                (row["memory_id"], project_id),
            )
        return

    raise HTTPException(status_code=400, detail="Unsupported suggestion kind")


def _resolve_suggestion(project_id: int, suggestion_id: int, status: str) -> dict:
    """suggestion을 accepted/rejected로 닫고, accepted면 kind별 효과를 대상 memory에 반영한다."""
    # 상태를 변경하는 동작이므로 member 이상 권한 필요 — 타 프로젝트 무단 조작(IDOR) 방지.
    require_project_access(project_id, min_role="member")
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            row = _suggestion_or_404(cursor, project_id, suggestion_id)
            if row["status"] != "pending":
                raise HTTPException(status_code=400, detail="Suggestion already resolved")

            if status == "accepted":
                _apply_accepted_effect(cursor, project_id, row)

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

    # supersede accept가 확정되면 번복된 decision의 벡터를 제거해 벡터 상태를 MySQL과 동기화한다.
    # 그러지 않으면 비활성(superseded) 벡터가 이후 supersede 후보 검색의 top-N 슬롯을 계속 차지해
    # 유효 후보를 밀어낼 수 있다(commit 이후 best-effort — 실패해도 accept 결과는 유지).
    if status == "accepted" and row["kind"] == "supersede":
        try:
            from ..retriever.memory_vector import delete_memory_vector
            delete_memory_vector(row["memory_id"])
        except Exception:
            logger.warning("superseded 벡터 삭제 실패 memory_id=%s", row["memory_id"], exc_info=True)

    return _suggestion_response(updated)


@router.post("/projects/{project_id}/suggestions/{suggestion_id}/accept")
def accept_suggestion(project_id: int, suggestion_id: int):
    return _resolve_suggestion(project_id, suggestion_id, "accepted")


@router.post("/projects/{project_id}/suggestions/{suggestion_id}/reject")
def reject_suggestion(project_id: int, suggestion_id: int):
    return _resolve_suggestion(project_id, suggestion_id, "rejected")
