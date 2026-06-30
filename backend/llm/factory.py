import os
from .base import BaseLLMClient
from .claude_client import ClaudeClient
from .openai_client import OpenAIClient
from .google_client import GoogleClient


def get_llm_client(provider: str = None) -> BaseLLMClient:
    provider = provider or os.getenv("LLM_PROVIDER", "claude")

    if provider == "claude":
        return ClaudeClient(model=os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6"))
    elif provider == "openai":
        return OpenAIClient(model=os.getenv("OPENAI_MODEL", "gpt-4o"))
    elif provider == "google":
        return GoogleClient(model=os.getenv("GOOGLE_MODEL", "gemini-1.5-pro"))
    else:
        raise ValueError(f"Unknown provider: {provider}. Choose from: claude, openai, google")
