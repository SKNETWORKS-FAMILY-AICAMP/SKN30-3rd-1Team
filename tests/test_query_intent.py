from unittest.mock import MagicMock, patch

from langchain_core.runnables import RunnableLambda

from backend.retriever import query_intent
from backend.retriever.mysql_search import search


class _FakeStructuredLLM:
    """with_structured_output()만 흉내 내는 라우터/필터 테스트용 LLM."""

    def __init__(self, values):
        self.values = values

    def with_structured_output(self, schema):
        return RunnableLambda(lambda _: schema(**self.values))


def _make_conn(rows=None):
    cursor = MagicMock()
    cursor.fetchall.return_value = rows or []
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    conn.cursor.return_value.__exit__.return_value = False
    return conn, cursor


def test_rule_router_classifies_filter_lookup_and_overview():
    """명백한 조회형/조망형 질문은 LLM 없이 규칙으로 분기한다."""
    lookup = query_intent.classify_question("박제섭이 담당인 미완료 액션은?")
    overview = query_intent.classify_question("프로젝트 전체 상황 정리해줘")

    assert lookup.route == "filter_lookup"
    assert lookup.router_stage == "rule"
    assert overview.route == "overview"
    assert overview.router_stage == "rule"


def test_llm_router_classifies_semantic_when_rule_is_unclear(monkeypatch):
    """규칙이 애매하면 structured-output LLM 분류 결과를 사용한다."""
    monkeypatch.setattr(
        query_intent,
        "get_chat_model",
        lambda: _FakeStructuredLLM({"label": "semantic"}),
    )

    result = query_intent.classify_question("왜 PR AUC를 평가 지표로 선택했어?")

    assert result.route == "semantic"
    assert result.router_stage == "llm"


def test_filter_lookup_formats_rows_without_llm_generation(monkeypatch):
    """filter_lookup은 MySQL 결과를 템플릿으로 포맷하고 sources/debug를 유지한다."""
    monkeypatch.setattr(
        query_intent,
        "extract_filters",
        lambda question, history: query_intent.QueryFilters(
            owner="박제섭",
            category="action",
            completed=False,
        ),
    )
    monkeypatch.setattr(
        query_intent.mysql_search,
        "search",
        lambda *args, **kwargs: [
            {
                "id": 1,
                "category": "action",
                "content": "FastAPI 연동",
                "owner": "박제섭",
                "due_date": "2026-07-04",
                "completed_at": None,
                "source": "repo.md",
            }
        ],
    )

    result = query_intent.answer_filter_lookup(1, "박제섭이 담당인 미완료 액션은?", [], "rule")

    assert result["route"] == "filter_lookup"
    assert "조건에 맞는 기록 1건" in result["answer"]
    assert "FastAPI 연동" in result["answer"]
    assert result["sources"] == ["repo.md"]
    assert result["debug"]["filters"]["owner"] == "박제섭"
    assert result["debug"]["filters"]["completed"] is False


def test_memory_search_completed_filter_sql():
    """mysql_search.search()가 completed 필터를 SQL 조건으로 반영한다."""
    conn, cursor = _make_conn()

    with patch("backend.retriever.mysql_search.get_connection", return_value=conn):
        search(project_id=1, category="action", completed=False)

    sql, params = cursor.execute.call_args.args
    assert "m.category = %s" in sql
    assert "m.completed_at IS NULL" in sql
    assert params == [1, "action"]
