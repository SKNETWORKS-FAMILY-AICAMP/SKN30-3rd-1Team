"""JWT 인증 체계(fail-closed) 테스트.

conftest가 suite 전체를 dev 모드로 돌리므로, 여기서는 monkeypatch로
PAIM_AUTH_MODE=jwt를 개별 설정해 기본(fail-closed) 동작을 검증한다.
"""
import pymysql
import pytest
from unittest.mock import MagicMock, patch
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.api.auth import (
    create_access_token,
    decode_access_token,
    hash_password,
    require_project_access,
    verify_password,
)
from backend.main import app

_client = TestClient(app, raise_server_exceptions=False)

_TEST_SECRET = "test-jwt-secret-for-unit-tests"


@pytest.fixture
def jwt_mode(monkeypatch):
    monkeypatch.setenv("PAIM_AUTH_MODE", "jwt")
    monkeypatch.setenv("PAIM_JWT_SECRET", _TEST_SECRET)
    monkeypatch.delenv("DEV_USER_ID", raising=False)


def _make_conn(fetchone=None, fetchall=None, lastrowid=1):
    cursor = MagicMock()
    cursor.fetchone.return_value = fetchone
    cursor.fetchall.return_value = fetchall if fetchall is not None else []
    cursor.lastrowid = lastrowid
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    conn.cursor.return_value.__exit__.return_value = False
    return conn, cursor


# ── 비밀번호 해시 ─────────────────────────────────────────────────────────────

def test_password_hash_roundtrip():
    hashed = hash_password("correct horse battery")
    assert hashed != "correct horse battery"
    assert verify_password("correct horse battery", hashed)
    assert not verify_password("wrong password", hashed)


def test_verify_password_tolerates_bad_hash():
    assert not verify_password("anything", "not-a-bcrypt-hash")


# ── JWT 토큰 ─────────────────────────────────────────────────────────────────

def test_token_roundtrip(jwt_mode):
    token = create_access_token(42)
    assert decode_access_token(token) == 42


def test_expired_token_rejected(jwt_mode, monkeypatch):
    monkeypatch.setenv("PAIM_JWT_TTL_HOURS", "-1")
    token = create_access_token(42)
    with pytest.raises(HTTPException) as exc_info:
        decode_access_token(token)
    assert exc_info.value.status_code == 401


def test_tampered_token_rejected(jwt_mode):
    token = create_access_token(42)
    head, payload, sig = token.split(".")
    tampered = f"{head}.{payload}X.{sig}" if not payload.endswith("X") else f"{head}.{payload}.{sig}"
    with pytest.raises(HTTPException) as exc_info:
        decode_access_token(tampered)
    assert exc_info.value.status_code == 401


def test_token_signed_with_other_secret_rejected(jwt_mode, monkeypatch):
    token = create_access_token(42)
    monkeypatch.setenv("PAIM_JWT_SECRET", "a-completely-different-secret")
    with pytest.raises(HTTPException) as exc_info:
        decode_access_token(token)
    assert exc_info.value.status_code == 401


def test_missing_secret_is_503(jwt_mode, monkeypatch):
    monkeypatch.delenv("PAIM_JWT_SECRET")
    with pytest.raises(HTTPException) as exc_info:
        create_access_token(1)
    assert exc_info.value.status_code == 503


# ── fail-closed 동작 ─────────────────────────────────────────────────────────

def test_require_project_access_401_without_user_in_jwt_mode(jwt_mode):
    with pytest.raises(HTTPException) as exc_info:
        require_project_access(project_id=1)
    assert exc_info.value.status_code == 401


def test_require_project_access_noop_without_user_in_dev_mode(monkeypatch):
    monkeypatch.setenv("PAIM_AUTH_MODE", "dev")
    monkeypatch.delenv("DEV_USER_ID", raising=False)
    require_project_access(project_id=1)  # should not raise


# ── 인증 미들웨어 ─────────────────────────────────────────────────────────────

def test_middleware_blocks_protected_route_without_token(jwt_mode):
    resp = _client.get("/api/v1/projects")
    assert resp.status_code == 401


def test_middleware_allows_public_paths_without_token(jwt_mode):
    assert _client.get("/health").status_code == 200
    assert _client.get("/").status_code == 200


def test_middleware_rejects_garbage_token(jwt_mode):
    resp = _client.get("/api/v1/projects", headers={"Authorization": "Bearer not.a.jwt"})
    assert resp.status_code == 401


def test_middleware_sets_user_for_valid_token(jwt_mode):
    """유효 토큰 → contextvar 전파 → list_projects가 membership 필터 쿼리를 사용."""
    token = create_access_token(7)
    conn, cursor = _make_conn(fetchall=[{"id": 1, "name": "p1"}])
    with patch("backend.api.project.get_connection", return_value=conn):
        resp = _client.get("/api/v1/projects", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    sql, params = cursor.execute.call_args[0]
    assert "pm.user_id" in sql
    assert params == (7,)


# ── signup / login 엔드포인트 ────────────────────────────────────────────────

def test_signup_returns_token(jwt_mode):
    conn, cursor = _make_conn(fetchone={"id": 5, "email": "a@b.co", "name": "A"}, lastrowid=5)
    with patch("backend.api.auth_routes.get_connection", return_value=conn):
        resp = _client.post(
            "/api/v1/auth/signup",
            json={"email": "A@b.co", "password": "password123", "name": "A"},
        )
    assert resp.status_code == 201
    body = resp.json()
    assert decode_access_token(body["access_token"]) == 5
    assert body["user"]["email"] == "a@b.co"
    # 이메일이 소문자로 정규화되어 INSERT되는지 확인
    insert_params = cursor.execute.call_args_list[0][0][1]
    assert insert_params[0] == "a@b.co"


def test_signup_duplicate_email_409(jwt_mode):
    conn, cursor = _make_conn()
    cursor.execute.side_effect = pymysql.err.IntegrityError(1062, "duplicate")
    with patch("backend.api.auth_routes.get_connection", return_value=conn):
        resp = _client.post(
            "/api/v1/auth/signup",
            json={"email": "a@b.co", "password": "password123", "name": "A"},
        )
    assert resp.status_code == 409


def test_signup_rejects_short_password(jwt_mode):
    resp = _client.post(
        "/api/v1/auth/signup",
        json={"email": "a@b.co", "password": "short", "name": "A"},
    )
    assert resp.status_code == 422


def test_login_success(jwt_mode):
    row = {"id": 9, "email": "a@b.co", "name": "A", "password_hash": hash_password("password123")}
    conn, _ = _make_conn(fetchone=row)
    with patch("backend.api.auth_routes.get_connection", return_value=conn):
        resp = _client.post("/api/v1/auth/login", json={"email": "a@b.co", "password": "password123"})
    assert resp.status_code == 200
    assert decode_access_token(resp.json()["access_token"]) == 9


def test_login_wrong_password_401(jwt_mode):
    row = {"id": 9, "email": "a@b.co", "name": "A", "password_hash": hash_password("password123")}
    conn, _ = _make_conn(fetchone=row)
    with patch("backend.api.auth_routes.get_connection", return_value=conn):
        resp = _client.post("/api/v1/auth/login", json={"email": "a@b.co", "password": "wrong-pass"})
    assert resp.status_code == 401


def test_login_unknown_email_401(jwt_mode):
    conn, _ = _make_conn(fetchone=None)
    with patch("backend.api.auth_routes.get_connection", return_value=conn):
        resp = _client.post("/api/v1/auth/login", json={"email": "no@b.co", "password": "password123"})
    assert resp.status_code == 401


def test_login_legacy_user_without_password_401(jwt_mode):
    """마이그레이션 이전 row(password_hash NULL)는 로그인 불가 — 동일한 401."""
    row = {"id": 1, "email": "dev@local", "name": "Dev", "password_hash": None}
    conn, _ = _make_conn(fetchone=row)
    with patch("backend.api.auth_routes.get_connection", return_value=conn):
        resp = _client.post("/api/v1/auth/login", json={"email": "dev@local", "password": "password123"})
    assert resp.status_code == 401


# ── 멤버 관리 API ────────────────────────────────────────────────────────────

def _role_map(roles: dict):
    """get_project_role(project_id, user_id) → roles[user_id] 매핑."""
    return lambda project_id, user_id: roles.get(user_id)


def test_add_member_requires_owner(jwt_mode):
    def deny(project_id, min_role="viewer"):
        assert min_role == "owner"
        raise HTTPException(status_code=403, detail="owner 아님")

    with patch("backend.api.member.require_project_access", side_effect=deny):
        token = create_access_token(2)
        resp = _client.post(
            "/api/v1/projects/1/members",
            json={"email": "c@d.co"},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 403


def test_add_member_unknown_email_404(jwt_mode):
    conn, _ = _make_conn(fetchone=None)
    token = create_access_token(1)
    with patch("backend.api.member.require_project_access"), \
         patch("backend.api.member.get_connection", return_value=conn):
        resp = _client.post(
            "/api/v1/projects/1/members",
            json={"email": "ghost@d.co"},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 404


def test_add_member_rejects_owner_role(jwt_mode):
    token = create_access_token(1)
    with patch("backend.api.member.require_project_access"):
        resp = _client.post(
            "/api/v1/projects/1/members",
            json={"email": "c@d.co", "role": "owner"},
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 400


def test_owner_cannot_leave_project(jwt_mode):
    token = create_access_token(1)
    with patch("backend.api.member.require_project_access"), \
         patch("backend.api.member.get_project_role", side_effect=_role_map({1: "owner"})):
        resp = _client.delete(
            "/api/v1/projects/1/members/1",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 400


def test_non_owner_cannot_remove_others(jwt_mode):
    token = create_access_token(2)
    with patch("backend.api.member.require_project_access"), \
         patch("backend.api.member.get_project_role", side_effect=_role_map({2: "member", 3: "member"})):
        resp = _client.delete(
            "/api/v1/projects/1/members/3",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 403


def test_member_can_leave_project(jwt_mode):
    token = create_access_token(2)
    conn, _ = _make_conn()
    with patch("backend.api.member.require_project_access"), \
         patch("backend.api.member.get_project_role", side_effect=_role_map({2: "member"})), \
         patch("backend.api.member.get_connection", return_value=conn):
        resp = _client.delete(
            "/api/v1/projects/1/members/2",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 204


def test_owner_can_remove_member(jwt_mode):
    token = create_access_token(1)
    conn, _ = _make_conn()
    with patch("backend.api.member.require_project_access"), \
         patch("backend.api.member.get_project_role", side_effect=_role_map({1: "owner", 2: "member"})), \
         patch("backend.api.member.get_connection", return_value=conn):
        resp = _client.delete(
            "/api/v1/projects/1/members/2",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 204


def test_owner_cannot_be_removed_by_other_owner_path(jwt_mode):
    """다른 owner(존재한다면)를 제외하려는 시도는 403."""
    token = create_access_token(1)
    with patch("backend.api.member.require_project_access"), \
         patch("backend.api.member.get_project_role", side_effect=_role_map({1: "owner", 2: "owner"})):
        resp = _client.delete(
            "/api/v1/projects/1/members/2",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 403


# ── 세션 소유자 격리 ─────────────────────────────────────────────────────────

def test_session_list_filters_by_user(jwt_mode):
    token = create_access_token(7)
    conn, cursor = _make_conn(fetchall=[])
    from backend.chat import router as chat_router_module
    with patch("backend.chat.router.require_project_access"), \
         patch.object(chat_router_module, "get_connection", return_value=conn):
        resp = _client.get(
            "/api/v1/projects/1/sessions",
            headers={"Authorization": f"Bearer {token}"},
        )
    assert resp.status_code == 200
    sql, params = cursor.execute.call_args[0]
    assert "user_id IS NULL OR user_id" in sql
    assert params == (1, 7)


# ── 회귀: 리뷰 findings (R-001 / R-003 / R-004) ──────────────────────────────

def test_placeholder_secret_is_rejected(jwt_mode, monkeypatch):
    """R-001: 공개 placeholder 시크릿은 미설정과 동일하게 503으로 거부된다."""
    monkeypatch.setenv("PAIM_JWT_SECRET", "your_random_jwt_secret")
    with pytest.raises(HTTPException) as exc:
        create_access_token(1)
    assert exc.value.status_code == 503


def test_short_secret_is_rejected(jwt_mode, monkeypatch):
    """R-001: 너무 짧은(약한) 시크릿도 503으로 거부된다."""
    monkeypatch.setenv("PAIM_JWT_SECRET", "short")
    with pytest.raises(HTTPException) as exc:
        create_access_token(1)
    assert exc.value.status_code == 503


def test_hash_password_rejects_over_72_bytes():
    """R-004: 72바이트 초과 비밀번호는 bcrypt 500이 아니라 400으로 거부된다."""
    with pytest.raises(HTTPException) as exc:
        hash_password("a" * 73)
    assert exc.value.status_code == 400


def test_signup_rejects_too_long_password(jwt_mode):
    """R-004: 72바이트 초과 비밀번호 signup은 400 (500 아님)."""
    resp = _client.post(
        "/api/v1/auth/signup",
        json={"email": "a@b.co", "password": "a" * 73, "name": "A"},
    )
    assert resp.status_code == 400


def test_signup_rolls_back_when_secret_missing(jwt_mode, monkeypatch):
    """R-003: 시크릿 누락 시 signup은 503이면서 계정을 commit하지 않고 rollback한다."""
    monkeypatch.delenv("PAIM_JWT_SECRET", raising=False)
    conn, _ = _make_conn(fetchone={"id": 7, "email": "a@b.co", "name": "A"}, lastrowid=7)
    with patch("backend.api.auth_routes.get_connection", return_value=conn):
        resp = _client.post(
            "/api/v1/auth/signup",
            json={"email": "a@b.co", "password": "password123", "name": "A"},
        )
    assert resp.status_code == 503
    conn.rollback.assert_called_once()
    conn.commit.assert_not_called()
