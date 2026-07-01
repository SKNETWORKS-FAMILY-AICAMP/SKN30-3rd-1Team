# backend/llm/chat_model_factory.py
"""LLM_PROVIDER 환경변수 기반 LangChain 채팅 모델(BaseChatModel) 팩토리.

`backend/llm/factory.py`의 get_llm_client()(Anthropic/OpenAI/Google SDK를 직접 감싼
구조화 추출용 client)와는 역할이 다르다. 이 모듈은 LangChain 체인/에이전트에 바로
연결할 수 있는 ChatModel 인스턴스를 반환한다(자유 대화형 Q&A/세션 채팅용).
"""
import os


def get_chat_model():
    """LLM_PROVIDER 환경변수에 따라 LangChain 채팅 모델 반환.
    - openai  : OpenAI API
    - claude  : Anthropic API
    - google  : Google Gemini API
    - local   : OpenAI 호환 로컬 서버 (Ollama / vLLM / LM Studio / llama.cpp 등)
                LOCAL_LLM_URL, LOCAL_LLM_MODEL 환경변수로 엔드포인트·모델 지정
    """
    p = os.getenv("LLM_PROVIDER", "openai").lower()
    if p == "openai":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"), temperature=0)
    if p == "claude":
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(model=os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6"), temperature=0)
    if p == "google":
        from langchain_google_genai import ChatGoogleGenerativeAI
        return ChatGoogleGenerativeAI(model=os.getenv("GOOGLE_MODEL", "gemini-1.5-pro"), temperature=0)
    if p == "local":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=os.getenv("LOCAL_LLM_MODEL", "local-model"),
            base_url=os.getenv("LOCAL_LLM_URL", "http://localhost:11434/v1"),
            api_key="local",  # OpenAI 클라이언트가 키를 요구하므로 dummy 값
            temperature=0,
        )
    raise ValueError(f"지원하지 않는 LLM_PROVIDER: {p} (openai/claude/google/local 중 하나)")
