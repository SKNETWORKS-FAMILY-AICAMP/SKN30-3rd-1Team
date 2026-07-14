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
        "memory_category": "action",
        "memory_completed_at": completed_at,
    }


def _supersede_row(status="pending", superseded_by=None, memory_category="decision"):
    return {
        "id": 8,
        "project_id": 1,
        "memory_id": 10,
        "kind": "supersede",
        "evidence": '{"type":"supersede","superseding_memory_id":42}',
        "rationale": "새 결정이 기존 배포 방침을 대체합니다.",
        "confidence": "high",
        "status": status,
        "created_at": "2026-07-02 10:00:00",
        "resolved_at": None,
        "memory_category": memory_category,
        "memory_completed_at": None,
        "memory_superseded_by": superseded_by,
    }


# D-1: supersede accept는 _suggestion_or_404 뒤에 대체 decision 존재 확인 fetchone을 1회 더 한다.
_EXISTS = {"id": 42}  # 대체(신) decision이 존재함을 나타내는 행


def test_accept_supersede_sets_superseded_by_from_evidence():
    """POST accept(supersede) — 대상 decision에 superseded_by/superseded_at 설정 + 벡터 동기화."""
    row = _supersede_row(superseded_by=None)
    updated = {**row, "status": "accepted", "resolved_at": "2026-07-02 11:00:00"}
    conn, cur = _make_conn(fetchone=[row, _EXISTS, updated])
    with patch("backend.api.suggestion.require_project_access"), \
         patch("backend.retriever.memory_vector.delete_memory_vector") as mock_del, \
         patch("backend.api.suggestion.get_connection", return_value=conn):
        resp = _client.post("/api/v1/projects/1/suggestions/8/accept")

    assert resp.status_code == 200
    assert resp.json()["status"] == "accepted"
    supersede_updates = [
        call for call in cur.execute.call_args_list
        if "UPDATE memory SET superseded_by = %s" in call.args[0]
    ]
    assert len(supersede_updates) == 1
    # 첫 파라미터가 evidence의 superseding_memory_id(42)
    assert supersede_updates[0].args[1][0] == 42
    # D-4: 번복된 decision(10) 벡터를 제거해 후보 슬롯 소모 방지
    mock_del.assert_called_once_with(10)


def test_accept_supersede_already_superseded_is_noop_on_memory():
    """이미 superseded된 decision이면 memory는 다시 건드리지 않는다."""
    row = _supersede_row(superseded_by=42)
    updated = {**row, "status": "accepted", "resolved_at": "2026-07-02 11:00:00"}
    conn, cur = _make_conn(fetchone=[row, _EXISTS, updated])
    with patch("backend.api.suggestion.require_project_access"), \
         patch("backend.retriever.memory_vector.delete_memory_vector"), \
         patch("backend.api.suggestion.get_connection", return_value=conn):
        resp = _client.post("/api/v1/projects/1/suggestions/8/accept")

    assert resp.status_code == 200
    sql_calls = [call.args[0] for call in cur.execute.call_args_list]
    assert not any("UPDATE memory SET superseded_by" in sql for sql in sql_calls)


def test_accept_supersede_missing_superseding_decision_is_409():
    """D-1: 대체(신) decision이 이미 삭제됐으면 409 — 존재하지 않는 id로 숨기지 않는다."""
    row = _supersede_row(superseded_by=None)
    conn, cur = _make_conn(fetchone=[row, None])  # 존재 확인이 None
    with patch("backend.api.suggestion.require_project_access"), \
         patch("backend.api.suggestion.get_connection", return_value=conn):
        resp = _client.post("/api/v1/projects/1/suggestions/8/accept")

    assert resp.status_code == 409
    sql_calls = [call.args[0] for call in cur.execute.call_args_list]
    assert not any("UPDATE memory SET superseded_by" in sql for sql in sql_calls)


def test_accept_supersede_conflict_when_superseded_by_other():
    """C-2: 대상 decision이 이미 다른 decision으로 번복돼 있으면 409로 거부(이력 불일치 방지)."""
    row = _supersede_row(superseded_by=7)  # evidence는 42를 가리키지만 이미 7로 번복됨
    conn, cur = _make_conn(fetchone=[row, _EXISTS])
    with patch("backend.api.suggestion.require_project_access"), \
         patch("backend.api.suggestion.get_connection", return_value=conn):
        resp = _client.post("/api/v1/projects/1/suggestions/8/accept")

    assert resp.status_code == 409
    sql_calls = [call.args[0] for call in cur.execute.call_args_list]
    assert not any("UPDATE memory SET superseded_by" in sql for sql in sql_calls)


def test_accept_supersede_conflict_on_lost_race():
    """C-2: 조건부 UPDATE가 0행이면(경합으로 먼저 설정됨) 409로 거부한다."""
    row = _supersede_row(superseded_by=None)
    conn, cur = _make_conn(fetchone=[row, _EXISTS])
    cur.rowcount = 0  # WHERE superseded_by IS NULL 이 아무 행도 못 맞춤
    with patch("backend.api.suggestion.require_project_access"), \
         patch("backend.api.suggestion.get_connection", return_value=conn):
        resp = _client.post("/api/v1/projects/1/suggestions/8/accept")

    assert resp.status_code == 409


def test_accept_unknown_kind_is_rejected():
    """C-3: 지원하지 않는 kind는 400으로 거부 — 기본 분기로 흘러 completed_at을 설정하지 않는다."""
    row = {**_supersede_row(), "kind": "frobnicate"}
    conn, cur = _make_conn(fetchone=[row])
    with patch("backend.api.suggestion.require_project_access"), \
         patch("backend.api.suggestion.get_connection", return_value=conn):
        resp = _client.post("/api/v1/projects/1/suggestions/8/accept")

    assert resp.status_code == 400
    sql_calls = [call.args[0] for call in cur.execute.call_args_list]
    assert not any("UPDATE memory SET" in sql for sql in sql_calls)


def test_supersede_suggestion_targeting_wrong_category_is_404():
    """supersede 대상 memory가 decision이 아니면 404(잘못된 대상 방지)."""
    row = _supersede_row(memory_category="action")
    conn, _ = _make_conn(fetchone=[row])
    with patch("backend.api.suggestion.require_project_access"), \
         patch("backend.api.suggestion.get_connection", return_value=conn):
        resp = _client.post("/api/v1/projects/1/suggestions/8/accept")

    assert resp.status_code == 404


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
