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
    """/api/v1/projects/{id}/sessions 가 응답한다."""
    with patch("backend.chat.router.get_db", return_value=iter([_conn_for_session()])), \
         patch("backend.chat.router.require_project_access"):
        resp = _client.get("/api/v1/projects/1/sessions")
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
