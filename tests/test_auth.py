"""require_project_access() 및 get_current_user_id() 단위 테스트."""
import pytest
from unittest.mock import patch, MagicMock
from fastapi import HTTPException

from backend.api.auth import require_project_access


def _make_conn(role_row=None):
    cursor = MagicMock()
    cursor.fetchone.return_value = role_row
    cm = MagicMock()
    cm.__enter__ = lambda s: cursor
    cm.__exit__ = MagicMock(return_value=False)
    conn = MagicMock()
    conn.cursor.return_value = cm
    return conn


def test_noop_when_no_user():
    """get_current_user_id()가 None → no-op, 예외 없음."""
    with patch("backend.api.auth.get_current_user_id", return_value=None):
        require_project_access(project_id=1)  # should not raise


def test_403_when_not_member():
    """user_id가 있지만 project_members에 없으면 403."""
    with patch("backend.api.auth.get_current_user_id", return_value=1), \
         patch("backend.api.auth.get_connection", return_value=_make_conn(None)):
        with pytest.raises(HTTPException) as exc_info:
            require_project_access(project_id=1)
        assert exc_info.value.status_code == 403


def test_403_when_role_insufficient():
    """viewer 권한으로 admin 이상 필요한 endpoint 접근 → 403."""
    with patch("backend.api.auth.get_current_user_id", return_value=1), \
         patch("backend.api.auth.get_connection", return_value=_make_conn({"role": "viewer"})):
        with pytest.raises(HTTPException) as exc_info:
            require_project_access(project_id=1, min_role="admin")
        assert exc_info.value.status_code == 403


def test_passes_with_sufficient_role():
    """owner 권한 → 어떤 min_role에도 통과."""
    with patch("backend.api.auth.get_current_user_id", return_value=1), \
         patch("backend.api.auth.get_connection", return_value=_make_conn({"role": "owner"})):
        require_project_access(project_id=1, min_role="admin")  # should not raise


def test_role_hierarchy():
    """member 권한 → viewer/member는 통과, admin 이상은 403."""
    with patch("backend.api.auth.get_current_user_id", return_value=1), \
         patch("backend.api.auth.get_connection", return_value=_make_conn({"role": "member"})):
        require_project_access(project_id=1, min_role="viewer")   # OK
        require_project_access(project_id=1, min_role="member")   # OK

    with patch("backend.api.auth.get_current_user_id", return_value=1), \
         patch("backend.api.auth.get_connection", return_value=_make_conn({"role": "member"})):
        with pytest.raises(HTTPException) as exc_info:
            require_project_access(project_id=1, min_role="admin")
        assert exc_info.value.status_code == 403


def test_get_current_user_id_no_env():
    """DEV_USER_ID 환경변수 없으면 None 반환."""
    with patch.dict("os.environ", {}, clear=True):
        from backend.api.auth import get_current_user_id
        assert get_current_user_id() is None


def test_get_current_user_id_with_env():
    """DEV_USER_ID=42 설정 시 42 반환."""
    with patch.dict("os.environ", {"DEV_USER_ID": "42"}):
        from backend.api.auth import get_current_user_id
        assert get_current_user_id() == 42
