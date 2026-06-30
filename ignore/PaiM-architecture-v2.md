# PaiM 아키텍처 설계 문서 v2

> 이 문서는 PM과의 설계 세션 전체 내용을 정리한 것입니다.
> 에이전트는 이 문서를 기반으로 프로젝트 구조를 생성하고 핵심 모듈을 구현하세요.

---

## 1. 서비스 개요

PaiM은 회의록, 프로젝트 문서, Git 이력을 입력받아 **의사결정, 결정 이유, 액션 아이템, 미해결 쟁점**을 구조화하고, 프로젝트 맥락 기반 질의응답과 진행 상황 추적을 제공하는 LLM 기반 AI 프로젝트 매니저 서비스다.

### 핵심 차별점
- 일반 RAG: 문서에서 답을 찾는다
- PaiM: 프로젝트의 결정 과정과 실행 맥락을 기억한다

---

## 2. 기술 스택

| 항목 | 선택 | 비고 |
|---|---|---|
| 백엔드 프레임워크 | FastAPI | |
| 벡터 DB | ChromaDB | 원문 chunk 유사도 검색용 |
| 관계형 DB | MySQL | 구조화 추출 결과 저장용 |
| LLM | Claude / OpenAI / Google (전환 가능) | LLM_PROVIDER env로 선택 |
| Structured Output | Pydantic + Tool Use | JSON 파싱 오류 원천 차단 |
| 프론트엔드 | 미정 (Streamlit 또는 React) | |
| 파인튜닝 | 미사용 | RAG로만 구현 |
| LangChain / LangGraph | 미사용 | MVP 기간 내 러닝커브 리스크 |

---

## 3. 디렉토리 구조

```
paiM/
├── backend/
│   ├── api/
│   │   ├── __init__.py
│   │   ├── project.py          # 프로젝트 CRUD
│   │   ├── upload.py           # 문서 업로드 엔드포인트
│   │   └── query.py            # Q&A 엔드포인트
│   │
│   ├── llm/                    # LLM 프로바이더 추상화
│   │   ├── __init__.py
│   │   ├── base.py             # 추상 클래스 (인터페이스)
│   │   ├── claude_client.py    # Anthropic tool use
│   │   ├── openai_client.py    # OpenAI function calling
│   │   ├── google_client.py    # Google function calling
│   │   └── factory.py          # provider 선택 로직
│   │
│   ├── pipeline/               # 백엔드 A 담당
│   │   ├── __init__.py
│   │   ├── extractor.py        # Pydantic + LLM 추출
│   │   └── ingestor.py         # MySQL + ChromaDB 저장 분기
│   │
│   ├── retriever/              # 백엔드 B 담당
│   │   ├── __init__.py
│   │   ├── classifier.py       # 질문 유형 분류 (키워드 기반)
│   │   ├── mysql_search.py     # 구조화 질문 처리
│   │   ├── chroma_search.py    # 유사도 검색 처리
│   │   └── qa_engine.py        # 결과 합치기 + LLM 답변 생성
│   │
│   ├── db/
│   │   ├── mysql.py            # MySQL 연결 + 쿼리
│   │   ├── chroma.py           # ChromaDB 연결
│   │   └── schema.sql          # 테이블 정의
│   │
│   └── main.py                 # FastAPI 앱 진입점
│
├── frontend/
│   ├── pages/
│   │   ├── dashboard.py        # 메모리 대시보드
│   │   ├── upload.py           # 문서 업로드
│   │   └── chat.py             # Q&A 채팅
│   └── components/
│       ├── memory_card.py      # 결정/액션/쟁점 카드
│       └── timeline.py         # 타임라인 뷰
│
├── data/
│   └── samples/
│       ├── meeting_01.md       # 샘플 회의록 1: 프로젝트 방향
│       ├── meeting_02.md       # 샘플 회의록 2: MVP 기능 축소
│       └── meeting_03.md       # 샘플 회의록 3: 발표 준비
│
├── .env
├── .env.example
├── requirements.txt
└── README.md
```

---

## 4. 환경 변수 (.env)

```bash
# LLM Provider 설정
# 선택지: claude | openai | google
LLM_PROVIDER=claude

# Claude
ANTHROPIC_API_KEY=your_anthropic_api_key
CLAUDE_MODEL=claude-sonnet-4-6

# OpenAI
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4o

# Google
GOOGLE_API_KEY=your_google_api_key
GOOGLE_MODEL=gemini-1.5-pro

# DB
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_db_password
DB_NAME=paiM
```

---

## 5. MySQL 스키마

```sql
CREATE TABLE projects (
    id          INT PRIMARY KEY AUTO_INCREMENT,
    name        VARCHAR(255),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE documents (
    id          INT PRIMARY KEY AUTO_INCREMENT,
    project_id  INT NOT NULL,
    filename    VARCHAR(255),
    doc_type    VARCHAR(50),        -- meeting / planning / memo
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE memory (
    id          INT PRIMARY KEY AUTO_INCREMENT,
    project_id  INT NOT NULL,
    doc_id      INT NOT NULL,
    category    VARCHAR(20),        -- decision / action / issue / risk
    content     TEXT,
    reason      TEXT,               -- category = decision일 때만 값 있음
    topic       VARCHAR(100),
    owner       VARCHAR(100),
    date        DATE,
    source      VARCHAR(255),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id),
    FOREIGN KEY (doc_id)     REFERENCES documents(id)
);
```

### 설계 결정 사항
- `project_id`는 AUTO_INCREMENT 정수 (UUID 불필요, MVP 과설계)
- DB는 하나, `project_id`로 프로젝트 격리 (프로젝트별 DB 분리 불필요)
- `reason`은 독립 category가 아닌 `decision`의 인라인 필드
- `parser.py` 불필요 — Pydantic이 타입 검증 담당

---

## 6. ChromaDB 구조

```python
# 컬렉션 1개, project_id 메타데이터로 프로젝트 격리
collection = chroma_client.get_or_create_collection("paiM")

# 저장: 원문 chunk + 파일 단위 메타데이터
collection.add(
    ids=["doc{doc_id}_chunk{i}"],
    documents=["원문 텍스트 chunk..."],
    metadatas=[{
        "project_id": 1,
        "doc_id":     1,
        "source":     "6/29 회의록",
        "date":       "2026-06-29",
        "doc_type":   "meeting"
    }]
)

# 검색: project_id 필터 필수
collection.query(
    query_texts=["검색 쿼리"],
    where={"project_id": 1},
    n_results=5
)
```

### 설계 결정 사항
- ChromaDB에는 LLM 추출 item이 아닌 **원문 chunk** 저장
- category/topic 라벨링 없음 — MySQL이 담당
- 메타데이터는 파일 단위 (source, date, doc_type, project_id, doc_id)

---

## 7. LLM 추상화 레이어

### 7-1. base.py — 인터페이스 정의

```python
from abc import ABC, abstractmethod
from typing import List, Optional
from pydantic import BaseModel


class Message(BaseModel):
    role: str       # "user" | "assistant" | "system"
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
```

### 7-2. factory.py — 프로바이더 선택

```python
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
```

### 7-3. claude_client.py

```python
from typing import List, Optional
import anthropic
from .base import BaseLLMClient, Message, LLMResponse


class ClaudeClient(BaseLLMClient):

    def __init__(self, model: str = "claude-sonnet-4-6", max_tokens: int = 1000):
        self.client = anthropic.Anthropic()
        self.model = model
        self.max_tokens = max_tokens

    def chat(self, messages, system=None, tool_schema=None, tool_name=None) -> LLMResponse:
        kwargs = {
            "model":      self.model,
            "max_tokens": self.max_tokens,
            "messages":   [{"role": m.role, "content": m.content} for m in messages],
        }
        if system:
            kwargs["system"] = system
        if tool_schema and tool_name:
            kwargs["tools"] = [{
                "name": tool_name,
                "description": "Extract structured data.",
                "input_schema": tool_schema,
            }]
            kwargs["tool_choice"] = {"type": "tool", "name": tool_name}

        response = self.client.messages.create(**kwargs)

        for block in response.content:
            if block.type == "tool_use":
                return LLMResponse(content="", tool_input=block.input)

        text = "".join(b.text for b in response.content if hasattr(b, "text"))
        return LLMResponse(content=text)
```

### 7-4. openai_client.py

```python
from typing import List, Optional
import json
import openai
from .base import BaseLLMClient, Message, LLMResponse


class OpenAIClient(BaseLLMClient):

    def __init__(self, model: str = "gpt-4o", max_tokens: int = 1000):
        self.client = openai.OpenAI()
        self.model = model
        self.max_tokens = max_tokens

    def chat(self, messages, system=None, tool_schema=None, tool_name=None) -> LLMResponse:
        formatted = []
        if system:
            formatted.append({"role": "system", "content": system})
        formatted += [{"role": m.role, "content": m.content} for m in messages]

        kwargs = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": formatted,
        }
        if tool_schema and tool_name:
            kwargs["tools"] = [{
                "type": "function",
                "function": {
                    "name": tool_name,
                    "description": "Extract structured data.",
                    "parameters": tool_schema,
                }
            }]
            kwargs["tool_choice"] = {"type": "function", "function": {"name": tool_name}}

        response = self.client.chat.completions.create(**kwargs)
        message = response.choices[0].message

        if message.tool_calls:
            tool_input = json.loads(message.tool_calls[0].function.arguments)
            return LLMResponse(content="", tool_input=tool_input)

        return LLMResponse(content=message.content or "")
```

### 7-5. google_client.py

```python
from typing import List, Optional
import google.generativeai as genai
from .base import BaseLLMClient, Message, LLMResponse


class GoogleClient(BaseLLMClient):

    def __init__(self, model: str = "gemini-1.5-pro", max_tokens: int = 1000):
        self.model = genai.GenerativeModel(model)
        self.max_tokens = max_tokens

    def chat(self, messages, system=None, tool_schema=None, tool_name=None) -> LLMResponse:
        if system:
            self.model._system_instruction = system

        history = []
        for m in messages[:-1]:
            role = "model" if m.role == "assistant" else "user"
            history.append({"role": role, "parts": [m.content]})

        chat = self.model.start_chat(history=history)

        if tool_schema and tool_name:
            tool = genai.protos.Tool(
                function_declarations=[
                    genai.protos.FunctionDeclaration(
                        name=tool_name,
                        description="Extract structured data.",
                        parameters=_pydantic_to_google_schema(tool_schema),
                    )
                ]
            )
            response = chat.send_message(
                messages[-1].content,
                tools=[tool],
                generation_config={"max_output_tokens": self.max_tokens},
            )
            for part in response.parts:
                if fn := getattr(part, "function_call", None):
                    return LLMResponse(content="", tool_input=dict(fn.args))

        response = chat.send_message(
            messages[-1].content,
            generation_config={"max_output_tokens": self.max_tokens},
        )
        return LLMResponse(content=response.text)


def _pydantic_to_google_schema(schema: dict) -> genai.protos.Schema:
    # NOTE: 현재 단순 구현. 중첩 구조(List[MemoryItem]) 사용 시 보완 필요.
    return genai.protos.Schema(
        type=genai.protos.Type.OBJECT,
        properties={
            k: genai.protos.Schema(type=genai.protos.Type.STRING)
            for k in schema.get("properties", {})
        }
    )
```

---

## 8. 추출 파이프라인

### 8-1. Pydantic 모델

```python
from typing import List, Optional, Literal
from pydantic import BaseModel


class MemoryItem(BaseModel):
    category: Literal["decision", "action", "issue", "risk"]
    content: str
    reason: Optional[str] = None   # decision일 때만
    topic: str
    owner: Optional[str] = None
    date: Optional[str] = None     # YYYY-MM-DD
    source: str


class ExtractionResult(BaseModel):
    items: List[MemoryItem]
```

### 8-2. 추출 프롬프트 (System Prompt)

```
Extract project decision-related information from the input text.
Rules:
- Extract one object per decision/action/issue/risk.
- Do not extract unclear or ambiguous information.
- Keep extracted content in the same language as the input.
- For action owner, use the assigned person or the person who says
  "~하겠습니다", "~진행하겠습니다", "~공유드리겠습니다", "~정리하겠습니다".
- For decision, owner is the proposer or speaker.
- For issue, owner is the person who raised it.
- For risk, owner is the person who mentioned it.
- Do not infer unstated reasons.
- reason field is only for decision category, leave null otherwise.
```

### 8-3. extractor.py

```python
from typing import List, Optional
from .models import MemoryItem, ExtractionResult
from ..llm import get_llm_client, Message

SYSTEM_PROMPT = """...(위 프롬프트)..."""

def extract(text: str, provider: str = None) -> List[MemoryItem]:
    """
    provider: "claude" | "openai" | "google" | None (env에서 읽음)
    """
    client = get_llm_client(provider)

    response = client.chat(
        messages=[Message(role="user", content=f"Input:\n{text}")],
        system=SYSTEM_PROMPT,
        tool_schema=ExtractionResult.model_json_schema(),
        tool_name="extract_memory",
    )

    if not response.tool_input:
        raise ValueError("LLM did not return structured output")

    return ExtractionResult(**response.tool_input).items
```

### 8-4. ingestor.py

```python
def ingest(project_id: int, doc_id: int, items: List[MemoryItem],
           raw_text: str, source: str, date: str, doc_type: str):

    # 1. MySQL — 추출 결과 저장
    for item in items:
        db.execute("""
            INSERT INTO memory
            (project_id, doc_id, category, content,
             reason, topic, owner, date, source)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (
            project_id, doc_id,
            item.category, item.content,
            item.reason, item.topic,
            item.owner, item.date,
            item.source
        ))

    # 2. ChromaDB — 원문 chunk 저장
    chunks = split_text(raw_text)
    collection.add(
        ids=[f"doc{doc_id}_chunk{i}" for i in range(len(chunks))],
        documents=chunks,
        metadatas=[{
            "project_id": project_id,
            "doc_id":     doc_id,
            "source":     source,
            "date":       date,
            "doc_type":   doc_type
        } for _ in range(len(chunks))]
    )
```

---

## 9. API 엔드포인트

### 프로젝트
```
POST   /projects              프로젝트 생성
GET    /projects              프로젝트 목록
GET    /projects/{id}         프로젝트 상세
```

### 문서 업로드
```
POST   /projects/{id}/documents
```
Request:
```json
{
    "filename": "6월29일_회의록.md",
    "doc_type": "meeting",
    "content":  "회의록 텍스트..."
}
```
Response:
```json
{
    "doc_id": 3,
    "extracted": {
        "decision": 3,
        "action":   2,
        "issue":    1,
        "risk":     0
    }
}
```

### 메모리 조회
```
GET    /projects/{id}/memory
GET    /projects/{id}/memory?category=decision
GET    /projects/{id}/memory?owner=희승
```

### Q&A
```
POST   /projects/{id}/query
```
Request:
```json
{
    "question": "왜 로그인을 제외했어?",
    "history": [
        {"role": "user",      "content": "이전 질문"},
        {"role": "assistant", "content": "이전 답변"}
    ]
}
```
Response:
```json
{
    "answer":  "로그인 기능은 6/29 회의에서...",
    "sources": ["6/29 회의록"],
    "route":   "chroma"
}
```

### Git
```
POST   /projects/{id}/git     git log 텍스트 입력
```

---

## 10. Q&A 검색 경로

### classifier.py

```python
MYSQL_KEYWORDS  = ["미정", "담당", "목록", "누가", "몇 개", "리스트"]
CHROMA_KEYWORDS = ["왜", "이유", "관련", "어때", "설명", "배경"]

def classify(question: str) -> str:
    if any(k in question for k in MYSQL_KEYWORDS):
        return "mysql"
    elif any(k in question for k in CHROMA_KEYWORDS):
        return "chroma"
    else:
        return "both"
```

### 경로별 동작

| 경로 | 질문 예시 | 처리 방식 |
|---|---|---|
| mysql | "미정인 게 뭐야?", "희승 담당 뭐야?" | memory 테이블 직접 조회 |
| chroma | "왜 로그인 제외했어?" | 원문 유사도 검색 후 LLM 답변 |
| both | "진행 상황 어때?" | 둘 다 조회 후 합쳐서 LLM 전달 |

---

## 11. 대화 세션 관리

- 방식: 프론트엔드에서 히스토리 관리 (서버 저장 없음)
- 최대 유지 개수: 10개
- LangChain / LangGraph 미사용

```python
# qa_engine.py
MAX_HISTORY = 10

def answer(project_id: int, question: str, history: list, route: str) -> dict:
    history = history[-MAX_HISTORY:]

    context = get_context(project_id, question, route)

    messages = history + [{
        "role": "user",
        "content": f"프로젝트 컨텍스트:\n{context}\n\n질문: {question}"
    }]

    client = get_llm_client()
    response = client.chat(
        messages=[Message(**m) for m in messages]
    )
    return {
        "answer":  response.content,
        "sources": extract_sources(context),
        "route":   route
    }
```

---

## 12. MVP 우선순위

| 우선순위 | 기능 | 담당 | 완성 목표 |
|---|---|---|---|
| Must | 프로젝트 생성 | 백엔드 A | Day 1 |
| Must | llm/ 모듈 구현 | 백엔드 A | Day 1 |
| Must | 문서 업로드 + LLM 추출 | 백엔드 A | Day 2 |
| Must | MySQL + ChromaDB 저장 | 백엔드 A | Day 2 |
| Must | Q&A 엔진 (검색 + 답변) | 백엔드 B | Day 3 |
| Must | 메모리 대시보드 UI | 프론트 A | Day 4 |
| Must | Q&A 채팅 UI | 프론트 B | Day 4 |
| Should | Git log 텍스트 입력 | 백엔드 B | Day 4 |
| Should | 타임라인 뷰 | 프론트 B | Day 4 |
| Could | 충돌 탐지 | - | 시간 여유 시 |
| Could | Docker 컨테이너화 | - | 시간 여유 시 |

### Day 3 체크포인트 (핵심 게이트)
`POST /documents` + `POST /query` 두 엔드포인트가 동작해야 Day 4 프론트 연동 가능.

---

## 13. MVP 제외 기능

| 기능 | 제외 이유 |
|---|---|
| STT | 입력 수집 기능, PaiM 본질 아님 |
| 실시간 회의록 작성 | 차별점 약해짐 |
| PDF 업로드 | 파싱 리스크, txt/md로 충분 |
| Slack / Discord 연동 | API 연동 부담 |
| Notion / Jira 연동 | 커넥터 개발 범위 큼 |
| PR diff 분석 | 코드 분석 범위 초과 |
| 멀티 프로젝트 UI | 데모는 단일 프로젝트로 충분 |
| LangChain / LangGraph | MVP 기간 내 러닝커브 리스크 |

---

## 14. 에이전트 구현 순서

### Step 1 — 환경 셋업
- `requirements.txt` 설치
- `.env` 파일 생성 (`.env.example` 참고)
- `backend/db/schema.sql` 실행하여 테이블 생성

### Step 2 — llm/ 모듈 구현
- `base.py`: `BaseLLMClient`, `Message`, `LLMResponse` 정의
- `claude_client.py`: Anthropic tool use 구현
- `openai_client.py`: OpenAI function calling 구현
- `google_client.py`: Google function calling 구현 (schema 변환 주의)
- `factory.py`: `LLM_PROVIDER` env 읽어서 클라이언트 반환
- `__init__.py`: 외부 import용 정리

### Step 3 — pipeline/ 구현
- `extractor.py`: Pydantic 모델 정의 + `extract()` 함수 구현
  - `tool_schema=ExtractionResult.model_json_schema()` 로 structured output 강제
  - `parser.py` 불필요 (Pydantic이 검증 담당)
- `ingestor.py`: `extract()` 결과를 MySQL + ChromaDB에 동시 저장

### Step 4 — retriever/ 구현
- `classifier.py`: 키워드 기반 라우팅 (mysql / chroma / both)
- `mysql_search.py`: category / owner 필터 조회
- `chroma_search.py`: `where={"project_id": id}` 필터 + 유사도 검색
- `qa_engine.py`: 히스토리 최근 10개 + 컨텍스트 조합 후 LLM 호출

### Step 5 — api/ 라우터 구현
- `project.py`: `POST/GET /projects`
- `upload.py`: `POST /projects/{id}/documents` → pipeline 호출
- `query.py`: `POST /projects/{id}/query` → retriever 호출
- `main.py`: FastAPI 앱에 라우터 등록

### Step 6 — 샘플 데이터 생성
- `data/samples/meeting_01.md`: 프로젝트 방향 결정 회의록
- `data/samples/meeting_02.md`: MVP 기능 축소 결정 회의록
- `data/samples/meeting_03.md`: 발표 준비 역할 분배 회의록
- 각 회의록에 decision / action / issue / risk 고르게 포함
- decision에는 반드시 reason이 함께 포함되도록 작성

---

## 15. requirements.txt

```
# FastAPI
fastapi
uvicorn

# LLM providers
anthropic
openai
google-generativeai

# DB
pymysql
chromadb

# 유틸
pydantic
python-dotenv
```

---

*생성일: 2026-06-29*
*v2 변경사항: LLM 추상화 레이어 추가, Pydantic structured output 적용, parser.py 제거*
