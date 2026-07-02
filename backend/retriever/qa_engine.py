# Q&A 엔진 (LangChain RAG): 질문 → MySQL(구조화) + ChromaDB(원문 맥락) 교차 조회 → LLM 답변 생성
# - 신뢰도 향상을 위해 항상 두 소스를 모두 조회한다.
# - 원문 검색은 하이브리드: BM25(한국어 형태소, 키워드 정확 매칭) + dense(OpenAI 임베딩) 후보를
#   한국어 cross-encoder 리랭커로 재점수화해 상위 CHROMA_TOP_N 청크만 사용한다(리랭커 실패 시 RRF 폴백).
# - MySQL 구조화 기록도 행이 많으면 BM25로 질문 유관 상위 MYSQL_TOP_N만 선별(노이즈 컷).
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
from rank_bm25 import BM25Okapi

from . import mysql_search
from ..db.chroma import get_collection
from ..llm.chat_model_factory import get_chat_model

MAX_HISTORY = 10    # 대화 히스토리 최대 유지 턴 수 (컨텍스트 길이 제한)
CHROMA_K = 15       # 리트리버별(BM25/dense) 1차 후보 수 — 리랭커에 풍부한 후보 제공
CHROMA_TOP_N = 4    # 리랭커 재점수화 후 컨텍스트에 넣을 최종 원문 청크 수
MYSQL_TOP_N = 12    # 구조화 기록 상한 (category 미매칭 시) — 초과 시 BM25 유관 상위 선별
QA_MYSQL_ROWS_LIMIT = max(1, int(os.getenv("QA_MYSQL_ROWS_LIMIT", "60")))
MYSQL_SUPPLEMENT = 5  # category 매칭 시 타 카테고리에서 BM25 유관 상위 보충 개수
BM25_WEIGHT = 0.5   # RRF 융합 가중치 (BM25 : dense = 0.5 : 0.5)
_RRF_K = 60         # RRF 표준 상수 (score = w / (k + rank))

# 답변 신뢰도 향상용 시스템 지침. 컨텍스트는 세 종류로 주어진다:
#   [프로젝트 메모리] 프로젝트 전반 응축 요약(최우선 맥락) — 프로젝트 중점화용 가중
#   [구조화 기록]     decision/action/issue/risk 분류 항목(핵심 사실)
#   [원문 맥락]       회의록 원문 검색 청크(배경·이유·뉘앙스)
# 맥락·인과 이해 + 작업 상태 파악 + 환각 방지를 지시한다.
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
- 액션의 담당자·완료 여부·날짜가 구조화 기록에 표기되어 있으니, 누가/열려있는지 묻는
  질문은 이 메타데이터를 근거로 답하라. 단 날짜는 회의·문서의 기록 날짜이며 마감일이
  아니다 — 마감일로 해석하지 마라. 마감일은 '마감:'으로 별도 표기된다.
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

    owner(담당자) 필터는 사용하지 않는다 — 정확매칭으로 거르면 관련 행을 놓칠 수 있다.
    담당자 판별은 구조화 기록 메타데이터를 컨텍스트에 포함해 답변 단계에서 처리한다.
    """
    matched = [
        cat for cat, kws in _CATEGORY_KEYWORDS.items()
        if any(k in question for k in kws)
    ]
    return matched[0] if len(matched) == 1 else None


_vectorstore = None


def _get_vectorstore() -> Chroma:
    """'paiM_openai_v2'(cosine space) 컬렉션을 LangChain Chroma로 감싸 반환(싱글톤).
    적재측(db/chroma.py)과 동일한 OpenAI 임베딩·컬렉션명·거리지표(cosine)를 써야 벡터/점수가 맞는다."""
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


# ── 하이브리드 검색 부품: 한국어 토크나이저 + BM25 ─────────────────
_kiwi = None


def _tokenize_ko(text: str) -> List[str]:
    """Kiwi 형태소 분석으로 내용어(명사·용언·어근·외래어·숫자)만 추출.
    BM25가 조사·어미에 오염되지 않게 해 '정확한 키워드 매칭'을 살린다."""
    global _kiwi
    if _kiwi is None:
        from kiwipiepy import Kiwi
        _kiwi = Kiwi()
    tokens = [
        t.form.lower() for t in _kiwi.tokenize(text)
        if t.tag[0] in ("N", "V", "X") or t.tag in ("SL", "SN")
    ]
    return tokens or [text.lower()]  # 전부 걸러지면 원문으로 폴백


def _bm25_scores(question: str, texts: List[str]) -> List[float]:
    """질문 대비 각 텍스트의 BM25 점수. (코퍼스가 작아 질의마다 빌드 — 수백 청크까지 무해.
    ponytail: 프로젝트당 청크 ~1000개부터 체감 → 그때 프로젝트별 캐시 도입)"""
    bm = BM25Okapi([_tokenize_ko(t) for t in texts])
    return list(bm.get_scores(_tokenize_ko(question)))


def _rrf_fuse(rank_lists: List[List[int]], weights: List[float], n_docs: int) -> List[float]:
    """RRF(Reciprocal Rank Fusion): 각 리트리버의 순위를 1/(k+rank)로 점수화해 가중 합산.
    리랭커 실패 시 폴백 랭킹으로도 쓴다."""
    scores = [0.0] * n_docs
    for ranks, w in zip(rank_lists, weights):
        for rank, idx in enumerate(ranks):
            scores[idx] += w / (_RRF_K + rank + 1)
    return scores


# ── AI 리랭커 (한국어 특화 cross-encoder) — 지연 로딩 싱글톤 ─────────────
_reranker_model = None
_reranker_tokenizer = None


def _get_reranker():
    """한국어 특화 cross-encoder 리랭커 로드(싱글톤).
    메모리·속도 최적화: GPU면 fp16, CPU면 int8 동적 양자화(Linear 레이어) 적용.
    (fp16은 CPU에서 일부 연산 미지원이라 int8로 — CPU 추론 메모리↓·속도↑)
    모델은 RERANKER_MODEL env로 교체 가능(기본 dragonkue/bge-reranker-v2-m3-ko)."""
    global _reranker_model, _reranker_tokenizer
    if _reranker_model is None:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        model_name = os.getenv("RERANKER_MODEL", "dragonkue/bge-reranker-v2-m3-ko")
        _reranker_tokenizer = AutoTokenizer.from_pretrained(model_name)
        model = AutoModelForSequenceClassification.from_pretrained(model_name)
        model.eval()
        if torch.cuda.is_available():
            model = model.half().to("cuda")
        else:
            model = torch.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
        _reranker_model = model
    return _reranker_model, _reranker_tokenizer


def _short_date(value) -> str:
    """날짜/일시 값을 프롬프트용 YYYY-MM-DD 문자열로 줄인다."""
    return str(value)[:10] if value else ""


def _format_mysql_row(r: Dict) -> str:
    """구조화 기록 한 행을 답변 컨텍스트용 메타데이터 포함 라인으로 만든다."""
    meta = []
    if r.get("topic"):
        meta.append(f"주제: {r['topic']}")
    if r.get("owner"):
        meta.append(f"담당: {r['owner']}")
    if _short_date(r.get("date")):
        meta.append(f"날짜: {_short_date(r.get('date'))}")
    if _short_date(r.get("due_date")):
        meta.append(f"마감: {_short_date(r.get('due_date'))}")
    completed_at = _short_date(r.get("completed_at"))
    if completed_at:
        meta.append(f"완료: {completed_at}")
    elif r.get("category") == "action":
        meta.append("미완료")

    meta_text = f" ({', '.join(meta)})" if meta else ""
    return f"[{r['category']}] {r['content']}{meta_text} (출처: {r['source']})"


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

    # 1) 구조화 기록 — MySQL memory 테이블.
    #    category는 하드 필터가 아니라 소프트 우선순위로 쓴다: 추출기의 decision/action 분류
    #    경계가 모호해("~하기로 결정"은 양쪽 다 가능) 하드 컷은 recall을 깎는다.
    #    - category 매칭: 그 카테고리 전체 + 타 카테고리에서 BM25 유관 상위 보충
    #    - category 미매칭: 전체에서 BM25 유관 상위 MYSQL_TOP_N
    category = _extract_category(question)
    debug["filters"] = {"category": category}
    rows = mysql_search.search(project_id)
    if category is not None:
        matched = [r for r in rows if r["category"] == category]
        others = [r for r in rows if r["category"] != category]
        supplement = []
        if others:
            o_scores = _bm25_scores(question, [r["content"] or "" for r in others])
            top = sorted(range(len(others)), key=lambda i: -o_scores[i])[:MYSQL_SUPPLEMENT]
            supplement = [others[i] for i in sorted(top)]
        matched_limit = max(1, QA_MYSQL_ROWS_LIMIT - len(supplement))
        rows = matched[:matched_limit] + supplement
    elif len(rows) > MYSQL_TOP_N:
        m_scores = _bm25_scores(question, [r["content"] or "" for r in rows])
        top = sorted(range(len(rows)), key=lambda i: -m_scores[i])[:MYSQL_TOP_N]
        rows = [rows[i] for i in sorted(top)]  # 원래 순서(최신순) 유지
    rows = rows[:QA_MYSQL_ROWS_LIMIT]
    mysql_ctx = "\n".join(
        _format_mysql_row(r)
        for r in rows
    )
    for r in rows:
        if r["source"] not in sources:
            sources.append(r["source"])
    debug["mysql_rows"] = [
        {
            "category": r["category"],
            "content": r["content"],
            "source": r["source"],
            "owner": r.get("owner"),
            "date": _short_date(r.get("date")),
            "due_date": _short_date(r.get("due_date")),
            "completed": bool(r.get("completed_at")),
        }
        for r in rows
    ]

    # 2) 원문 맥락 — 하이브리드 후보(BM25 키워드 + dense 의미) → 한국어 cross-encoder 리랭커로
    #    재점수화해 상위 N 청크. 회의록은 고유명사·용어·날짜가 많아 BM25가 dense를 보완하고,
    #    리랭커가 질문-청크 쌍을 직접 비교해 최종 정밀도를 끌어올린다.
    raw = get_collection().get(where={"project_id": project_id})
    texts = raw.get("documents") or []
    metas = raw.get("metadatas") or []
    kept: list = []  # (idx, {"bm25_rank": r|None, "dense_rank": r|None, "rerank_score": s})
    if texts:
        # a. dense 순위 — 벡터 검색 상위 K를 코퍼스 인덱스로 매핑
        scored = _get_vectorstore().similarity_search_with_score(
            question, k=min(CHROMA_K, len(texts)), filter={"project_id": project_id}
        )
        text2idx = {t: i for i, t in enumerate(texts)}
        dense_ranks = [text2idx[d.page_content] for d, _ in scored if d.page_content in text2idx]

        # b. BM25 순위 — 프로젝트 청크 전체에서 상위 K
        b_scores = _bm25_scores(question, texts)
        bm25_ranks = sorted(range(len(texts)), key=lambda i: -b_scores[i])[:CHROMA_K]

        # c. 후보군(중복 제거) → 리랭커 재점수화 → 상위 CHROMA_TOP_N.
        #    리랭커 실패(모델 미설치·로드 오류 등) 시 BM25+dense RRF로 폴백해 원문 맥락이 비지 않게 한다.
        candidate_indices = list(set(dense_ranks + bm25_ranks))
        if candidate_indices:
            try:
                import torch
                model, tokenizer = _get_reranker()
                pairs = [[question, texts[i]] for i in candidate_indices]
                with torch.no_grad():
                    inputs = tokenizer(pairs, padding=True, truncation=True,
                                       return_tensors="pt", max_length=512)
                    if torch.cuda.is_available():
                        inputs = {k: v.to("cuda") for k, v in inputs.items()}
                    scores = model(**inputs).logits.view(-1).cpu().float().tolist()
                reranked = sorted(zip(candidate_indices, scores), key=lambda x: -x[1])[:CHROMA_TOP_N]
            except Exception:
                import logging
                logging.getLogger(__name__).warning("리랭커 실패 → BM25+dense RRF 폴백", exc_info=True)
                rrf = _rrf_fuse([bm25_ranks, dense_ranks], [BM25_WEIGHT, 1.0 - BM25_WEIGHT], len(texts))
                reranked = [(i, rrf[i])
                            for i in sorted(candidate_indices, key=lambda i: -rrf[i])[:CHROMA_TOP_N]]
            kept = [
                (i, {
                    "bm25_rank": bm25_ranks.index(i) + 1 if i in bm25_ranks else None,
                    "dense_rank": dense_ranks.index(i) + 1 if i in dense_ranks else None,
                    "rerank_score": round(score, 5),
                })
                for i, score in reranked
            ]

    chroma_ctx = "\n".join(texts[i] for i, _ in kept)
    for i, _ in kept:
        src = (metas[i] or {}).get("source", "")
        if src and src not in sources:
            sources.append(src)
    debug["chroma_chunks"] = [
        # 디버그용: 앞 200자 + 융합 근거(순위·점수). text_full은 평가 스크립트용 전체 본문.
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
    """질문에 대한 답변을 생성하는 메인 함수 (LangChain RAG).
    1. 항상 MySQL(구조화) + ChromaDB(원문 맥락) 두 소스를 교차 조회
    2. _build_context로 컨텍스트 조합
    3. 대화 히스토리 + 컨텍스트를 LangChain 체인에 전달해 답변 생성
    route 인자는 호환성 위해 유지하나 항상 'both'로 동작한다.

    DEPRECATED (폐기 예정): Streamlit 데모 전용 함수. 정본 출력 경로는 graph.run_qa()이며
    프론트가 /query에 연결되면 이 함수의 호출자는 사라진다. Streamlit 폐기와 함께 삭제할 것.
    엔진 부품(_build_context / _get_chain)은 run_qa가 계속 쓰므로 이 함수만 지운다.
    신규 호출부는 answer() 대신 graph.run_qa()를 사용하라.
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
