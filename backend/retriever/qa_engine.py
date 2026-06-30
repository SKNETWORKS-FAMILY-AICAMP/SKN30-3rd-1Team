# Q&A 엔진: 질문 → 컨텍스트 조회(SQL+Chroma) → LLM 답변 생성
# 신뢰도 향상을 위해 항상 MySQL(구조화 기록)과 ChromaDB(원문 맥락) 두 소스를
# 모두 조회해 교차 확인한 뒤 LLM에 전달한다.
from typing import List, Dict
from . import mysql_search, chroma_search
from ..llm import get_llm_client, Message

MAX_HISTORY = 10  # 대화 히스토리 최대 유지 턴 수 (컨텍스트 길이 제한)

# 답변 신뢰도 향상용 시스템 지침: 구조화 기록을 우선 근거로, 원문 맥락으로 보강,
# 충돌 시 명시, 컨텍스트 밖 내용은 지어내지 말 것, 출처 표기.
SYSTEM_QA = """당신은 프로젝트 기록을 근거로 답하는 AI 어시스턴트입니다.
- 구조화된 기록(결정/액션/이슈/리스크)을 우선 근거로 삼고, 원문 맥락으로 보강하라.
- 두 근거가 충돌하면 그 사실을 답변에 밝혀라.
- 제공된 컨텍스트에 없는 내용은 추측하지 말고 모른다고 답하라.
- 답변 마지막에 근거가 된 출처를 표기하라."""


def _build_context(project_id: int, question: str, route: str) -> tuple[str, List[str], dict]:
    """라우트에 따라 MySQL / ChromaDB에서 컨텍스트를 조회하고 문자열로 조합.
    반환: (컨텍스트 문자열, 출처 목록, 디버그 dict)
    debug dict는 프론트엔드 디버그 expander에 표시됨.
    """
    sources = []
    debug: dict = {"mysql_rows": [], "chroma_chunks": []}

    if route in ("mysql", "both"):
        # 구조화 DB에서 카테고리/내용/출처 조회
        rows = mysql_search.search(project_id)
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
    else:
        mysql_ctx = ""

    if route in ("chroma", "both"):
        # 벡터 유사도로 관련 원문 청크 검색
        chunks = chroma_search.search(project_id, question)
        chroma_ctx = "\n".join(c["text"] for c in chunks)
        for c in chunks:
            src = c["metadata"].get("source", "")
            if src and src not in sources:
                sources.append(src)
        debug["chroma_chunks"] = [
            # 디버그용: 청크 앞 200자만 표시
            {"text": c["text"][:200], "source": c["metadata"].get("source", ""), "date": c["metadata"].get("date", "")}
            for c in chunks
        ]
    else:
        chroma_ctx = ""

    parts = [p for p in [mysql_ctx, chroma_ctx] if p]
    return "\n\n".join(parts), sources, debug


def answer(
    project_id: int,
    question: str,
    history: List[Dict],
    route: str = None,
) -> Dict:
    """질문에 대한 답변을 생성하는 메인 함수.
    1. 항상 'both' — MySQL(구조화) + ChromaDB(원문 맥락) 두 소스 교차 조회
    2. _build_context로 DB 컨텍스트 조회
    3. 대화 히스토리 + 컨텍스트를 LLM에 전달해 답변 생성
    """
    # 신뢰도 향상: 두 소스를 항상 모두 조회한다. (route 인자로 강제 지정도 가능)
    if route is None:
        route = "both"

    context, sources, debug = _build_context(project_id, question, route)

    # 대화 히스토리를 MAX_HISTORY 턴으로 잘라 컨텍스트 오버플로 방지
    trimmed_history = history[-MAX_HISTORY:]
    messages = [Message(**m) for m in trimmed_history]
    messages.append(Message(
        role="user",
        content=f"프로젝트 컨텍스트:\n{context}\n\n질문: {question}",
    ))

    client = get_llm_client()
    response = client.chat(messages=messages, system=SYSTEM_QA)

    return {
        "answer":  response.content,
        "sources": sources,
        "route":   route,
        "debug":   debug,
    }
