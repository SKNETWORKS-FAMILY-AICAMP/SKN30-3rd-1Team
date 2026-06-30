# Q&A 엔진 (LangChain RAG): 질문 → MySQL(구조화) + ChromaDB(원문 맥락) 교차 조회 → LLM 답변 생성
# - 신뢰도 향상을 위해 항상 두 소스를 모두 조회한다.
# - 검색(ChromaDB)은 LangChain 벡터스토어로 수행하되, 임베딩은 A의 적재와 동일한
#   chromadb 기본 임베딩(all-MiniLM)으로 통일한다(어댑터 사용).
# - 생성은 LangChain ChatPromptTemplate + ChatOpenAI 체인(LCEL).
import os
from typing import List, Dict, Optional

import chromadb
from chromadb.utils import embedding_functions
from langchain_chroma import Chroma
from langchain_core.embeddings import Embeddings
from langchain_core.messages import HumanMessage, AIMessage
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_openai import ChatOpenAI

from . import mysql_search

MAX_HISTORY = 10   # 대화 히스토리 최대 유지 턴 수 (컨텍스트 길이 제한)
CHROMA_K = 5       # ChromaDB 검색 시 가져올 청크 수

# 답변 신뢰도 향상용 시스템 지침. 컨텍스트는 두 종류로 주어진다:
#   [구조화 기록] decision/action/issue/risk 분류 항목(핵심 사실)
#   [원문 맥락]   회의록 원문 검색 청크(배경·이유·뉘앙스)
# 맥락·인과 이해 + 작업 상태 파악 + 환각 방지를 지시한다.
SYSTEM_QA = """당신은 프로젝트 회의록·문서 기록을 근거로 답하는 AI 어시스턴트입니다.
주어지는 컨텍스트는 두 종류입니다.
- [구조화 기록] 결정(decision)/액션(action)/이슈(issue)/리스크(risk)로 분류된 항목 — 핵심 사실
- [원문 맥락] 회의록 원문에서 검색된 텍스트 — 배경·이유·뉘앙스

다음 두 가지에 답할 수 있어야 합니다.
1) 맥락·인과 이해: 어떤 안건이 왜 반려/승인됐는지, 프로젝트 경위가 왜 A에서 B로 바뀌었는지 등
   배경과 이유를 원문 맥락에서 찾아 인과관계가 드러나도록 설명하라.
2) 작업 상태 파악: 특정 작업의 진행률·완료(예정) 시점·담당자, 그리고 남은 일/다음 할 일을
   구조화 기록과 원문을 종합해 구체적으로 답하라.

규칙:
- 반드시 제공된 컨텍스트에만 근거하라. 없는 내용은 추측하지 말고 "기록에서 확인되지 않는다"고 답하라.
- 구조화 기록을 우선 근거로 삼고 원문 맥락으로 보강하라. 둘이 충돌하면 그 사실을 밝혀라.
- 날짜·진행률 등 수치는 기록에 있는 그대로 인용하라.
- 답변 마지막에 근거가 된 출처를 표기하라."""


class _ChromaDefaultEmbeddings(Embeddings):
    """chromadb 기본 임베딩(all-MiniLM)을 LangChain Embeddings 인터페이스로 감싼 어댑터.
    A(적재)가 사용하는 임베딩과 동일하게 맞춰 검색 정확도를 보장한다.
    """

    def __init__(self):
        self._ef = embedding_functions.DefaultEmbeddingFunction()

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        return [list(map(float, v)) for v in self._ef(texts)]

    def embed_query(self, text: str) -> List[float]:
        return list(map(float, self._ef([text])[0]))


# 질문에서 category 필터를 추출하기 위한 키워드 사전.
# 한 유형만 매칭될 때만 좁히고, 여러 유형이 섞이면 필터를 걸지 않는다(정보 누락 방지).
_CATEGORY_KEYWORDS = {
    "decision": ["결정", "의사결정", "확정", "합의"],
    "action":   ["액션", "할 일", "할일", "작업", "태스크"],
    "issue":    ["이슈", "문제", "쟁점"],
    "risk":     ["리스크", "위험"],
}


def _extract_category(question: str) -> Optional[str]:
    """질문에서 category 필터를 추출한다. 한 유형의 키워드만 매칭되면 그 category,
    여러 유형이 섞이거나 없으면 None(전체 조회)을 반환해 정보 누락을 막는다.

    owner(담당자) 필터는 사용하지 않는다 — 회의록 원문에서는 발화자/담당자 귀속이
    불확실해 `owner` 컬럼을 신뢰하기 어렵고, 정확매칭으로 거르면 관련 행을 놓칠 수 있다.
    (같은 이유로 답변 시스템 프롬프트에서도 담당자 인용 의존을 제외했다.)
    """
    matched = [
        cat for cat, kws in _CATEGORY_KEYWORDS.items()
        if any(k in question for k in kws)
    ]
    return matched[0] if len(matched) == 1 else None


_vectorstore = None


def _get_vectorstore() -> Chroma:
    """기존 'paiM' 컬렉션을 LangChain Chroma 벡터스토어로 감싸 반환(싱글톤)."""
    global _vectorstore
    if _vectorstore is None:
        client = chromadb.PersistentClient(path=os.getenv("CHROMA_PERSIST_DIR", ".chroma"))
        _vectorstore = Chroma(
            client=client,
            collection_name="paiM",
            embedding_function=_ChromaDefaultEmbeddings(),
        )
    return _vectorstore


# LangChain 생성 체인(LCEL): 시스템 지침 + 대화 히스토리 + (컨텍스트 포함)질문 → 답변 텍스트
_prompt = ChatPromptTemplate.from_messages([
    ("system", SYSTEM_QA),
    MessagesPlaceholder("history"),
    ("human", "프로젝트 컨텍스트:\n{context}\n\n질문: {question}"),
])
_llm = ChatOpenAI(model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"), temperature=0)
_chain = _prompt | _llm | StrOutputParser()


def _build_context(project_id: int, question: str) -> tuple[str, List[str], dict]:
    """MySQL(구조화) + ChromaDB(원문 맥락)를 모두 조회해 컨텍스트로 조합.
    반환: (컨텍스트 문자열, 출처 목록, 디버그 dict)
    debug dict는 프론트엔드 디버그 expander에 표시됨.
    """
    sources: List[str] = []
    debug: dict = {"mysql_rows": [], "chroma_chunks": []}

    # 1) 구조화 기록 — MySQL memory 테이블 (질문에서 추출한 category로 좁혀 조회)
    category = _extract_category(question)
    debug["filters"] = {"category": category}
    rows = mysql_search.search(project_id, category=category)
    mysql_ctx = "\n".join(
        f"[{r['category']}] {r['content']} (출처: {r['source']})"
        for r in rows
    )
    for r in rows:
        if r["source"] not in sources:
            sources.append(r["source"])
    debug["mysql_rows"] = [
        {"category": r["category"], "content": r["content"], "source": r["source"]}
        for r in rows
    ]

    # 2) 원문 맥락 — ChromaDB (LangChain 벡터스토어, project_id 필터)
    docs = _get_vectorstore().similarity_search(
        question, k=CHROMA_K, filter={"project_id": project_id}
    )
    chroma_ctx = "\n".join(d.page_content for d in docs)
    for d in docs:
        src = d.metadata.get("source", "")
        if src and src not in sources:
            sources.append(src)
    debug["chroma_chunks"] = [
        # 디버그용: 청크 앞 200자만 표시
        {"text": d.page_content[:200], "source": d.metadata.get("source", ""),
         "date": d.metadata.get("date", "")}
        for d in docs
    ]

    parts = [p for p in [mysql_ctx, chroma_ctx] if p]
    return "\n\n".join(parts), sources, debug


def answer(
    project_id: int,
    question: str,
    history: List[Dict] = None,
    route: str = None,
) -> Dict:
    """질문에 대한 답변을 생성하는 메인 함수 (LangChain RAG).
    1. 항상 MySQL(구조화) + ChromaDB(원문 맥락) 두 소스를 교차 조회
    2. _build_context로 컨텍스트 조합
    3. 대화 히스토리 + 컨텍스트를 LangChain 체인에 전달해 답변 생성
    route 인자는 호환성 위해 유지하나 항상 'both'로 동작한다.
    """
    context, sources, debug = _build_context(project_id, question)

    # 대화 히스토리를 MAX_HISTORY 턴으로 잘라 LangChain 메시지로 변환
    hist_msgs = []
    for m in (history or [])[-MAX_HISTORY:]:
        if m.get("role") == "assistant":
            hist_msgs.append(AIMessage(content=m["content"]))
        else:
            hist_msgs.append(HumanMessage(content=m["content"]))

    answer_text = _chain.invoke({
        "history": hist_msgs,
        "context": context,
        "question": question,
    })

    return {
        "answer":  answer_text,
        "sources": sources,
        "route":   "both",
        "debug":   debug,
    }
