"""TASK-002 계층 1 — mysql_search의 supersede 필터 회귀 테스트.

필터링은 SQL 술어(`m.superseded_by IS NULL`)로 DB가 수행하므로, 결정적으로 검증할 수 있는
지점은 `search()`가 생성하는 SQL/params다. 기본 조회는 술어를 포함하고,
include_superseded=True이면 제외함을 확인한다.
"""
from unittest.mock import MagicMock, patch

from backend.retriever import mysql_search


def _make_conn(rows=None):
    cursor = MagicMock()
    cursor.fetchall.return_value = rows or []
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    conn.cursor.return_value.__exit__.return_value = False
    return conn, cursor


def _run(**kwargs):
    conn, cursor = _make_conn()
    with patch("backend.retriever.mysql_search.get_connection", return_value=conn):
        mysql_search.search(1, **kwargs)
    sql, params = cursor.execute.call_args.args
    return sql, params


def test_default_search_excludes_superseded():
    """기본 조회는 superseded_by IS NULL 술어로 번복된 항목을 제외한다."""
    sql, params = _run()
    assert "m.superseded_by IS NULL" in sql
    assert params == [1]


def test_include_superseded_omits_filter():
    """include_superseded=True이면 이력 조회를 위해 술어를 넣지 않는다."""
    sql, params = _run(include_superseded=True)
    assert "m.superseded_by IS NULL" not in sql
    assert params == [1]


def test_superseded_filter_combines_with_other_conditions():
    """필터가 category/owner 등 기존 조건과 독립적으로 조합되고 params 순서를 깨지 않는다."""
    sql, params = _run(category="decision", owner="Alice")
    assert "m.superseded_by IS NULL" in sql
    assert "m.category = %s" in sql
    assert "m.owner = %s" in sql
    # superseded 술어는 값 바인딩이 없으므로 params는 project_id/category/owner만.
    assert params == [1, "decision", "Alice"]


def test_include_superseded_still_applies_other_filters():
    """옵트인이어도 다른 필터는 그대로 적용된다."""
    sql, params = _run(category="decision", include_superseded=True)
    assert "m.superseded_by IS NULL" not in sql
    assert "m.category = %s" in sql
    assert params == [1, "decision"]
