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
from langchain_core.documents import Document

from langchain_community.retrievers import BM25Retriever
from langchain.retrievers import EnsembleRetriever
from langchain.retrievers.contextual_compression import ContextualCompressionRetriever
from langchain.retrievers.document_compressors import CrossEncoderReranker
from langchain_community.cross_encoders import HuggingFaceCrossEncoder

from . import mysql_search
from ..llm.chat_model_factory import get_chat_model


# =========================================================================
# [수정] RAG 핵심 설정 및 가산치 제어 패널 (여기서 모든 파라미터를 한눈에 관리)
# =========================================================================
RAG_CONFIG = {
    "MAX_HISTORY": 10,              # 대화 히스토리 최대 유지 턴 수
    "CHROMA_K": 5,                  # 최종 LLM 및 Reranker가 채택할 청크 수
    "RERANK_SCORE_THRESHOLD": 0.3,  # 리랭크 후 이 점수보다 낮은 청크는 노이즈로 보고 컷
    "RERANK_MODEL": os.getenv("RERANK_MODEL", "BAAI/bge-reranker-v2-m3"),
    
    # [수정] 프로젝트 메모리 가산치 설정
    # 고유한 프로젝트 용어, 기획서 단어 등 '프로젝트 메모리'에 집중하려면 BM25 가중치를 높입니다.
    # 기존 (기본값 0.5 : 0.5) -> (BM25 0.6 : Vector 0.4)로 프로젝트 고유 맥락 가산치 반영
    "HYBRID_BM25_WEIGHT": 0.6,      # 키워드(프로젝트 고유명사/텍스트) 검색 가중치
    "HYBRID_VECTOR_WEIGHT": 0.4,    # 벡터(의미론적 유사도) 검색 가중치
}
# =========================================================================


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

_CATEGORY_KEYWORDS = {
    "decision": ["결정", "의사결정", "확정", "합의"],
    "action":   ["액션", "할 일", "할일", "작업", "태스크"],
    "issue":    ["이슈", "문제", "쟁점"],
    "risk":     ["리스크", "위험"],
}

def _extract_category(question: str) -> Optional[str]:
    matched = [
        cat for cat, kws in _CATEGORY_KEYWORDS.items()
        if any(k in question for k in kws)
    ]
    return matched[0] if len(matched) == 1 else None


_vectorstore = None

def _get_vectorstore() -> Chroma:
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


_reranker_compressor = None

def _get_reranker() -> CrossEncoderReranker:
    global _reranker_compressor
    if _reranker_compressor is None:
        # [수정] 중앙 관리 딕셔너리(RAG_CONFIG)의 모델명과 Top_N 개수를 바라보도록 수정
        model = HuggingFaceCrossEncoder(model_name=RAG_CONFIG["RERANK_MODEL"])
        _reranker_compressor = CrossEncoderReranker(model=model, top_n=RAG_CONFIG["CHROMA_K"])
    return _reranker_compressor


_prompt = ChatPromptTemplate.from_messages([
    ("system", SYSTEM_QA),
    MessagesPlaceholder("history"),
    ("human", "프로젝트 컨텍스트:\n{context}\n\n질문: {question}"),
])

_chain = None

def _get_chain():
    global _chain
    if _chain is None:
        _chain = _prompt | get_chat_model() | StrOutputParser()
    return _chain


def _build_context(project_id: int, question: str) -> tuple[str, List[str], dict]:
    """MySQL(구조화) + 하이브리드 검색 후 Rerank된 ChromaDB(원문 맥락)를 조합"""
    sources: List[str] = []
    debug: dict = {"mysql_rows": [], "chroma_chunks": []}

    # 1) 구조화 기록 — MySQL
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

    # 2) 원문 맥락 — Hybrid (BM25 + Vector) -> Reranker
    chroma_db = _get_vectorstore()
    collection_data = chroma_db.get(where={"project_id": project_id})
    
    docs = []
    if collection_data and collection_data["documents"]:
        project_docs = [
            Document(page_content=doc, metadata=meta)
            for doc, meta in zip(collection_data["documents"], collection_data["metadatas"])
        ]
        
        # [수정] 후보군 수 산정 시 중앙 설정(RAG_CONFIG["CHROMA_K"])을 기준으로 계산하도록 수정
        candidate_k = RAG_CONFIG["CHROMA_K"] * 3
        
        bm25_retriever = BM25Retriever.from_documents(project_docs)
        bm25_retriever.k = candidate_k
        
        vector_retriever = chroma_db.as_retriever(
            search_kwargs={"k": candidate_k, "filter": {"project_id": project_id}}
        )
        
        # [수정] 하이브리드 가중치 비율을 RAG_CONFIG에서 직접 가져와 동적으로 적용하도록 수정 (프로젝트 가산치 제어 가능)
        ensemble_retriever = EnsembleRetriever(
            retrievers=[bm25_retriever, vector_retriever],
            weights=[RAG_CONFIG["HYBRID_BM25_WEIGHT"], RAG_CONFIG["HYBRID_VECTOR_WEIGHT"]]
        )
        
        hybrid_rerank_retriever = ContextualCompressionRetriever(
            base_compressor=_get_reranker(),
            base_retriever=ensemble_retriever
        )
        
        retrieved_docs = hybrid_rerank_retriever.invoke(question)
        
        # [수정] 임계값 필터링 기준을 RAG_CONFIG["RERANK_SCORE_THRESHOLD"]로 매핑 변경
        for d in retrieved_docs:
            score = d.metadata.get("relevance_score", 1.0)
            if score >= RAG_CONFIG["RERANK_SCORE_THRESHOLD"]:
                docs.append(d)

    chroma_ctx = "\n".join(d.page_content for d in docs)
    for d in docs:
        src = d.metadata.get("source", "")
        if src and src not in sources:
            sources.append(src)
            
    debug["chroma_chunks"] = [
        {
            "text": d.page_content[:200], 
            "source": d.metadata.get("source", ""),
            "date": d.metadata.get("date", ""),
            "rerank_score": d.metadata.get("relevance_score", None)
        }
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
    """질문에 대한 답변을 생성하는 메인 함수"""
    context, sources, debug = _build_context(project_id, question)

    hist_msgs = []
    # [수정] 대화 기록 커트라인을 RAG_CONFIG["MAX_HISTORY"]로 매핑 변경
    for m in (history or [])[-RAG_CONFIG["MAX_HISTORY"]:]:
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
