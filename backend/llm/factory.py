import os
from .base import BaseLLMClient
from .claude_client import ClaudeClient
from .openai_client import OpenAIClient
from .google_client import GoogleClient


def get_llm_client(provider: str = None) -> BaseLLMClient:
    # 기본 provider는 openai로 통일한다 (Q&A 통로 qa_engine._make_llm과 동일 기본값).
    # 환경변수 LLM_PROVIDER를 주면 그 값이 우선하므로 사용자의 모델 선택성은 유지된다.
    provider = provider or os.getenv("LLM_PROVIDER", "openai")

    if provider == "claude":
        return ClaudeClient(model=os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6"))
    elif provider == "openai":
        # 모델 기본값도 qa_engine과 동일하게 gpt-4.1-mini로 맞춰, 추출과 Q&A가 같은 모델을 쓰게 한다.
        return OpenAIClient(model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"))
    elif provider == "google":
        return GoogleClient(model=os.getenv("GOOGLE_MODEL", "gemini-1.5-pro"))
    else:
        raise ValueError(f"Unknown provider: {provider}. Choose from: claude, openai, google")
