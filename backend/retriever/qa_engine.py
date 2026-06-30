# Q&A 엔진: 질문 → 라우터 분류 → 컨텍스트 조회 → LLM 답변 생성
# classifier가 질문 키워드로 mysql/chroma/both 중 검색 경로를 결정하고,
# 해당 경로에서 컨텍스트를 조합해 LLM에 전달한다.
from typing import List, Dict
from . import classifier, mysql_search, chroma_search
from ..llm import get_llm_client, Message

MAX_HISTORY = 10  # 대화 히스토리 최대 유지 턴 수 (컨텍스트 길이 제한)


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
    1. classifier로 검색 경로 결정 (route 미지정 시)
    2. _build_context로 DB 컨텍스트 조회
    3. 대화 히스토리 + 컨텍스트를 LLM에 전달해 답변 생성
    """
    if route is None:
        route = classifier.classify(question)

    context, sources, debug = _build_context(project_id, question, route)

    # 대화 히스토리를 MAX_HISTORY 턴으로 잘라 컨텍스트 오버플로 방지
    trimmed_history = history[-MAX_HISTORY:]
    messages = [Message(**m) for m in trimmed_history]
    messages.append(Message(
        role="user",
        content=f"프로젝트 컨텍스트:\n{context}\n\n질문: {question}",
    ))

    client = get_llm_client()
    response = client.chat(messages=messages)

    return {
        "answer":  response.content,
        "sources": sources,
        "route":   route,
        "debug":   debug,
    }
