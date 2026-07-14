"""프론트엔드 API 계약 회귀 테스트 (Entry 106 변경 사항).

R1: 세션 엔드포인트 /api/v1 prefix
R2: GitHub App 세션 만료 → 410 SESSION_EXPIRED (prune 이후에도 결정적)
Q2: 파일 크기 10 MB 초과 → 413
doc_type: 파일명 기반 자동 추론
"""
import time
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.github import router as github_api
from backend.api.upload import _infer_doc_type

_client = TestClient(app, raise_server_exceptions=False)


# ── R1: 세션 prefix ──────────────────────────────────────────────

def _conn_for_session():
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    cur.fetchone.return_value = {"id": 1}
    cur.fetchall.return_value = []
    return conn


def test_session_prefix_api_v1_accessible():
    """/api/v1/projects/{id}/sessions 가 응답한다.

    get_db는 Depends()가 import 시점에 참조를 캡처하므로 patch()로는 대체되지 않음
    → dependency_overrides 사용 (기존 patch 방식은 로컬 MySQL이 떠 있어야만 통과했음).
    """
    from backend.chat.router import get_db
    app.dependency_overrides[get_db] = lambda: _conn_for_session()
    try:
        with patch("backend.chat.router.require_project_access"):
            resp = _client.get("/api/v1/projects/1/sessions")
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert resp.status_code == 200


def test_session_prefix_root_not_found():
    """/projects/{id}/sessions (prefix 없음) 는 404여야 한다."""
    resp = _client.get("/projects/1/sessions")
    assert resp.status_code == 404


# ── R2: GitHub App 세션 만료 신호 (HTTP 레벨) ────────────────────

def test_session_expiry_returns_410_http():
    """만료된 세션 GET 요청 → HTTP 410, top-level {"detail":..., "code":...}."""
    github_api._sessions.clear()
    github_api._expired_states.clear()

    state = "test_state_exp"
    github_api._sessions[state] = github_api.GithubAppSession(
        created_at=time.time() - github_api.SESSION_TTL_SECONDS - 1
    )

    resp = _client.get(f"/github/app/sessions/{state}")
    assert resp.status_code == 410
    body = resp.json()
    assert body["code"] == "SESSION_EXPIRED"
    assert body["detail"] == "session expired"


def test_session_expiry_returns_410_after_prune_http():
    """prune 이후에도 만료된 state → HTTP 410."""
    github_api._sessions.clear()
    github_api._expired_states.clear()

    state = "test_state_pruned"
    github_api._sessions[state] = github_api.GithubAppSession(
        created_at=time.time() - github_api.SESSION_TTL_SECONDS - 1
    )

    github_api._prune_sessions()
    assert state not in github_api._sessions

    resp = _client.get(f"/github/app/sessions/{state}")
    assert resp.status_code == 410
    body = resp.json()
    assert body["code"] == "SESSION_EXPIRED"


def test_missing_session_returns_404_http():
    """존재하지 않는 state → HTTP 404."""
    github_api._sessions.clear()
    github_api._expired_states.clear()

    resp = _client.get("/github/app/sessions/never_existed")
    assert resp.status_code == 404


# ── Q2: 파일 크기 제한 ───────────────────────────────────────────

def _conn_seq_upload(*fetchone_values):
    conns = []
    for val in fetchone_values:
        conn = MagicMock()
        cur = conn.cursor.return_value.__enter__.return_value
        cur.fetchone.return_value = val
        cur.fetchall.return_value = []
        cur.lastrowid = 99
        conns.append(conn)
    return iter(conns)


def _conn_for_memory_rows(rows):
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    cur.fetchall.return_value = [row.copy() for row in rows]
    return conn, cur


def _conn_for_memory_patch(row):
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    cur.rowcount = 1
    cur.fetchone.return_value = row
    return conn, cur


def test_upload_oversized_file_returns_413():
    """10 MB 초과 파일 업로드는 413을 반환한다."""
    big_data = b"x" * (10 * 1024 * 1024 + 1)
    with patch("backend.api.upload.require_project_access"), \
         patch("backend.api.upload.get_connection",
               side_effect=_conn_seq_upload({"id": 1}, {"id": 1})):
        resp = _client.post(
            "/api/v1/projects/1/documents",
            files={"file": ("big.md", big_data, "text/plain")},
        )
    assert resp.status_code == 413


# ── project memory todo fields ───────────────────────────────────

def test_memory_get_includes_todo_fields_and_sort_order():
    """GET /memory — completed_at/sort_order/due_date 포함, sort_order 우선 정렬 SQL 사용."""
    rows = [
        {
            "id": 10, "project_id": 1, "doc_id": None, "repo_id": None,
            "category": "action", "content": "first", "source": None,
            "completed_at": None, "sort_order": 1, "due_date": "2026-07-10",
            "created_at": "2026-07-02 10:00:00",
            "source_kind": None, "ms_doc_id": None, "ms_repo_id": None,
            "source_type": None, "source_path": None,
            "source_ref": None, "source_url": None,
        },
        {
            "id": 11, "project_id": 1, "doc_id": None, "repo_id": None,
            "category": "action", "content": "second", "source": None,
            "completed_at": "2026-07-02 11:00:00", "sort_order": None, "due_date": None,
            "created_at": "2026-07-02 11:00:00",
            "source_kind": None, "ms_doc_id": None, "ms_repo_id": None,
            "source_type": None, "source_path": None,
            "source_ref": None, "source_url": None,
        },
    ]
    conn, cur = _conn_for_memory_rows(rows)
    with patch("backend.api.upload.require_project_access"), \
         patch("backend.retriever.mysql_search.get_connection", return_value=conn):
        resp = _client.get("/api/v1/projects/1/memory")

    assert resp.status_code == 200
    body = resp.json()
    assert body[0]["completed_at"] is None
    assert body[0]["sort_order"] == 1
    assert body[0]["due_date"] == "2026-07-10"
    assert body[1]["completed_at"] == "2026-07-02 11:00:00"
    assert body[1]["due_date"] is None
    sql = cur.execute.call_args.args[0]
    assert "ORDER BY (m.sort_order IS NULL), m.sort_order ASC, m.created_at DESC" in sql


def test_memory_patch_completed_true_sets_completed_at_without_verifying():
    """PATCH completed=true — 서버 NOW()로 completed_at 설정, 검증 마킹은 하지 않음."""
    row = {
        "id": 10, "project_id": 1, "category": "action", "content": "do it",
        "completed_at": "2026-07-02 12:00:00", "sort_order": None,
    }
    conn, cur = _conn_for_memory_patch(row)
    with patch("backend.api.upload.require_project_access"), \
         patch("backend.api.upload._upsert_memory_vector_best_effort"), \
         patch("backend.api.upload.get_connection", return_value=conn):
        resp = _client.patch("/api/v1/projects/1/memory/10", json={"completed": True})

    assert resp.status_code == 200
    assert resp.json()["completed_at"] == "2026-07-02 12:00:00"
    update_sql = cur.execute.call_args_list[0].args[0]
    assert "completed_at = NOW()" in update_sql
    assert "is_user_verified" not in update_sql


def test_memory_patch_completed_false_clears_completed_at():
    """PATCH completed=false — completed_at을 NULL로 되돌림."""
    row = {
        "id": 10, "project_id": 1, "category": "action", "content": "do it",
        "completed_at": None, "sort_order": None,
    }
    conn, cur = _conn_for_memory_patch(row)
    with patch("backend.api.upload.require_project_access"), \
         patch("backend.api.upload._upsert_memory_vector_best_effort"), \
         patch("backend.api.upload.get_connection", return_value=conn):
        resp = _client.patch("/api/v1/projects/1/memory/10", json={"completed": False})

    assert resp.status_code == 200
    assert resp.json()["completed_at"] is None
    update_call = cur.execute.call_args_list[0]
    assert "completed_at = %s" in update_call.args[0]
    assert update_call.args[1][0] is None


def test_memory_patch_sort_order_allows_int_and_null_without_verifying():
    """PATCH sort_order — 정수와 null을 허용하고 검증 마킹은 하지 않음."""
    int_row = {
        "id": 10, "project_id": 1, "category": "action", "content": "do it",
        "completed_at": None, "sort_order": 3,
    }
    int_conn, int_cur = _conn_for_memory_patch(int_row)
    with patch("backend.api.upload.require_project_access"), \
         patch("backend.api.upload._upsert_memory_vector_best_effort"), \
         patch("backend.api.upload.get_connection", return_value=int_conn):
        int_resp = _client.patch("/api/v1/projects/1/memory/10", json={"sort_order": 3})

    assert int_resp.status_code == 200
    assert int_resp.json()["sort_order"] == 3
    int_update_call = int_cur.execute.call_args_list[0]
    assert "sort_order = %s" in int_update_call.args[0]
    assert int_update_call.args[1][0] == 3
    assert "is_user_verified" not in int_update_call.args[0]

    null_row = {
        "id": 10, "project_id": 1, "category": "action", "content": "do it",
        "completed_at": None, "sort_order": None,
    }
    null_conn, null_cur = _conn_for_memory_patch(null_row)
    with patch("backend.api.upload.require_project_access"), \
         patch("backend.api.upload._upsert_memory_vector_best_effort"), \
         patch("backend.api.upload.get_connection", return_value=null_conn):
        resp = _client.patch("/api/v1/projects/1/memory/10", json={"sort_order": None})

    assert resp.status_code == 200
    assert resp.json()["sort_order"] is None
    update_call = null_cur.execute.call_args_list[0]
    assert "sort_order = %s" in update_call.args[0]
    assert update_call.args[1][0] is None
    assert "is_user_verified" not in update_call.args[0]


def test_memory_patch_category_change_rejected_when_row_supersedes_another():
    """G-002: 다른 결정을 번복 중인(superseded_by로 참조되는) decision의 category를
    decision 밖으로 바꾸면 409 — 비decision이 결정을 숨기는 상태를 사후 PATCH로 만들 수 없다."""
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    cur.rowcount = 1
    cur.fetchone.return_value = {"1": 1}  # 참조 존재 확인 SELECT가 행을 돌려줌
    with patch("backend.api.upload.require_project_access"), \
         patch("backend.api.upload._upsert_memory_vector_best_effort"), \
         patch("backend.api.upload.get_connection", return_value=conn):
        resp = _client.patch("/api/v1/projects/1/memory/42", json={"category": "action"})

    assert resp.status_code == 409
    sqls = [c.args[0] for c in cur.execute.call_args_list]
    assert not any("UPDATE memory SET" in s for s in sqls)


def test_memory_patch_category_change_allowed_when_not_referenced():
    """G-002 보완: 참조되지 않은 row의 category 변경은 기존대로 허용."""
    row = {
        "id": 42, "project_id": 1, "category": "action", "content": "do it",
        "completed_at": None, "sort_order": None,
    }
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    cur.rowcount = 1
    cur.fetchone.side_effect = [None, row]  # 참조 없음 → 최종 SELECT
    with patch("backend.api.upload.require_project_access"), \
         patch("backend.api.upload._upsert_memory_vector_best_effort"), \
         patch("backend.api.upload.get_connection", return_value=conn):
        resp = _client.patch("/api/v1/projects/1/memory/42", json={"category": "action"})

    assert resp.status_code == 200
    sqls = [c.args[0] for c in cur.execute.call_args_list]
    assert any("UPDATE memory SET" in s for s in sqls)


def test_memory_patch_superseded_row_deletes_vector_instead_of_upsert():
    """G-003: superseded(숨겨진) memory를 PATCH해도 벡터를 upsert로 부활시키지 않고
    삭제 상태를 유지한다 — 비활성 벡터가 후보/RAG top-N을 차지하지 못하도록."""
    row = {
        "id": 10, "project_id": 1, "category": "decision", "content": "옛 결정",
        "completed_at": None, "sort_order": None, "superseded_by": 42,
    }
    conn, cur = _conn_for_memory_patch(row)
    with patch("backend.api.upload.require_project_access"), \
         patch("backend.api.upload._upsert_memory_vector_best_effort") as mock_upsert, \
         patch("backend.api.upload._delete_memory_vector_best_effort") as mock_delete, \
         patch("backend.api.upload.get_connection", return_value=conn):
        resp = _client.patch("/api/v1/projects/1/memory/10", json={"content": "옛 결정(수정)"})

    assert resp.status_code == 200
    mock_delete.assert_called_once_with(10)
    mock_upsert.assert_not_called()


def test_memory_patch_due_date_sets_value_and_marks_verified():
    """PATCH due_date=YYYY-MM-DD — 마감일 저장 + 사용자 검증 마킹."""
    row = {
        "id": 10, "project_id": 1, "category": "action", "content": "do it",
        "due_date": "2026-07-10", "is_user_verified": 1,
    }
    conn, cur = _conn_for_memory_patch(row)
    with patch("backend.api.upload.require_project_access"), \
         patch("backend.api.upload._upsert_memory_vector_best_effort"), \
         patch("backend.api.upload.get_connection", return_value=conn):
        resp = _client.patch("/api/v1/projects/1/memory/10", json={"due_date": "2026-07-10"})

    assert resp.status_code == 200
    assert resp.json()["due_date"] == "2026-07-10"
    update_call = cur.execute.call_args_list[0]
    assert "due_date = %s" in update_call.args[0]
    assert "is_user_verified = %s" in update_call.args[0]
    assert update_call.args[1][0] == "2026-07-10"


def test_memory_patch_due_date_null_clears_without_verifying():
    """PATCH due_date=null — 마감일 해제, date 필드의 null 처리처럼 검증 마킹 없음."""
    row = {
        "id": 10, "project_id": 1, "category": "action", "content": "do it",
        "due_date": None, "is_user_verified": 0,
    }
    conn, cur = _conn_for_memory_patch(row)
    with patch("backend.api.upload.require_project_access"), \
         patch("backend.api.upload._upsert_memory_vector_best_effort"), \
         patch("backend.api.upload.get_connection", return_value=conn):
        resp = _client.patch("/api/v1/projects/1/memory/10", json={"due_date": None})

    assert resp.status_code == 200
    assert resp.json()["due_date"] is None
    update_call = cur.execute.call_args_list[0]
    assert "due_date = %s" in update_call.args[0]
    assert "is_user_verified" not in update_call.args[0]
    assert update_call.args[1][0] is None


# ── doc_type 추론 ────────────────────────────────────────────────

@pytest.mark.parametrize("filename,expected", [
    ("2026-06-16_회의록.md",       "meeting"),
    ("meeting_notes.txt",          "meeting"),
    ("minutes_2026.md",            "meeting"),
    ("roadmap_v2.md",              "planning"),
    ("기획안_최종.txt",              "planning"),
    ("spec_draft.md",              "planning"),
    ("general_document.md",        "document"),
    ("report.pdf",                 "document"),
    ("unknown_file.txt",           "document"),
])
def test_infer_doc_type(filename, expected):
    assert _infer_doc_type(filename) == expected
