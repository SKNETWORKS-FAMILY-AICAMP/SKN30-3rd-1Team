"""memory_suggestions API 계약 테스트."""
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from backend.main import app

_client = TestClient(app, raise_server_exceptions=False)


def _make_conn(fetchone=None, fetchall=None):
    cursor = MagicMock()
    cursor.fetchone.side_effect = fetchone if isinstance(fetchone, list) else None
    if not isinstance(fetchone, list):
        cursor.fetchone.return_value = fetchone
    cursor.fetchall.return_value = fetchall if fetchall is not None else []
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    conn.cursor.return_value.__exit__.return_value = False
    return conn, cursor


def _suggestion_row(status="pending", completed_at=None):
    return {
        "id": 7,
        "project_id": 1,
        "memory_id": 10,
        "kind": "complete_action",
        "evidence": '{"type":"pr","number":20,"title":"backend bridge","url":"https://github.com/o/r/pull/20","merged_at":"2026-07-01T10:00:00Z"}',
        "rationale": "PR #20이 FastAPI 연동 작업을 구현했습니다.",
        "confidence": "high",
        "status": status,
        "created_at": "2026-07-02 10:00:00",
        "resolved_at": None,
        "memory_completed_at": completed_at,
    }


def test_list_pending_suggestions_returns_evidence_and_rationale():
    """GET suggestions — pending 목록에 evidence/rationale 포함."""
    conn, _ = _make_conn(fetchone=[{"id": 1}], fetchall=[_suggestion_row()])
    with patch("backend.api.suggestion.require_project_access"), \
         patch("backend.api.suggestion.get_connection", return_value=conn):
        resp = _client.get("/api/v1/projects/1/suggestions")

    assert resp.status_code == 200
    body = resp.json()
    assert body[0]["evidence"]["number"] == 20
    assert body[0]["rationale"] == "PR #20이 FastAPI 연동 작업을 구현했습니다."


def test_accept_suggestion_completes_open_action_and_resolves_suggestion():
    """POST accept — 미완료 action은 completed_at=NOW(), suggestion은 accepted."""
    row = _suggestion_row(completed_at=None)
    updated = {**row, "status": "accepted", "resolved_at": "2026-07-02 11:00:00"}
    conn, cur = _make_conn(fetchone=[row, updated])
    with patch("backend.api.suggestion.require_project_access"), \
         patch("backend.api.suggestion.get_connection", return_value=conn):
        resp = _client.post("/api/v1/projects/1/suggestions/7/accept")

    assert resp.status_code == 200
    assert resp.json()["status"] == "accepted"
    sql_calls = [call.args[0] for call in cur.execute.call_args_list]
    assert any("UPDATE memory SET completed_at = NOW()" in sql for sql in sql_calls)
    assert any("UPDATE memory_suggestions SET status = %s" in sql for sql in sql_calls)


def test_accept_completed_action_only_resolves_suggestion():
    """POST accept — 이미 완료된 action이면 memory는 건드리지 않는다."""
    row = _suggestion_row(completed_at="2026-07-01 09:00:00")
    updated = {**row, "status": "accepted", "resolved_at": "2026-07-02 11:00:00"}
    conn, cur = _make_conn(fetchone=[row, updated])
    with patch("backend.api.suggestion.require_project_access"), \
         patch("backend.api.suggestion.get_connection", return_value=conn):
        resp = _client.post("/api/v1/projects/1/suggestions/7/accept")

    assert resp.status_code == 200
    sql_calls = [call.args[0] for call in cur.execute.call_args_list]
    assert not any("UPDATE memory SET completed_at = NOW()" in sql for sql in sql_calls)


def test_reject_suggestion_only_resolves_suggestion():
    """POST reject — action은 변경하지 않고 suggestion만 rejected."""
    row = _suggestion_row(completed_at=None)
    updated = {**row, "status": "rejected", "resolved_at": "2026-07-02 11:00:00"}
    conn, cur = _make_conn(fetchone=[row, updated])
    with patch("backend.api.suggestion.require_project_access"), \
         patch("backend.api.suggestion.get_connection", return_value=conn):
        resp = _client.post("/api/v1/projects/1/suggestions/7/reject")

    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"
    sql_calls = [call.args[0] for call in cur.execute.call_args_list]
    assert not any("UPDATE memory SET completed_at = NOW()" in sql for sql in sql_calls)


def test_resolve_suggestion_denies_viewer():
    """R-003: viewer는 accept/reject를 할 수 없다 (member 경계 검증).

    실제 require_project_access를 통과시키고 역할 조회만 viewer로 mock한다.
    이전 테스트는 require_project_access 호출 유무만 봐서, _resolve_suggestion이
    기본 viewer 권한으로 회귀해도 통과하는 맹점이 있었다. 실제 역할로 검증한다.
    """
    with patch("backend.api.auth.get_current_user_id", return_value=99), \
         patch("backend.api.auth.get_project_role", return_value="viewer"):
        accept = _client.post("/api/v1/projects/1/suggestions/7/accept")
        reject = _client.post("/api/v1/projects/1/suggestions/7/reject")

    assert accept.status_code == 403
    assert reject.status_code == 403


def test_resolve_suggestion_allows_member():
    """R-003: member는 accept/reject가 허용된다 (viewer 거부와 대칭 확인)."""
    row = _suggestion_row(completed_at=None)
    updated = {**row, "status": "accepted", "resolved_at": "2026-07-02 11:00:00"}
    conn, _ = _make_conn(fetchone=[row, updated])
    with patch("backend.api.auth.get_current_user_id", return_value=99), \
         patch("backend.api.auth.get_project_role", return_value="member"), \
         patch("backend.api.suggestion.get_connection", return_value=conn):
        accept = _client.post("/api/v1/projects/1/suggestions/7/accept")

    assert accept.status_code == 200
    assert accept.json()["status"] == "accepted"
