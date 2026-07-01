# backend/chat/session_store.py
from fastapi import HTTPException

from backend.security.session_crypto import get_session_crypto

class SessionStore:
    def __init__(self, db_connection, project_id: int):
        self.db = db_connection  # backend.db.mysql.get_connection()이 반환하는 pymysql 커넥션
        self.project_id = project_id

    def _assert_session_ownership(self, cursor, session_id: str):
        """session_id가 self.project_id 소속인지 확인한다. 아니면 404.
        라우터가 이미 검증했더라도, SessionStore를 라우터 밖에서 직접 호출하는 경우까지
        대비한 방어선(defense in depth)."""
        cursor.execute(
            "SELECT id FROM chat_sessions WHERE id = %s AND project_id = %s",
            (session_id, self.project_id)
        )
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="해당 프로젝트에서 요청하신 세션을 찾을 수 없습니다.")

    def get_session_context(self, session_id: str) -> tuple[str, list[dict], int]:
        """과거 압축 요약본 및 해당 요약 이후 적재된 최신 메시지 윈도우를 한 번에 조회 및 복호화"""
        crypto = get_session_crypto()
        summary_text = ""
        last_summary_msg_id = 0

        with self.db.cursor() as cursor:
            self._assert_session_ownership(cursor, session_id)

            # 1. 암호화된 요약본 데이터 로드
            cursor.execute(
                "SELECT ciphertext, nonce, key_version, source_message_id "
                "FROM chat_summaries WHERE session_id = %s",
                (session_id,)
            )
            summary_row = cursor.fetchone()

            if summary_row:
                summary_text = crypto.decrypt(
                    summary_row["ciphertext"], summary_row["nonce"], summary_row["key_version"]
                )
                last_summary_msg_id = summary_row["source_message_id"]

            # 2. 요약 시점 이후(id > last_summary_msg_id)의 최신 메시지 윈도우 로드
            cursor.execute(
                "SELECT id, role, ciphertext, nonce, key_version, token_count FROM chat_messages "
                "WHERE session_id = %s AND id > %s ORDER BY id ASC",
                (session_id, last_summary_msg_id)
            )
            msg_rows = cursor.fetchall()

        recent_messages = []
        for row in msg_rows:
            plain_text = crypto.decrypt(row["ciphertext"], row["nonce"], row["key_version"])
            recent_messages.append({
                "id": row["id"],
                "role": row["role"],
                "text": plain_text,
                "token_count": row["token_count"]
            })

        return summary_text, recent_messages, last_summary_msg_id

    def save_message(self, session_id: str, role: str, text: str, token_count: int) -> int:
        """대화 원문을 암호화 가공 후 데이터베이스에 적재"""
        ciphertext, nonce, key_version = get_session_crypto().encrypt(text)
        with self.db.cursor() as cursor:
            self._assert_session_ownership(cursor, session_id)

            cursor.execute(
                "INSERT INTO chat_messages (session_id, role, ciphertext, nonce, key_version, token_count) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (session_id, role, ciphertext, nonce, key_version, token_count)
            )
            return cursor.lastrowid

    def save_or_update_summary(self, session_id: str, summary_text: str, source_message_id: int):
        """갱신된 롤링 요약본을 암호화하여 테이블에 반영 (Upsert)"""
        ciphertext, nonce, key_version = get_session_crypto().encrypt(summary_text)
        with self.db.cursor() as cursor:
            self._assert_session_ownership(cursor, session_id)

            cursor.execute(
                "INSERT INTO chat_summaries (session_id, ciphertext, nonce, key_version, source_message_id) "
                "VALUES (%s, %s, %s, %s, %s) "
                "ON DUPLICATE KEY UPDATE ciphertext = %s, nonce = %s, key_version = %s, source_message_id = %s",
                (session_id, ciphertext, nonce, key_version, source_message_id,
                 ciphertext, nonce, key_version, source_message_id)
            )
