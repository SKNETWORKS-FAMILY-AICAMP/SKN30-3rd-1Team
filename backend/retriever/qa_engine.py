# Q&A 엔진 (LangChain RAG): 질문 → MySQL(구조화) + ChromaDB(원문 맥락) 교차 조회 → LLM 답변 생성
# - 신뢰도 향상을 위해 항상 두 소스를 모두 조회한다.
# - 검색(ChromaDB)은 LangChain 벡터스토어로 수행하되, 임베딩은 적재(db/chroma.py)와 동일한
#   OpenAI 임베딩(EMBED_MODEL, 기본 text-embedding-3-small)으로 통일한다.
# - 생성은 LangChain ChatPromptTemplate + ChatOpenAI 체인(LCEL).
import os
from typing import List, Dict, Optional

from dotenv import load_dotenv
load_dotenv()

import chromadb
from langchain_chroma import Chroma
from langchain_openai import OpenAIEmbeddings
from langchain_core.messages import HumanMessage, AIMessage
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

# [추가] 하이브리드 검색 및 리랭크를 위한 패키지들만 상단에 추가
from langchain_community.retrievers import BM25Retriever
from langchain.retrievers import EnsembleRetriever
from langchain.retrievers.contextual_compression import ContextualCompressionRetriever
from langchain.retrievers.document_compressors import CrossEncoderReranker
from langchain_community.cross_encoders import HuggingFaceCrossEncoder
from langchain_core.documents import Document

from . import mysql_search
from ..llm.chat_model_factory import get_chat_model

MAX_HISTORY = 10   # 대화 히스토리 최대 유지 턴 수 (컨텍스트 길이 제한)
CHROMA_K = 5       # ChromaDB 검색 시 최종 채택할 후보 청크 수

# [추가] 유지보수를 위해 바로바로 바꿀 수 있도록 배치한 마스터 파라미터 변수들
HYBRID_BM25_WEIGHT = 0.6     # 키워드(프로젝트 고유명사) 가중치 (0.5에서 0.6으로 가산치 부여)
HYBRID_VECTOR_WEIGHT = 0.4   # 벡터(의미 유사도) 검색 가중치
RERANK_SCORE_THRESHOLD = 0.3 # 리랭크 점수 임계값. 이보다 낮은 청크는 버려 노이즈를 줄인다.
RERANK_MODEL = "BAAI/bge-reranker-v2-m3"

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
2) 작업 상태 파악: 특정 작업의 진행률·완료(예정) 시점, 그리고 남은 일/다음 할 일을
   구조화 기록과 원문을 종합해 구체적으로 답하라.

규칙:
- 반드시 제공된 컨텍스트에만 근거하라. 없는 내용은 추측하지 말고 "기록에서 확인되지 않는다"고 답하라.
- 구조화 기록을 우선 근거로 삼고 원문 맥락으로 보강하라. 둘이 충돌하면 그 사실을 밝혀라.
- 날짜·진행률 등 수치는 기록에 있는 그대로 인용하라."""


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
    불확실해 `owner` 컬럼을 신뢰하기 어렵고, 정확매칭으로 거르면 관련 행을 놓칠 수 Dat.
    (같은 이유로 답변 시스템 프롬프트에서도 담당자 인용 의존을 제외했다.)
    """
    matched = [
        cat for cat, kws in _CATEGORY_KEYWORDS.items()
        if any(k in question for k in kws)
    ]
    return matched[0] if len(matched) == 1 else None


_vectorstore = None


def _get_vectorstore() -> Chroma:
    """'paiM_openai_v1' 컬렉션을 LangChain Chroma 벡터스토어로 감싸 반환(싱글톤).
    적재측(db/chroma.py)과 동일한 OpenAI 임베딩(EMBED_MODEL)과 컬렉션명을 써야 벡터가 맞는다."""
    global _vectorstore
    if _vectorstore is None:
        collection_name = os.getenv("CHROMA_COLLECTION_NAME", "paiM_openai_v1")
        client = chromadb.PersistentClient(path=os.getenv("CHROMA_PERSIST_DIR", ".chroma"))
        _vectorstore = Chroma(
            client=client,
            collection_name=collection_name,
            embedding_function=OpenAIEmbeddings(model=os.getenv("EMBED_MODEL", "text-embedding-3-small")),
        )
    return _vectorstore


# [추가] 리랭커 모델 싱글톤 초기화 함수 추가
_reranker_compressor = None

def _get_reranker() -> CrossEncoderReranker:
    global _reranker_compressor
    if _reranker_compressor is None:
        model = HuggingFaceCrossEncoder(model_name=RERANK_MODEL)
        _reranker_compressor = CrossEncoderReranker(model=model, top_n=CHROMA_K)
    return _reranker_compressor


# LangChain 생성 체인 프롬프트
_prompt = ChatPromptTemplate.from_messages([
    ("system", SYSTEM_QA),
    MessagesPlaceholder("history"),
    ("human", "프로젝트 컨텍스트:\n{context}\n\n질문: {question}"),
])


_chain = None  # 첫 Q&A 호출 시 LLM_PROVIDER에 맞춰 초기화 (lazy — 앱 시작 시 API key 불필요)


def _get_chain():
    global _chain
    if _chain is None:
        _chain = _prompt | get_chat_model() | StrOutputParser()
    return _chain


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

    # 2) 원문 맥락 — ChromaDB (Hybrid 검색 후 Rerank 체계로 대대적 개편)
    #    - BM25와 의미론 벡터 검색 결과를 가중치에 맞춰 조합(Ensemble)합니다.
    #    - Reranker를 거쳐 최종 정렬된 청크 중 임계값 이내인 것만 사용해 노이즈를 버린다.
    chroma_db = _get_vectorstore()
    collection_data = chroma_db.get(where={"project_id": project_id})
    
    docs = []
    if collection_data and collection_data["documents"]:
        project_docs = [
            Document(page_content=doc, metadata=meta)
            for doc, meta in zip(collection_data["documents"], collection_data["metadatas"])
        ]
        
        # Reranker 정렬 효율을 극대화하기 위해 베이스 리트리버들은 3배수 후보군을 확보
        candidate_k = CHROMA_K * 3
        
        # 가) BM25 Retriever (프로젝트 내부 키워드 검색 전담)
        bm25_retriever = BM25Retriever.from_documents(project_docs)
        bm25_retriever.k = candidate_k
        
        # 나) Vector Retriever
        vector_retriever = chroma_db.as_retriever(
            search_kwargs={"k": candidate_k, "filter": {"project_id": project_id}}
        )
        
        # 다) 앙상블 조합 (상단에 설정된 상수로 가중치를 부여하여 프로젝트 메모리 가산 적용)
        ensemble_retriever = EnsembleRetriever(
            retrievers=[bm25_retriever, vector_retriever],
            weights=[HYBRID_BM25_WEIGHT, HYBRID_VECTOR_WEIGHT]
        )
        
        # 라) 컴프레션 리랭커 바인딩
        hybrid_rerank_retriever = ContextualCompressionRetriever(
            base_compressor=_get_reranker(),
            base_retriever=ensemble_retriever
        )
        
        # 마) 검색 및 최종 신뢰도 커트라인 처리
        retrieved_docs = hybrid_rerank_retriever.invoke(question)
        for d in retrieved_docs:
            score = d.metadata.get("relevance_score", 1.0)
            if score >= RERANK_SCORE_THRESHOLD:
                docs.append(d)

    chroma_ctx = "\n".join(d.page_content for d in docs)
    for d in docs:
        src = d.metadata.get("source", "")
        if src and src not in sources:
            sources.append(src)
    debug["chroma_chunks"] = [
        # 디버그용: 청크 앞 200자만 표시 (리랭크 스코어 필드 추가 모니터링 가능)
        {"text": d.page_content[:200], "source": d.metadata.get("source", ""),
         "date": d.metadata.get("date", ""), "rerank_score": d.metadata.get("relevance_score", None)}
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

    answer_text = _get_chain().invoke({
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
