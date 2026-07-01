"""_make_llm() provider 라우팅 단위 테스트.

각 LLM_PROVIDER 값이 올바른 LangChain 객체를 반환하는지 검증.
실제 API 호출은 하지 않으며 dummy 키로 생성자만 테스트한다.
"""
import pytest


def test_import_without_api_key(monkeypatch):
    """API 키 없이도 모듈 import가 성공해야 한다 (lazy init 검증)."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    import backend.retriever.qa_engine as q
    assert q._chain is None


def test_make_llm_openai(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-dummy")
    from backend.retriever.qa_engine import _make_llm
    from langchain_openai import ChatOpenAI
    assert isinstance(_make_llm(), ChatOpenAI)


def test_make_llm_openai_default_model(monkeypatch):
    """OPENAI_MODEL 미설정 시 기본값이 gpt-4.1-mini여야 한다."""
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-dummy")
    monkeypatch.delenv("OPENAI_MODEL", raising=False)
    from backend.retriever.qa_engine import _make_llm
    assert _make_llm().model_name == "gpt-4.1-mini"


def test_make_llm_claude(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-dummy")
    from backend.retriever.qa_engine import _make_llm
    from langchain_anthropic import ChatAnthropic
    assert isinstance(_make_llm(), ChatAnthropic)


def test_make_llm_google(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "google")
    monkeypatch.setenv("GOOGLE_API_KEY", "dummy")
    from backend.retriever.qa_engine import _make_llm
    from langchain_google_genai import ChatGoogleGenerativeAI
    assert isinstance(_make_llm(), ChatGoogleGenerativeAI)


def test_make_llm_local(monkeypatch):
    """local provider는 OpenAI 호환 클라이언트(ChatOpenAI)를 반환해야 한다."""
    monkeypatch.setenv("LLM_PROVIDER", "local")
    from backend.retriever.qa_engine import _make_llm
    from langchain_openai import ChatOpenAI
    assert isinstance(_make_llm(), ChatOpenAI)


def test_make_llm_invalid_provider(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "unknown_provider")
    from backend.retriever.qa_engine import _make_llm
    with pytest.raises(ValueError, match="지원하지 않는 LLM_PROVIDER"):
        _make_llm()
