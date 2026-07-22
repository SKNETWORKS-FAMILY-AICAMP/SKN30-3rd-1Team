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


# --- TASK-004: fetch_supersede_graph 전용 조회 -----------------------------------


def test_fetch_supersede_graph_sql_limits_to_participating_decisions():
    """전용 조회는 관계 참여 decision만 대상 — superseded_by 보유 행 OR 참조되는 행,
    category='decision' 한정. 체인 행에도 충돌 없는 출처 라벨을 만들려면
    memory_sources JOIN이 필요하다(리뷰 C-002)."""
    conn, cursor = _make_conn()

    with patch("backend.retriever.mysql_search.get_connection", return_value=conn):
        mysql_search.fetch_supersede_graph(7)

    sql, params = cursor.execute.call_args.args
    assert "m.category = 'decision'" in sql
    assert "m.superseded_by IS NOT NULL" in sql
    assert "m.id IN (SELECT s.superseded_by FROM memory s" in sql
    assert "LEFT JOIN memory_sources" in sql          # C-002: 출처 식별자 조인
    assert "ms.repo_id" in sql
    assert "ORDER BY m.id ASC" in sql
    assert params == [7, 7]


def test_fetch_supersede_graph_attaches_source_info():
    """C-002: 체인 행이 source_info(repo_id·path)를 실어, 다른 저장소의 동명
    파일이 repo#N으로 구분되도록 한다 — 없으면 이력 인용 근거성이 깨진다."""
    from backend.retriever import qa_engine
    row = {"id": 1, "category": "decision", "content": "정비", "superseded_by": None,
           "source": "README.md", "source_kind": "repository", "ms_doc_id": None,
           "ms_repo_id": 3, "source_type": "readme", "source_path": "README.md",
           "source_ref": "abc", "source_url": ""}
    cursor = MagicMock()
    cursor.fetchall.return_value = [dict(row)]
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor

    with patch("backend.retriever.mysql_search.get_connection", return_value=conn):
        [out] = mysql_search.fetch_supersede_graph(1)

    assert out["source_info"]["repo_id"] == 3
    assert out["source_info"]["path"] == "README.md"
    # 체인 행 라벨도 일반 검색 행처럼 repo#N으로 충돌 방지
    assert qa_engine._row_source_label(out) == "README.md (repo#3)"


class _GraphCursor:
    """fetch_supersede_graph의 술어를 행 필터로 해석하는 fake cursor.

    문자열 매칭이 아니라 반환 행 수 차이로 '관계 참여 행만 반환' 계약을 검증한다."""

    def __init__(self, rows):
        self._all_rows = rows
        self._result: list = []

    def execute(self, sql, params):
        assert "superseded_by IS NOT NULL" in sql  # 전용 술어가 실제로 존재
        referenced = {
            r["superseded_by"] for r in self._all_rows if r["superseded_by"] is not None
        }
        self._result = sorted(
            (
                r for r in self._all_rows
                if r["category"] == "decision"
                and (r["superseded_by"] is not None or r["id"] in referenced)
            ),
            key=lambda r: r["id"],
        )

    def fetchall(self):
        return [dict(r) for r in self._result]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_fetch_supersede_graph_returns_only_participating_rows():
    """관계 비참여 행(활성 단독 decision·타 카테고리)은 반환되지 않는다 —
    반환 행 수가 관계 참여 행 수에 비례해야 이력 모드 비용이 보장된다."""
    rows = [
        {"id": 1, "category": "decision", "superseded_by": 3},   # 시조
        {"id": 3, "category": "decision", "superseded_by": None}, # 참조되는 종단
        {"id": 5, "category": "decision", "superseded_by": None}, # 비참여 활성 decision
        {"id": 6, "category": "action",   "superseded_by": None}, # 타 카테고리
    ]
    cursor = _GraphCursor(rows)
    conn = MagicMock()
    conn.cursor.return_value = cursor

    with patch("backend.retriever.mysql_search.get_connection", return_value=conn):
        result = mysql_search.fetch_supersede_graph(1)

    assert [r["id"] for r in result] == [1, 3]
