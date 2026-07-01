# backend/chat/session_store.py
from backend.security.session_crypto import session_crypto

class SessionStore:
    def __init__(self, db_session):
        self.db = db_session  # SQLAlchemy 또는 명시적 DB 세션 커넥션 객체

    def get_session_context(self, session_id: str) -> tuple[str, list[dict], int]:
        """과거 압축 요약본 및 해당 요약 이후 적재된 최신 메시지 윈도우를 한 번에 조회 및 복호화"""
        summary_text = ""
        last_summary_msg_id = 0

        # 1. 암호화된 요약본 데이터 로드
        summary_row = self.db.execute(
            "SELECT ciphertext, nonce, source_message_id FROM chat_summaries WHERE session_id = :session_id",
            {"session_id": session_id}
        ).fetchone()

        if summary_row:
            summary_text = session_crypto.decrypt(summary_row.ciphertext, summary_row.nonce)
            last_summary_msg_id = summary_row.source_message_id

        # 2. 요약 시점 이후(id > last_summary_msg_id)의 최신 메시지 윈도우 로드
        msg_rows = self.db.execute(
            """SELECT id, role, ciphertext, nonce, token_count FROM chat_messages 
               WHERE session_id = :session_id AND id > :last_summary_msg_id ORDER BY id ASC""",
            {"session_id": session_id, "last_summary_msg_id": last_summary_msg_id}
        ).fetchall()

        recent_messages = []
        for row in msg_rows:
            plain_text = session_crypto.decrypt(row.ciphertext, row.nonce)
            recent_messages.append({
                "id": row.id,
                "role": row.role,
                "text": plain_text,
                "token_count": row.token_count
            })

        return summary_text, recent_messages, last_summary_msg_id

    def save_message(self, session_id: str, role: str, text: str, token_count: int) -> int:
        """대화 원문을 암호화 가공 후 데이터베이스에 적재"""
        ciphertext, nonce = session_crypto.encrypt(text)
        result = self.db.execute(
            """INSERT INTO chat_messages (session_id, role, ciphertext, nonce, token_count)
               VALUES (:session_id, :role, :ciphertext, :nonce, :token_count)""",
            {"session_id": session_id, "role": role, "ciphertext": ciphertext, "nonce": nonce, "token_count": token_count}
        )
        return result.lastrowid

    def save_or_update_summary(self, session_id: str, summary_text: str, source_message_id: int):
        """갱신된 롤링 요약본을 암호화하여 테이블에 반영 (Upsert)"""
        ciphertext, nonce = session_crypto.encrypt(summary_text)
        self.db.execute(
            """INSERT INTO chat_summaries (session_id, ciphertext, nonce, source_message_id)
               VALUES (:session_id, :ciphertext, :nonce, :source_message_id)
               ON DUPLICATE KEY UPDATE ciphertext = :ciphertext, nonce = :nonce, source_message_id = :source_message_id""",
            {"session_id": session_id, "ciphertext": ciphertext, "nonce": nonce, "source_message_id": source_message_id}
        )