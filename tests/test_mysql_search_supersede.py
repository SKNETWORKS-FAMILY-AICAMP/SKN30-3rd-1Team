"""TASK-002 계층 1 — mysql_search의 supersede 필터 회귀 테스트.

필터링은 SQL 술어(`m.superseded_by IS NULL`)로 DB가 수행하므로, 결정적으로 검증할 수 있는
지점은 `search()`가 생성하는 SQL/params다. 기본 조회는 술어를 포함하고,
include_superseded=True이면 제외함을 확인한다.
"""
from unittest.mock import MagicMock, patch

import pytest

from backend.retriever import mysql_search


def _make_conn():
    cursor = MagicMock()
    cursor.fetchall.return_value = []
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


class _FilteringCursor:
    """superseded 술어를 실제로 해석해 row를 필터링하는 fake cursor.

    실제 DB를 대신해, execute된 SQL에 ``m.superseded_by IS NULL`` 술어가 있으면
    superseded row(=superseded_by가 NULL이 아닌 row)를 제외하고, 없으면 전부
    반환한다. 이렇게 술어를 문자열이 아니라 동작으로 해석해야, 향후 SQL 조립이
    바뀌어 술어가 실질적으로 적용되지 않는 회귀를 반환 row 차이로 검출할 수 있다.
    """

    def __init__(self, rows):
        self._all_rows = rows
        self._result: list = []

    def execute(self, sql, params):
        if "m.superseded_by IS NULL" in sql:
            self._result = [r for r in self._all_rows if r["superseded_by"] is None]
        else:
            self._result = list(self._all_rows)

    def fetchall(self):
        # search()는 row를 mutate(pop/추가)하므로 복사본을 돌려준다.
        return [dict(r) for r in self._result]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _make_filtering_conn(rows):
    cursor = _FilteringCursor(rows)
    conn = MagicMock()
    conn.cursor.return_value = cursor
    return conn


def _search_rows(rows, **kwargs):
    conn = _make_filtering_conn(rows)
    with patch("backend.retriever.mysql_search.get_connection", return_value=conn):
        return mysql_search.search(1, **kwargs)


# 정상 row와 superseded row가 혼재된 데이터셋.
_SUPERSEDE_ROWS = [
    {"id": 1, "superseded_by": None},
    {"id": 2, "superseded_by": 5},
    {"id": 3, "superseded_by": None},
]


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


# --- R-001: 반환 row 차이로 검증하는 회귀 테스트 --------------------------------
# 위 테스트들은 생성된 SQL 문자열만 검사하므로, 술어가 문자열로 남아 있으나 실질
# 필터링이 사라지는 회귀를 잡지 못한다. 아래 두 테스트는 superseded 혼재 데이터에서
# 실제 반환 ID를 비교해 "기본 제외 / 옵트인 포함" 동작을 직접 검증한다.


def test_default_search_returns_only_active_rows():
    """기본 조회는 superseded row를 제외하고 활성 row만 반환한다."""
    result = _search_rows(_SUPERSEDE_ROWS)
    assert [r["id"] for r in result] == [1, 3]


def test_include_superseded_returns_active_and_superseded_rows():
    """include_superseded=True이면 활성 row와 superseded row를 모두 반환한다."""
    result = _search_rows(_SUPERSEDE_ROWS, include_superseded=True)
    assert [r["id"] for r in result] == [1, 2, 3]


# --- R-001: completed/overdue/due_within_days와 양쪽 모드의 술어·params 조합 -----


@pytest.mark.parametrize("include_superseded", [False, True])
@pytest.mark.parametrize(
    "kwargs, expected_fragments",
    [
        ({"completed": True}, ["m.completed_at IS NOT NULL"]),
        ({"completed": False}, ["m.completed_at IS NULL"]),
        (
            {"overdue": True},
            ["m.due_date < CURDATE()", "m.completed_at IS NULL"],
        ),
        (
            {"due_within_days": 7},
            [
                "m.due_date >= CURDATE()",
                "m.due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)",
            ],
        ),
    ],
)
def test_filter_predicates_combine_with_supersede_mode(
    include_superseded, kwargs, expected_fragments
):
    """completed/overdue/due_within_days 술어가 양쪽 supersede 모드와 독립 조합되고,
    이들 필터는 값 바인딩이 없으므로 params 순서를 깨지 않는다(params == [project_id])."""
    sql, params = _run(include_superseded=include_superseded, **kwargs)

    for fragment in expected_fragments:
        assert fragment in sql

    if include_superseded:
        assert "m.superseded_by IS NULL" not in sql
    else:
        assert "m.superseded_by IS NULL" in sql

    # 이들 술어는 CURDATE()/리터럴을 쓰므로 추가 파라미터가 없다.
    assert params == [1]
