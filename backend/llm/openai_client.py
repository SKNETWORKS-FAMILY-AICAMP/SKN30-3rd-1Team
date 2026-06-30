from typing import List, Optional
import json
import openai
from .base import BaseLLMClient, Message, LLMResponse


class OpenAIClient(BaseLLMClient):

    def __init__(self, model: str = "gpt-4o", max_tokens: int = 4096):
        self.client = openai.OpenAI()
        self.model = model
        self.max_tokens = max_tokens

    def chat(self, messages: List[Message], system=None, tool_schema=None, tool_name=None) -> LLMResponse:
        formatted = []
        if system:
            formatted.append({"role": "system", "content": system})
        formatted += [{"role": m.role, "content": m.content} for m in messages]

        kwargs = {
            "model":      self.model,
            "max_tokens": self.max_tokens,
            "messages":   formatted,
        }
        if tool_schema and tool_name:
            kwargs["tools"] = [{
                "type": "function",
                "function": {
                    "name":        tool_name,
                    "description": "Extract structured data.",
                    "parameters":  tool_schema,
                }
            }]
            kwargs["tool_choice"] = {"type": "function", "function": {"name": tool_name}}

        response = self.client.chat.completions.create(**kwargs)
        choice = response.choices[0]
        message = choice.message

        if choice.finish_reason == "length":
            raise ValueError(
                f"LLM output truncated (max_tokens={self.max_tokens}). "
                f"Try increasing max_tokens or shortening the input."
            )

        if message.tool_calls:
            tool_input = json.loads(message.tool_calls[0].function.arguments)
            return LLMResponse(content="", tool_input=tool_input)

        return LLMResponse(content=message.content or "")
