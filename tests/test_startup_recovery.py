"""startup recovery: stale processing/syncing 작업 failed 전환 + dev user backfill 테스트."""
from unittest.mock import patch, MagicMock

from backend.startup import ensure_schema_v8, recover_stale_tasks, backfill_dev_user_membership


def _make_conn():
    cursor = MagicMock()
    cursor.rowcount = 0
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    conn.cursor.return_value.__exit__.return_value = False
    return conn, cursor


def test_ensure_schema_v8_adds_fk_and_view_when_missing():
    """I-001: FK가 없는 기존 DB에서 dangling 정리 → FK 추가 → 뷰 생성 순으로 실행된다.
    initdb.d는 기존 볼륨에서 재실행되지 않으므로 시작 시 보증이 유일한 자동 경로."""
    conn, cursor = _make_conn()
    cursor.fetchone.return_value = None  # FK 없음
    with patch("backend.startup.get_connection", return_value=conn):
        ensure_schema_v8()

    sql_calls = [c.args[0] for c in cursor.execute.call_args_list]
    dangling_idx = next(i for i, s in enumerate(sql_calls) if "SET m.superseded_by = NULL" in s)
    alter_idx = next(i for i, s in enumerate(sql_calls) if "ADD CONSTRAINT fk_memory_superseded_by" in s)
    assert dangling_idx < alter_idx  # FK를 걸기 전에 dangling 포인터를 해제(해당 decision 복귀)
    assert any("CREATE OR REPLACE VIEW active_memory" in s for s in sql_calls)
    conn.commit.assert_called_once()


def test_ensure_schema_v8_skips_alter_when_fk_exists():
    """I-001: FK가 이미 있으면 ALTER는 생략하되 뷰는 매번 보증한다(정의 드리프트 자기치유)."""
    conn, cursor = _make_conn()
    cursor.fetchone.return_value = {"1": 1}  # FK 존재
    with patch("backend.startup.get_connection", return_value=conn):
        ensure_schema_v8()

    sql_calls = [c.args[0] for c in cursor.execute.call_args_list]
    assert not any("ADD CONSTRAINT" in s for s in sql_calls)
    assert not any("SET m.superseded_by = NULL" in s for s in sql_calls)
    assert any("CREATE OR REPLACE VIEW active_memory" in s for s in sql_calls)


def test_ensure_schema_v8_failure_does_not_block_startup():
    """I-001: 스키마 보증이 실패해도 예외를 전파하지 않는다(best-effort, 기동 유지)."""
    with patch("backend.startup.get_connection", side_effect=RuntimeError("DB down")):
        ensure_schema_v8()  # 예외가 나면 테스트 실패


def test_stale_docs_and_repos_updated():
    """stale processing/syncing 모두 UPDATE SQL이 실행됨."""
    conn, cursor = _make_conn()
    with patch("backend.startup.get_connection", return_value=conn), \
         patch.dict("os.environ", {"BACKGROUND_TASK_STALE_MINUTES": "30"}):
        recover_stale_tasks()

    sql_calls = [c[0][0] for c in cursor.execute.call_args_list]
    assert any("documents" in sql and "processing" in sql for sql in sql_calls)
    assert any("repositories" in sql and "syncing" in sql for sql in sql_calls)
    conn.commit.assert_called_once()


def test_recovery_skipped_when_disabled():
    """BACKGROUND_TASK_STALE_MINUTES=0 → DB 접근 없이 즉시 반환."""
    with patch("backend.startup.get_connection") as mock_conn, \
         patch.dict("os.environ", {"BACKGROUND_TASK_STALE_MINUTES": "0"}):
        recover_stale_tasks()
    mock_conn.assert_not_called()


def test_cutoff_uses_env_minutes():
    """BACKGROUND_TASK_STALE_MINUTES=60 → SQL 파라미터에 60 전달."""
    conn, cursor = _make_conn()
    with patch("backend.startup.get_connection", return_value=conn), \
         patch.dict("os.environ", {"BACKGROUND_TASK_STALE_MINUTES": "60"}):
        recover_stale_tasks()

    all_params = [c[0][1] for c in cursor.execute.call_args_list if len(c[0]) > 1]
    assert any(60 in params for params in all_params)


def test_db_failure_does_not_raise():
    """DB 연결 실패 시 예외를 삼키고 앱 기동을 막지 않음."""
    with patch("backend.startup.get_connection", side_effect=Exception("DB down")), \
         patch.dict("os.environ", {"BACKGROUND_TASK_STALE_MINUTES": "30"}):
        recover_stale_tasks()  # must not raise


# ── backfill_dev_user_membership ─────────────────────────────────────────────

def test_backfill_skipped_when_no_dev_user_id():
    """DEV_USER_ID 미설정 시 DB 접근 없이 즉시 반환."""
    with patch("backend.startup.get_connection") as mock_conn, \
         patch("backend.api.auth.ensure_dev_user", return_value=None):
        backfill_dev_user_membership()
    mock_conn.assert_not_called()


def test_backfill_inserts_missing_memberships():
    """DEV_USER_ID 설정 시 멤버가 없는 레거시 프로젝트에만 INSERT IGNORE 실행.

    'DEV_USER_ID가 아직 멤버가 아닌 프로젝트' 전체가 아니라
    'project_members row가 전혀 없는 프로젝트'만 대상이어야 한다.
    """
    conn, cursor = _make_conn()
    cursor.rowcount = 2
    with patch("backend.startup.get_connection", return_value=conn), \
         patch("backend.api.auth.ensure_dev_user", return_value=1):
        backfill_dev_user_membership()

    sql_calls = [c[0][0] for c in cursor.execute.call_args_list]
    insert_sql = next((s for s in sql_calls if "INSERT IGNORE INTO project_members" in s), None)
    assert insert_sql is not None
    # 프로젝트 자체에 멤버가 없는 경우만 대상 — dev user 기준 필터가 아님
    assert "NOT EXISTS" in insert_sql
    assert "WHERE user_id" not in insert_sql
    conn.commit.assert_called_once()


def test_backfill_db_failure_does_not_raise():
    """backfill 중 DB 오류 시 예외를 삼키고 앱 기동을 막지 않음."""
    with patch("backend.startup.get_connection", side_effect=Exception("DB down")), \
         patch("backend.api.auth.ensure_dev_user", return_value=1):
        backfill_dev_user_membership()  # must not raise
