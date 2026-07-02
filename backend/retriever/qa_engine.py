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
from rank_bm25 import BM25Okapi

from . import mysql_search
from ..db.chroma import get_collection
from ..llm.chat_model_factory import get_chat_model

MAX_HISTORY = 10      # 대화 히스토리 최대 유지 턴 수
CHROMA_K = 15         # 리랭커에게 풍부한 후보군을 제공하기 위해 1차 검색 범위를 15개로 확장
CHROMA_TOP_N = 4      # [요구사항] AI 리랭커를 거친 후 컨텍스트에 담을 최종 원문 청크 수 (4개 제한)
MYSQL_TOP_N = 12      
MYSQL_HARD_CAP = 30   
MYSQL_SUPPLEMENT = 5  

# 답변 신뢰도 향상용 시스템 지침
SYSTEM_QA = """당신은 프로젝트 회의록·문서 기록을 근거로 답하는 AI 어시스턴트입니다.
주어지는 컨텍스트는 세 종류입니다(제공되지 않는 종류는 무시하라).
- [프로젝트 메모리] 프로젝트 전반을 응축한 요약 — 프로젝트의 핵심 맥락·방향 (최우선 맥락)
- [구조화 기록] 결정(decision)/액션(action)/이슈(issue)/리스크(risk)로 분류된 항목 — 핵심 사실
- [원문 맥락] 회의록 원문에서 검색된 텍스트 — 배경·이유·뉘앙스

다음 두 가지에 답할 수 있어야 합니다.
1) 맥락·인과 이해: 어떤 안건이 왜 반려/승인됐는지, 프로젝트 경위가 왜 A에서 B로 바뀌었는지 등
   배경과 이유를 원문 맥락에서 찾아 인과관계가 드러나도록 설명하라.
2) 작업 상태 파악: 특정 작업의 진행률·완료(예정) 시점, 그리고 남은 일/다음 할 일을
   구조화 기록과 원문을 종합해 구체적으로 답하라.

규칙:
- 반드시 제공된 컨텍스트에만 근거하라. 없는 내용은 추측하지 말고 "기록에서 확인되지 않는다"고 답하라.
- [프로젝트 메모리]가 제공되면 프로젝트 전반의 최우선 맥락으로 삼아, 답변의 관점·방향이 프로젝트 목표에 부합하도록 중점화하라. 단, 구체 사실·수치는 [구조화 기록]과 [원문 맥락]에서 확인하고 요약만으로 단정하지 마라.
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
        collection_name = os.getenv("CHROMA_COLLECTION_NAME", "paiM_openai_v2")
        client = chromadb.PersistentClient(path=os.getenv("CHROMA_PERSIST_DIR", ".chroma"))
        _vectorstore = Chroma(
            client=client,
            collection_name=collection_name,
            embedding_function=OpenAIEmbeddings(model=os.getenv("EMBED_MODEL", "text-embedding-3-small")),
            collection_metadata={"hnsw:space": "cosine"},
        )
    return _vectorstore

_kiwi = None

def _tokenize_ko(text: str) -> List[str]:
    global _kiwi
    if _kiwi is None:
        from kiwipiepy import Kiwi
        _kiwi = Kiwi()
    tokens = [
        t.form.lower() for t in _kiwi.tokenize(text)
        if t.tag[0] in ("N", "V", "X") or t.tag in ("SL", "SN")
    ]
    return tokens or [text.lower()]

def _bm25_scores(question: str, texts: List[str]) -> List[float]:
    bm = BM25Okapi([_tokenize_ko(t) for t in texts])
    return list(bm.get_scores(_tokenize_ko(question)))

# ── AI 리랭커 모듈 초기화 지연 기법 (Lazy Loading) ─────────────────
_reranker_model = None
_reranker_tokenizer = None

def _get_reranker():
    global _reranker_model, _reranker_tokenizer
    if _reranker_model is None:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        model_name = "dragonkue/bge-reranker-v2-m3-ko"
        _reranker_tokenizer = AutoTokenizer.from_pretrained(model_name)
        _reranker_model = AutoModelForSequenceClassification.from_pretrained(model_name)
        _reranker_model.eval()
        if torch.cuda.is_available():
            _reranker_model.to("cuda")
    return _reranker_model, _reranker_tokenizer

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
    sources: List[str] = []
    debug: dict = {"mysql_rows": [], "chroma_chunks": []}

    # 1) 구조화 기록 — MySQL 조회 및 처리
    category = _extract_category(question)
    debug["filters"] = {"category": category}
    rows = mysql_search.search(project_id)
    if category is not None:
        matched = [r for r in rows if r["category"] == category][:MYSQL_HARD_CAP]
        others = [r for r in rows if r["category"] != category]
        if others:
            o_scores = _bm25_scores(question, [r["content"] or "" for r in others])
            top = sorted(range(len(others)), key=lambda i: -o_scores[i])[:MYSQL_SUPPLEMENT]
            matched += [others[i] for i in sorted(top)]
        rows = matched
    elif len(rows) > MYSQL_TOP_N:
        m_scores = _bm25_scores(question, [r["content"] or "" for r in rows])
        top = sorted(range(len(rows)), key=lambda i: -m_scores[i])[:MYSQL_TOP_N]
        rows = [rows[i] for i in sorted(top)]
    
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

    # 2) 원문 맥락 — 하이브리드 후보 추출 후 검증된 AI 리랭커 스코어링 적용
    raw = get_collection().get(where={"project_id": project_id})
    texts = raw.get("documents") or []
    metas = raw.get("metadatas") or []
    kept: list = []
    
    if texts:
        # a. Dense 1차 추출 (Chroma 벡터 기반)
        scored = _get_vectorstore().similarity_search_with_score(
            question, k=min(CHROMA_K, len(texts)), filter={"project_id": project_id}
        )
        text2idx = {t: i for i, t in enumerate(texts)}
        dense_ranks = [text2idx[d.page_content] for d, _ in scored if d.page_content in text2idx]

        # b. Sparse 1차 추출 (BM25 키워드 기반)
        b_scores = _bm25_scores(question, texts)
        bm25_ranks = sorted(range(len(texts)), key=lambda i: -b_scores[i])[:CHROMA_K]

        # c. [핵심 로직 교체] 중복 없는 후보군 구성 후 한국어 특화 AI 리랭커 실행
        candidate_indices = list(set(dense_ranks + bm25_ranks))
        
        if candidate_indices:
            import torch
            model, tokenizer = _get_reranker()
            pairs = [[question, texts[i]] for i in candidate_indices]
            
            with torch.no_grad():
                inputs = tokenizer(pairs, padding=True, truncation=True, return_tensors="pt", max_length=512)
                # GPU 장치가 사용 가능할 시 인풋 텐서를 동일 디바이스로 안전하게 이동시킴으로써 RuntimeError 원천 차단
                if torch.cuda.is_available():
                    inputs = {k: v.to("cuda") for k, v in inputs.items()}
                
                outputs = model(**inputs)
                # Sequence Classification의 출력 차원을 1차원 리스트로 안정적으로 평탄화
                scores = outputs.logits.view(-1).cpu().float().tolist()
            
            # 높은 리랭크 점수 순으로 정렬 후 최종 요구사항 개수인 상위 4개만 슬라이싱
            top_candidates = sorted(zip(candidate_indices, scores), key=lambda x: -x[1])[:CHROMA_TOP_N]
            
            kept = [
                (i, {
                    "bm25_rank": bm25_ranks.index(i) + 1 if i in bm25_ranks else None,
                    "dense_rank": dense_ranks.index(i) + 1 if i in dense_ranks else None,
                    "rerank_score": round(score, 5),
                })
                for i, score in top_candidates
            ]

    chroma_ctx = "\n".join(texts[i] for i, _ in kept)
    for i, _ in kept:
        src = (metas[i] or {}).get("source", "")
        if src and src not in sources:
            sources.append(src)
            
    debug["chroma_chunks"] = [
        {"text": texts[i][:200], "text_full": texts[i], **info,
         "source": (metas[i] or {}).get("source", ""), "date": (metas[i] or {}).get("date", "")}
        for i, info in kept
    ]

    parts = [p for p in [mysql_ctx, chroma_ctx] if p]
    return "\n\n".join(parts), sources, debug

def answer(
    project_id: int,
    question: str,
    history: List[Dict] = None,
    route: str = None,
) -> Dict:
    context, sources, debug = _build_context(project_id, question)

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