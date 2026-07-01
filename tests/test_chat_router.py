"""backend/chat/router.py 통합 테스트.

FastAPI 라우터 함수를 HTTP/ASGI 계층(TestClient) 없이 직접 호출하여 검증한다.
현재 의존성 조합(Starlette 1.3.1 + httpx 0.28.1, httpx2 미설치)에서
`fastapi.testclient.TestClient`가 in-process ASGI transport 대신 실제 네트워크 연결을
시도해 샌드박스 환경에 따라 hang될 수 있음이 확인되어(AGENT_LOG.md Entry 045),
네트워크 계층에 의존하지 않는 직접 함수 호출 방식으로 작성한다.
`@router.post(...)` 등 데코레이터는 함수를 라우트로 등록만 하고 원본 함수를 그대로
반환하므로, `db=` 의존성을 직접 주입해 호출하면 실제 요청과 동일한 로직이 실행된다.

실제 MySQL 대신 pymysql cursor 인터페이스(cursor()/execute()/fetchone()/fetchall()/commit())를
흉내 내는 인메모리 페이크 커넥션을 사용한다.
이 경로는 PR #9 리뷰(AGENT_LOG.md Entry 040~045)에서 지적된
encrypt() 언패킹, decrypt() key_version 누락, save_summary/save_or_update_summary 이름 불일치,
old_messages[-1] IndexError, project_id 격리 미검증, cascade delete 누락 버그가
실제로 발생했던 코드 경로다.
"""
import base64
import os

import pytest
from fastapi import HTTPException


class _FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self._rows = []
        self._lastrowid = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql_norm = " ".join(sql.split())

        if sql_norm.startswith("SELECT id FROM projects WHERE id = %s"):
            project_id = params[0]
            self._rows = [{"id": project_id}] if project_id in self.conn.projects else []
        elif sql_norm.startswith("SELECT id FROM chat_sessions WHERE id = %s AND project_id = %s"):
            session_id, project_id = params
            row = self.conn.sessions.get(session_id)
            self._rows = [{"id": session_id}] if row and row["project_id"] == project_id else []
        elif sql_norm.startswith("INSERT INTO chat_sessions"):
            session_id, project_id, title = params
            self.conn.sessions[session_id] = {
                "id": session_id, "project_id": project_id, "title": title,
                "created_at": self.conn.now, "updated_at": self.conn.now,
            }
        elif sql_norm.startswith("SELECT * FROM chat_sessions WHERE id = %s"):
            self._rows = [self.conn.sessions[params[0]]] if params[0] in self.conn.sessions else []
        elif sql_norm.startswith("UPDATE chat_sessions SET title"):
            title, session_id = params
            self.conn.sessions[session_id]["title"] = title
        elif sql_norm.startswith("DELETE FROM chat_messages WHERE session_id = %s"):
            session_id = params[0]
            self.conn.messages = [m for m in self.conn.messages if m["session_id"] != session_id]
        elif sql_norm.startswith("DELETE FROM chat_summaries WHERE session_id = %s"):
            self.conn.summaries.pop(params[0], None)
        elif sql_norm.startswith("DELETE FROM chat_sessions WHERE id = %s"):
            self.conn.sessions.pop(params[0], None)
        elif sql_norm.startswith("INSERT INTO chat_messages"):
            session_id, role, ciphertext, nonce, key_version, token_count = params
            self.conn.msg_id_seq += 1
            msg_id = self.conn.msg_id_seq
            self.conn.messages.append({
                "id": msg_id, "session_id": session_id, "role": role,
                "ciphertext": ciphertext, "nonce": nonce, "key_version": key_version,
                "token_count": token_count, "created_at": self.conn.now,
            })
            self._lastrowid = msg_id
        elif sql_norm.startswith("SELECT ciphertext, nonce, key_version, source_message_id FROM chat_summaries"):
            session_id = params[0]
            row = self.conn.summaries.get(session_id)
            self._rows = [row] if row else []
        elif sql_norm.startswith(
            "SELECT id, role, ciphertext, nonce, key_version, token_count FROM chat_messages"
        ):
            session_id, last_summary_id = params
            self._rows = [
                m for m in self.conn.messages
                if m["session_id"] == session_id and m["id"] > last_summary_id
            ]
        elif sql_norm.startswith(
            "SELECT id, role, ciphertext, nonce, key_version, token_count, created_at FROM chat_messages"
        ):
            session_id = params[0]
            self._rows = [m for m in self.conn.messages if m["session_id"] == session_id]
        elif sql_norm.startswith("INSERT INTO chat_summaries"):
            session_id, ciphertext, nonce, key_version, source_message_id = params[:5]
            self.conn.summaries[session_id] = {
                "session_id": session_id, "ciphertext": ciphertext, "nonce": nonce,
                "key_version": key_version, "source_message_id": source_message_id,
            }
        else:
            raise AssertionError(f"unexpected SQL in fake cursor: {sql_norm}")

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    @property
    def lastrowid(self):
        return self._lastrowid


class _FakeConn:
    def __init__(self):
        self.projects = {1, 2}  # 테스트에서 존재하는 것으로 취급할 project_id들
        self.sessions = {}
        self.messages = []
        self.summaries = {}
        self.msg_id_seq = 0
        self.now = "2026-07-01T00:00:00"

    def cursor(self):
        return _FakeCursor(self)

    def commit(self):
        pass

    def close(self):
        pass


@pytest.fixture
def fake_conn(monkeypatch):
    monkeypatch.setenv(
        "SESSION_MEMORY_KEY",
        base64.b64encode(os.urandom(32)).decode(),
    )
    import backend.security.session_crypto as sc
    sc._session_crypto = None  # 이전 테스트에서 캐시된 키 무효화
    return _FakeConn()


def test_create_and_query_session(fake_conn):
    from backend.chat.router import create_chat_session, handle_session_query, SessionCreateRequest, QueryRequest

    session = create_chat_session(1, SessionCreateRequest(title="테스트 세션"), db=fake_conn)
    session_id = session["id"]

    result = handle_session_query(
        1, session_id, QueryRequest(current_question="로그인 기능은 왜 제외했나요?"), db=fake_conn
    )
    assert result["status"] == "success"
    assert result["session_id"] == session_id


def test_message_history_roundtrip_through_encryption(fake_conn):
    from backend.chat.router import (
        create_chat_session, handle_session_query, get_session_message_history,
        SessionCreateRequest, QueryRequest,
    )

    session_id = create_chat_session(1, SessionCreateRequest(title="s"), db=fake_conn)["id"]
    handle_session_query(1, session_id, QueryRequest(current_question="질문입니다"), db=fake_conn)

    history = get_session_message_history(1, session_id, db=fake_conn)
    roles = [m["role"] for m in history]
    assert roles == ["user", "assistant"]
    assert history[0]["text"] == "질문입니다"


def test_query_does_not_crash_when_short_history_has_large_tokens(fake_conn):
    """메시지 개수는 keep-count 이하지만 토큰 합계가 예산을 넘는 경우
    old_messages[-1] IndexError 없이 정상 응답해야 한다."""
    from backend.chat.router import create_chat_session, handle_session_query, SessionCreateRequest, QueryRequest

    session_id = create_chat_session(1, SessionCreateRequest(title="s"), db=fake_conn)["id"]

    long_question = "가" * 6000  # 토큰 합계가 RECENT_MESSAGE_BUDGET(4000)을 넘도록 유도
    result = handle_session_query(1, session_id, QueryRequest(current_question=long_question), db=fake_conn)
    assert result["status"] == "success"


def test_rolling_summary_merge_actually_triggers(fake_conn):
    """메시지가 keep-count(10)를 넘고 토큰 예산도 초과하면 실제로 요약 병합 경로를 타야 하고,
    `store.save_or_update_summary()` 호출이 AttributeError 없이 성공해야 한다."""
    from backend.chat.router import create_chat_session, handle_session_query, SessionCreateRequest, QueryRequest

    session_id = create_chat_session(1, SessionCreateRequest(title="s"), db=fake_conn)["id"]

    for i in range(10):  # 매 호출마다 user+assistant 2개씩 쌓여 20개 메시지, 토큰 합계 4000+ 누적
        result = handle_session_query(
            1, session_id, QueryRequest(current_question=f"질문 {i}: " + ("내용" * 400)), db=fake_conn
        )
        assert result["status"] == "success"

    # summaries 테이블에 실제로 병합 결과가 저장되었는지 확인 (merge 경로가 실행됐다는 증거)
    assert session_id in fake_conn.summaries


def test_create_session_for_nonexistent_project_returns_404(fake_conn):
    from backend.chat.router import create_chat_session, SessionCreateRequest

    with pytest.raises(HTTPException) as exc_info:
        create_chat_session(999, SessionCreateRequest(title="s"), db=fake_conn)
    assert exc_info.value.status_code == 404


def test_cross_project_session_access_is_rejected(fake_conn):
    """project 1에서 만든 세션을 project 2 경로로 조회/질의/수정/삭제하면 404여야 한다
    (AGENT_LOG.md Entry 043 High 이슈: project_id 격리 미검증)."""
    from backend.chat.router import (
        create_chat_session, get_session_message_history, handle_session_query,
        update_chat_session, delete_chat_session,
        SessionCreateRequest, QueryRequest, SessionUpdateRequest,
    )

    session_id = create_chat_session(1, SessionCreateRequest(title="s"), db=fake_conn)["id"]

    with pytest.raises(HTTPException) as exc:
        get_session_message_history(2, session_id, db=fake_conn)
    assert exc.value.status_code == 404

    with pytest.raises(HTTPException) as exc:
        handle_session_query(2, session_id, QueryRequest(current_question="다른 프로젝트에서 접근 시도"), db=fake_conn)
    assert exc.value.status_code == 404

    with pytest.raises(HTTPException) as exc:
        update_chat_session(2, session_id, SessionUpdateRequest(title="x"), db=fake_conn)
    assert exc.value.status_code == 404

    with pytest.raises(HTTPException) as exc:
        delete_chat_session(2, session_id, db=fake_conn)
    assert exc.value.status_code == 404

    # 원래 프로젝트에서는 정상 접근 가능해야 한다
    history = get_session_message_history(1, session_id, db=fake_conn)
    assert history == []


def test_delete_session_with_messages_cleans_up_children(fake_conn):
    """메시지가 쌓인 세션을 삭제할 때 FK 제약(child row 미삭제)으로 실패하지 않아야 한다
    (AGENT_LOG.md Entry 043 Medium 이슈: cascade delete 누락)."""
    from backend.chat.router import create_chat_session, handle_session_query, delete_chat_session, \
        SessionCreateRequest, QueryRequest

    session_id = create_chat_session(1, SessionCreateRequest(title="s"), db=fake_conn)["id"]
    handle_session_query(1, session_id, QueryRequest(current_question="hi"), db=fake_conn)

    assert any(m["session_id"] == session_id for m in fake_conn.messages)

    delete_chat_session(1, session_id, db=fake_conn)
    assert not any(m["session_id"] == session_id for m in fake_conn.messages)
    assert session_id not in fake_conn.sessions
