import logging
import os
from typing import Optional

from fastapi import HTTPException
from ..db.mysql import get_connection

logger = logging.getLogger(__name__)

_ROLE_RANK = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}


def get_current_user_id() -> Optional[int]:
    """현재 로그인 사용자 ID 반환.
    인증 미구현 단계: DEV_USER_ID 환경변수 기반 fallback.
    추후 JWT/session 도입 시 이 함수만 교체하면 됨.
    """
    raw = os.getenv("DEV_USER_ID", "")
    if raw:
        try:
            return int(raw)
        except ValueError:
            logger.warning("DEV_USER_ID 환경변수가 유효한 정수가 아닙니다: %s", raw)
    return None


def ensure_dev_user() -> Optional[int]:
    """DEV_USER_ID가 설정된 경우 users 테이블에 row를 보장하고 user_id 반환.
    row가 없으면 INSERT. 이미 있으면 no-op.
    DEV_USER_ID 미설정 시 None 반환.
    """
    user_id = get_current_user_id()
    if user_id is None:
        return None

    email = os.getenv("DEV_USER_EMAIL", "dev@local")
    name = os.getenv("DEV_USER_NAME", "Dev User")

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM users WHERE id = %s", (user_id,))
            if not cursor.fetchone():
                cursor.execute(
                    "INSERT INTO users (id, email, name) VALUES (%s, %s, %s)",
                    (user_id, email, name),
                )
        conn.commit()
    except Exception:
        logger.warning("DEV user 보장 실패 user_id=%s", user_id, exc_info=True)
    finally:
        conn.close()

    return user_id


def require_project_access(project_id: int, min_role: str = "viewer") -> None:
    """프로젝트 접근 권한 검증.

    - user_id가 None이면 no-op (인증 미구현 단계 허용).
    - user_id가 있으면 project_members에서 role 확인 후 min_role 미만이면 403.
    추후 로그인 구현 시 get_current_user_id()만 교체하면 모든 endpoint에 적용됨.
    """
    user_id = get_current_user_id()
    if user_id is None:
        return

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT role FROM project_members WHERE project_id = %s AND user_id = %s",
                (project_id, user_id),
            )
            row = cursor.fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=403, detail="이 프로젝트에 접근 권한이 없습니다.")

    user_rank = _ROLE_RANK.get(row["role"], -1)
    min_rank = _ROLE_RANK.get(min_role, 0)
    if user_rank < min_rank:
        raise HTTPException(status_code=403, detail=f"최소 '{min_role}' 권한이 필요합니다.")
