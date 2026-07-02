"""graph.py get_chat_model 경로 regression 테스트.

_make_llm() → get_chat_model() 교체 후 stale 함수명 참조로 인한
AttributeError 재발을 방지한다 (Codex Entry 103 blocker 수정 검증).
"""
import types
import pytest


class _FakeLLM:
    """실제 API 호출 없이 고정 텍스트를 반환하는 stub."""
    def invoke(self, prompt):
        return types.SimpleNamespace(content="- 테스트 todo 항목")


@pytest.fixture()
def fake_chat_model(monkeypatch):
    monkeypatch.setattr("backend.graph.get_chat_model", lambda: _FakeLLM())


@pytest.fixture()
def fake_qa_engine(monkeypatch):
    """qa_node가 DB/Chroma 없이 동작하도록 _build_context와 _get_chain을 stub."""
    import backend.retriever.qa_engine as qe

    monkeypatch.setattr(
        qe,
        "_build_context",
        lambda pid, q, **kwargs: ("컨텍스트", ["src.md"], {"mysql_rows": [1], "chroma_chunks": []}),
    )

    class _FakeChain:
        def invoke(self, inputs):
            return "테스트 답변"

    monkeypatch.setattr(qe, "_get_chain", lambda: _FakeChain())


@pytest.fixture()
def fake_project_memory(monkeypatch):
    monkeypatch.setattr("backend.graph.get_project_memory", lambda pid: "")
    monkeypatch.setattr("backend.graph.upsert_project_memory", lambda pid, s: None)


def test_plan_node_uses_get_chat_model(fake_chat_model):
    """plan_node()가 get_chat_model()을 통해 LLM을 호출해야 한다.
    _make_llm() 참조가 남아있으면 AttributeError로 실패한다."""
    from backend.graph import plan_node
    result = plan_node({"project_id": 1, "answer": "현재 리스크는 API 변경 가능성입니다."})
    assert "plan" in result
    assert isinstance(result["plan"], list)


def test_run_qa_returns_required_keys(fake_chat_model, fake_qa_engine, fake_project_memory):
    """run_qa()가 answer·plan·sources·route·debug를 모두 반환해야 한다."""
    from backend.graph import run_qa
    result = run_qa(project_id=1, question="현재 상태는?")
    for key in ("answer", "plan", "sources", "route", "debug"):
        assert key in result, f"응답에 '{key}' 키가 없음"
    assert result["route"] == "both"


def test_update_project_memory_uses_get_chat_model(fake_chat_model, fake_project_memory):
    """update_project_memory()가 get_chat_model()로 요약을 생성해야 한다."""
    import backend.pipeline.models as m
    from backend.graph import update_project_memory

    items = [m.MemoryItem(category="action", content="배포 준비", source="test.md")]
    summary = update_project_memory(project_id=1, items=items)
    assert isinstance(summary, str)
