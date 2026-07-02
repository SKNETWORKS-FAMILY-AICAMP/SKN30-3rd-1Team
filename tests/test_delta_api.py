"""프로젝트 델타 API 계약 테스트."""
from datetime import date
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from backend.main import app

_client = TestClient(app, raise_server_exceptions=False)


def _make_conn(fetchone=None, fetchall=None):
    """fetchone/fetchall 호출 순서를 지정하는 cursor와 conn을 반환한다."""
    cursor = MagicMock()
    cursor.fetchone.side_effect = fetchone or []
    cursor.fetchall.side_effect = fetchall or []
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    conn.cursor.return_value.__exit__.return_value = False
    return conn, cursor


def test_delta_counts_since_boundary_and_due_buckets():
    """GET delta — created_at/completed_at은 since 초과, 마감은 현재 상태로 분류한다."""
    conn, cursor = _make_conn(
        fetchone=[{"id": 1}, {"cnt": 2}, {"cnt": 1}],
        fetchall=[
            [{"category": "decision", "cnt": 2}, {"category": "action", "cnt": 1}],
            [{"id": 10, "content": "곧 마감", "owner": "me", "due_date": date(2026, 7, 3)}],
            [{"id": 11, "content": "지남", "owner": None, "due_date": date(2026, 6, 30)}],
        ],
    )

    with patch("backend.api.delta.require_project_access"), \
         patch("backend.api.delta.get_connection", return_value=conn):
        resp = _client.get("/api/v1/projects/1/delta?since=2026-07-01T00:00:00Z&due_within_days=7")

    assert resp.status_code == 200
    body = resp.json()
    assert body["since"] == "2026-07-01T00:00:00Z"
    assert body["new_memory"] == {"decision": 2, "action": 1, "issue": 0, "risk": 0}
    assert body["pending_suggestions"] == 2
    assert body["completed_actions"] == 1
    assert body["due_soon"][0]["due_date"] == "2026-07-03"
    assert body["overdue"][0]["id"] == 11

    sql_calls = [call.args[0] for call in cursor.execute.call_args_list]
    assert any("created_at > %s" in sql for sql in sql_calls)
    assert any("completed_at > %s" in sql for sql in sql_calls)
    assert any("DATE_ADD(CURDATE(), INTERVAL %s DAY)" in sql for sql in sql_calls)
    assert any(call.args[1] == (1, 7) for call in cursor.execute.call_args_list)
    assert any("due_date < CURDATE()" in sql for sql in sql_calls)


def test_delta_briefing_no_changes_skips_llm():
    """POST briefing/delta — 변화가 없으면 LLM 없이 고정 응답을 반환한다."""
    conn, _ = _make_conn(
        fetchone=[{"id": 1}, {"cnt": 0}, {"cnt": 0}],
        fetchall=[[], [], []],
    )

    with patch("backend.api.delta.require_project_access"), \
         patch("backend.api.delta.get_connection", return_value=conn), \
         patch("backend.api.delta.get_chat_model") as get_chat_model:
        resp = _client.post(
            "/api/v1/projects/1/briefing/delta",
            json={"since": "2099-01-01T00:00:00Z"},
        )

    assert resp.status_code == 200
    assert resp.json() == {"answer": "지난 확인 이후 새 변화가 없습니다.", "sources": []}
    get_chat_model.assert_not_called()
