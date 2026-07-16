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
        fetchone=[{"id": 1}, {"cnt": 1}],
        fetchall=[
            [{"category": "decision", "cnt": 2}, {"category": "action", "cnt": 1}],
            [{"kind": "complete_action", "cnt": 2}, {"kind": "supersede", "cnt": 1}],
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
    # I-002: 레거시 필드는 기본 목록(kind=complete_action)과 같은 의미 — supersede는 제외
    assert body["pending_suggestions"] == 2
    assert body["pending_suggestions_by_kind"] == {"complete_action": 2, "supersede": 1}
    assert body["completed_actions"] == 1
    assert body["due_soon"][0]["due_date"] == "2026-07-03"
    assert body["overdue"][0]["id"] == 11

    sql_calls = [call.args[0] for call in cursor.execute.call_args_list]
    assert any("created_at > %s" in sql for sql in sql_calls)
    assert any("completed_at > %s" in sql for sql in sql_calls)
    assert any("DATE_ADD(CURDATE(), INTERVAL %s DAY)" in sql for sql in sql_calls)
    assert any(call.args[1] == (1, 7) for call in cursor.execute.call_args_list)
    assert any("due_date < CURDATE()" in sql for sql in sql_calls)


def test_delta_supersede_only_pending_is_zero_for_legacy_field():
    """I-002: pending supersede만 있으면 레거시 pending_suggestions는 0 —
    구 데스크톱이 "제안 N건" 배너를 띄우고 빈 인박스(kind 기본 complete_action)를
    여는 유령 카운트를 만들지 않는다. 전체 개수는 by_kind로 노출."""
    conn, _ = _make_conn(
        fetchone=[{"id": 1}, {"cnt": 0}],
        fetchall=[[], [{"kind": "supersede", "cnt": 3}], [], []],
    )

    with patch("backend.api.delta.require_project_access"), \
         patch("backend.api.delta.get_connection", return_value=conn):
        resp = _client.get("/api/v1/projects/1/delta?since=2026-07-01T00:00:00Z")

    body = resp.json()
    assert body["pending_suggestions"] == 0
    assert body["pending_suggestions_by_kind"] == {"supersede": 3}


def test_delta_reads_active_memory_only():
    """K-002: 델타의 memory 조회(신규 집계·완료 집계·due_soon·overdue)는 전부
    active_memory 뷰를 읽는다 — since 이후 생성됐다가 번복된 결정이
    신규 건수에 재노출되지 않도록."""
    conn, cursor = _make_conn(
        fetchone=[{"id": 1}, {"cnt": 0}],
        fetchall=[[], [], [], []],
    )

    with patch("backend.api.delta.require_project_access"), \
         patch("backend.api.delta.get_connection", return_value=conn):
        resp = _client.get("/api/v1/projects/1/delta?since=2026-07-01T00:00:00Z")

    assert resp.status_code == 200
    memory_sqls = [
        c.args[0] for c in cursor.execute.call_args_list
        if ("FROM memory" in c.args[0] or "FROM active_memory" in c.args[0])
        and "memory_suggestions" not in c.args[0]
    ]
    assert len(memory_sqls) == 4  # 신규 집계 + 완료 집계 + due_soon + overdue
    assert all("FROM active_memory" in sql for sql in memory_sqls)


def test_delta_briefing_items_read_active_memory():
    """K-002: 브리핑 LLM 입력용 신규 memory 항목 조회도 active_memory를 읽는다 —
    숨겨진 결정이 브리핑 텍스트에 상충 방침으로 등장하지 않도록."""
    conn, cursor = _make_conn(
        fetchone=[{"id": 1}, {"cnt": 0}],
        fetchall=[
            [{"category": "decision", "cnt": 1}],  # 변화 있음 → 브리핑 생성 경로
            [], [], [],
            [{"id": 5, "category": "decision", "content": "새 방침", "reason": None,
              "topic": None, "owner": None, "date": None, "due_date": None,
              "source": "m.md", "created_by": None, "completed_at": None,
              "created_at": "2026-07-02 10:00:00"}],
        ],
    )
    fake_chain = MagicMock()
    fake_chain.invoke.return_value = "브리핑"

    with patch("backend.api.delta.require_project_access"), \
         patch("backend.api.delta.get_connection", return_value=conn), \
         patch("backend.api.delta._get_delta_briefing_chain", return_value=fake_chain):
        resp = _client.post(
            "/api/v1/projects/1/briefing/delta",
            json={"since": "2026-07-01T00:00:00Z"},
        )

    assert resp.status_code == 200
    assert resp.json()["answer"] == "브리핑"
    item_sqls = [
        c.args[0] for c in cursor.execute.call_args_list
        if "ORDER BY created_at ASC" in c.args[0]
    ]
    assert len(item_sqls) == 1
    assert "FROM active_memory" in item_sqls[0]


def test_delta_briefing_no_changes_skips_llm():
    """POST briefing/delta — 변화가 없으면 LLM 없이 고정 응답을 반환한다."""
    conn, _ = _make_conn(
        fetchone=[{"id": 1}, {"cnt": 0}],
        fetchall=[[], [], [], []],
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
