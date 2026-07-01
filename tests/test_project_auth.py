"""DEV user seed, list_projects membership filter, ensure_dev_user 단위 테스트."""
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from backend.main import app

_client = TestClient(app, raise_server_exceptions=False)


def _make_conn(fetchone=None, fetchall=None, lastrowid=1):
    """cursor와 conn을 함께 반환. conn.cursor().__enter__() → cursor."""
    cursor = MagicMock()
    cursor.fetchone.return_value = fetchone
    cursor.fetchall.return_value = fetchall if fetchall is not None else []
    cursor.lastrowid = lastrowid
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    conn.cursor.return_value.__exit__.return_value = False
    return conn, cursor


# ── list_projects ──────────────────────────────────────────────────

def test_list_projects_no_user_returns_all():
    """DEV_USER_ID 미설정 → SELECT * (JOIN 없이 전체) 쿼리 사용."""
    conn, cursor = _make_conn(fetchall=[{"id": 1, "name": "p1"}, {"id": 2, "name": "p2"}])
    with patch("backend.api.project.get_current_user_id", return_value=None), \
         patch("backend.api.project.get_connection", return_value=conn):
        resp = _client.get("/api/v1/projects")
    assert resp.status_code == 200
    assert len(resp.json()) == 2
    sql = cursor.execute.call_args[0][0]
    assert "JOIN" not in sql


def test_list_projects_with_user_filters_by_membership():
    """DEV_USER_ID 설정 → membership JOIN 쿼리 + user_id 바인딩 사용."""
    conn, cursor = _make_conn(fetchall=[{"id": 1, "name": "p1"}])
    with patch("backend.api.project.get_current_user_id", return_value=1), \
         patch("backend.api.project.get_connection", return_value=conn):
        resp = _client.get("/api/v1/projects")
    assert resp.status_code == 200
    sql, params = cursor.execute.call_args[0]
    assert "JOIN" in sql
    assert "pm.user_id" in sql
    assert params == (1,)


# ── create_project with dev user ───────────────────────────────────

def test_create_project_with_dev_user_adds_member():
    """ensure_dev_user() → user_id 있으면 project_members owner row INSERT."""
    conn, cursor = _make_conn(
        fetchone={"id": 42, "name": "test", "created_at": "2026-07-02"},
        lastrowid=42,
    )
    with patch("backend.api.project.ensure_dev_user", return_value=1), \
         patch("backend.api.project.get_connection", return_value=conn):
        resp = _client.post("/api/v1/projects", json={"name": "test"})
    assert resp.status_code == 201
    sql_calls = [c[0][0] for c in cursor.execute.call_args_list]
    assert any("project_members" in sql for sql in sql_calls)


def test_create_project_without_dev_user_skips_member():
    """ensure_dev_user() → None 이면 project_members INSERT 생략."""
    conn, cursor = _make_conn(
        fetchone={"id": 10, "name": "anon", "created_at": "2026-07-02"},
        lastrowid=10,
    )
    with patch("backend.api.project.ensure_dev_user", return_value=None), \
         patch("backend.api.project.get_connection", return_value=conn):
        resp = _client.post("/api/v1/projects", json={"name": "anon"})
    assert resp.status_code == 201
    sql_calls = [c[0][0] for c in cursor.execute.call_args_list]
    assert not any("project_members" in sql for sql in sql_calls)


# ── ensure_dev_user ────────────────────────────────────────────────

def test_ensure_dev_user_creates_user_if_missing():
    """users row 없으면 INSERT 실행 후 user_id 반환."""
    conn, cursor = _make_conn(fetchone=None)  # SELECT → None: row 없음
    with patch("backend.api.auth.get_current_user_id", return_value=1), \
         patch("backend.api.auth.get_connection", return_value=conn), \
         patch.dict("os.environ", {"DEV_USER_EMAIL": "dev@local", "DEV_USER_NAME": "Dev"}):
        from backend.api.auth import ensure_dev_user
        result = ensure_dev_user()
    assert result == 1
    sql_calls = [c[0][0] for c in cursor.execute.call_args_list]
    assert any("INSERT" in sql for sql in sql_calls)


def test_ensure_dev_user_skips_insert_when_row_exists():
    """users row 있으면 INSERT 건너뜀, user_id 반환."""
    conn, cursor = _make_conn(fetchone={"id": 1})  # SELECT → row 존재
    with patch("backend.api.auth.get_current_user_id", return_value=1), \
         patch("backend.api.auth.get_connection", return_value=conn):
        from backend.api.auth import ensure_dev_user
        result = ensure_dev_user()
    assert result == 1
    sql_calls = [c[0][0] for c in cursor.execute.call_args_list]
    assert not any("INSERT" in sql for sql in sql_calls)


def test_ensure_dev_user_noop_when_no_dev_user_id():
    """DEV_USER_ID 미설정 → None 반환, DB 접근 없음."""
    with patch("backend.api.auth.get_current_user_id", return_value=None):
        from backend.api.auth import ensure_dev_user
        result = ensure_dev_user()
    assert result is None
