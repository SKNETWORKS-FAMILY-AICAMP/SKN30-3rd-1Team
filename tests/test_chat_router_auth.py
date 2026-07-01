"""backend/chat/router.py가 require_project_access()를 올바르게 호출하는지 검증.

require_project_access를 mock으로 대체해 즉시 403을 발생시키면,
DB 접근 전에 함수가 중단되므로 db=None을 전달해도 안전하게 호출 여부를 확인할 수 있다.
"""
import pathlib
import pytest
from fastapi import HTTPException


def _reject_all(project_id, min_role="viewer"):
    raise HTTPException(status_code=403, detail="test: access denied")


def _reject_non_member(project_id, min_role="viewer"):
    if min_role == "member":
        raise HTTPException(status_code=403, detail="test: member required")


# ── migrate_v2.sql smoke ─────────────────────────────────────────────────────

def test_migrate_v2_includes_chat_tables():
    """migrate_v2.sql에 chat_sessions / chat_messages / chat_summaries CREATE 구문이 있어야 한다."""
    sql = pathlib.Path("backend/db/migrate_v2.sql").read_text()
    for table in ("chat_sessions", "chat_messages", "chat_summaries"):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in sql, \
            f"migrate_v2.sql에 {table} 테이블 생성 구문이 없습니다."


# ── require_project_access 호출 검증 ─────────────────────────────────────────

def test_create_session_blocked_without_member_role(monkeypatch):
    """세션 생성은 member 이상 권한이 필요 — require_project_access(min_role='member') 호출 확인."""
    monkeypatch.setattr("backend.chat.router.require_project_access", _reject_non_member)
    from backend.chat.router import create_chat_session, SessionCreateRequest

    with pytest.raises(HTTPException) as exc:
        create_chat_session(1, SessionCreateRequest(title="t"), db=None)
    assert exc.value.status_code == 403


def test_list_sessions_calls_require_project_access(monkeypatch):
    """세션 목록 조회는 require_project_access를 호출해야 한다."""
    monkeypatch.setattr("backend.chat.router.require_project_access", _reject_all)
    from backend.chat.router import get_chat_session_list

    with pytest.raises(HTTPException) as exc:
        get_chat_session_list(1, db=None)
    assert exc.value.status_code == 403


def test_update_session_blocked_without_member_role(monkeypatch):
    """세션 수정은 member 이상 권한이 필요."""
    monkeypatch.setattr("backend.chat.router.require_project_access", _reject_non_member)
    from backend.chat.router import update_chat_session, SessionUpdateRequest

    with pytest.raises(HTTPException) as exc:
        update_chat_session(1, "sess_abc", SessionUpdateRequest(title="new"), db=None)
    assert exc.value.status_code == 403


def test_delete_session_blocked_without_member_role(monkeypatch):
    """세션 삭제는 member 이상 권한이 필요."""
    monkeypatch.setattr("backend.chat.router.require_project_access", _reject_non_member)
    from backend.chat.router import delete_chat_session

    with pytest.raises(HTTPException) as exc:
        delete_chat_session(1, "sess_abc", db=None)
    assert exc.value.status_code == 403


def test_get_message_history_calls_require_project_access(monkeypatch):
    """메시지 이력 조회는 require_project_access를 호출해야 한다."""
    monkeypatch.setattr("backend.chat.router.require_project_access", _reject_all)
    from backend.chat.router import get_session_message_history

    with pytest.raises(HTTPException) as exc:
        get_session_message_history(1, "sess_abc", db=None)
    assert exc.value.status_code == 403


def test_session_query_blocked_without_member_role(monkeypatch):
    """세션 질의는 member 이상 권한이 필요."""
    monkeypatch.setattr("backend.chat.router.require_project_access", _reject_non_member)
    from backend.chat.router import handle_session_query, QueryRequest

    with pytest.raises(HTTPException) as exc:
        handle_session_query(1, "sess_abc", QueryRequest(current_question="질문"), db=None)
    assert exc.value.status_code == 403
