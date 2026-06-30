from abc import ABC, abstractmethod
from typing import List, Optional
from pydantic import BaseModel


class Message(BaseModel):
    role: str
    content: str


class LLMResponse(BaseModel):
    content: str
    tool_input: Optional[dict] = None


class BaseLLMClient(ABC):

    @abstractmethod
    def chat(
        self,
        messages: List[Message],
        system: Optional[str] = None,
        tool_schema: Optional[dict] = None,
        tool_name: Optional[str] = None,
    ) -> LLMResponse:
        pass
