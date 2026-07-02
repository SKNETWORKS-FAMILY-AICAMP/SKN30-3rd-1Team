"""질문 의도별 Q&A 분기.

semantic 경로는 기존 graph.run_qa()가 그대로 담당하므로 여기서는
규칙/LLM 라우팅, 구조화 조회, 조망형 컨텍스트 생성만 맡는다.
"""
import json
import re
from typing import Dict, List, Literal, Optional

from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel

from . import mysql_search, qa_engine
from ..db.mysql import get_connection
from ..llm.chat_model_factory import get_chat_model


RouteLabel = Literal["filter_lookup", "overview", "semantic"]
MemoryCategory = Literal["decision", "action", "issue", "risk"]
FAST_MODEL_TIER = "fast"


ROUTER_CLASSIFICATION_PROMPT = """당신은 PaiM Q&A 질문 라우터입니다.
현재 질문과 최근 사용자 질문을 보고 다음 세 레이블 중 하나만 고릅니다.

- filter_lookup: 담당자, 완료/미완료, 개수, 목록, 마감, 기한처럼 memory 테이블의 구조화 필터로 직접 답할 수 있는 질문
- overview: 프로젝트 전체 상황, 현황, 요약, 정리, 브리핑처럼 전체 조망을 요청하는 질문
- semantic: 이유, 배경, 근거, 의미 탐색, 일반 대화처럼 검색 컨텍스트와 생성 답변이 필요한 질문

후속 질문이면 최근 사용자 질문의 필터 맥락을 참고합니다.
애매하거나 프로젝트 기록 의도가 약하면 semantic을 선택합니다.
"""

FILTER_EXTRACTION_PROMPT = """PaiM memory 테이블 조회용 필터를 추출합니다.
현재 질문이 후속 질문이면 최근 사용자 질문의 owner/category 맥락을 승계합니다.

필드 규칙:
- owner: 담당자 이름만 추출합니다. 없으면 null.
- category: decision/action/issue/risk 중 하나. 액션, 할 일, 태스크는 action입니다. 없으면 null.
- completed: 완료된 것은 true, 미완료/열린/남은 것은 false, 불명이면 null.
- due_within_days: N일 이내/마감 임박이면 N을 정수로 둡니다. 명시가 없으면 null.
- overdue: 마감 지난/기한 초과이면 true, 아니면 null.
"""

OVERVIEW_SYSTEM_PROMPT = qa_engine.SYSTEM_QA + """

이번 질문은 조망형 질문입니다.
검색은 하지 않았고, 아래 직접 컨텍스트만 사용합니다.
프로젝트 전체 상황을 결정/액션/이슈/리스크와 열린 액션 중심으로 간결하게 정리하세요.
"""

_FILTER_RE = re.compile(
    r"(담당|누가|몇\s*개|몇개|목록|리스트|완료된|완료|미완료|남은|열린|마감|기한|지난|액션|할\s*일|할일|태스크)"
)
_OVERVIEW_RE = re.compile(r"(전체|요약|현황|정리|브리핑|상황|상태)")


class QueryRoute(BaseModel):
    """라우터가 선택한 질문 경로."""

    route: RouteLabel
    router_stage: str


class RouteDecision(BaseModel):
    """LLM 라우터 구조화 출력."""

    label: RouteLabel


class QueryFilters(BaseModel):
    """filter_lookup 경로에서 사용할 MySQL 필터."""

    owner: Optional[str] = None
    category: Optional[MemoryCategory] = None
    completed: Optional[bool] = None
    due_within_days: Optional[int] = None
    overdue: Optional[bool] = None


class SemanticFallback(Exception):
    """특수 경로 처리 실패 시 기존 semantic 경로로 넘기기 위한 신호."""


def _recent_user_questions(history: List[Dict] | None) -> List[str]:
    """라우터/필터가 후속 질문을 해석하도록 최근 사용자 질문만 2개 뽑는다."""
    questions = [
        str(message.get("content", "")).strip()
        for message in (history or [])
        if message.get("role") == "user" and str(message.get("content", "")).strip()
    ]
    return questions[-2:]


def _routing_input(question: str, history: List[Dict] | None) -> str:
    """LLM에 넘길 최근 질문 맥락을 짧게 만든다."""
    previous = _recent_user_questions(history)
    if not previous:
        return f"현재 질문: {question}"
    return "최근 사용자 질문:\n" + "\n".join(f"- {q}" for q in previous) + f"\n\n현재 질문: {question}"


def classify_question(question: str, history: List[Dict] | None = None) -> QueryRoute:
    """규칙으로 먼저 분기하고, 애매하면 LLM 구조화 분류로 라우팅한다."""
    has_filter = bool(_FILTER_RE.search(question))
    has_overview = bool(_OVERVIEW_RE.search(question))
    if has_filter and not has_overview:
        return QueryRoute(route="filter_lookup", router_stage="rule")
    if has_overview and not has_filter:
        return QueryRoute(route="overview", router_stage="rule")

    prompt = ChatPromptTemplate.from_messages([
        ("system", ROUTER_CLASSIFICATION_PROMPT),
        ("human", "{question_context}"),
    ])
    try:
        decision = (prompt | get_chat_model(tier=FAST_MODEL_TIER).with_structured_output(RouteDecision)).invoke({
            "question_context": _routing_input(question, history),
        })
    except Exception:
        return QueryRoute(route="semantic", router_stage="llm")
    return QueryRoute(route=decision.label, router_stage="llm")


def extract_filters(question: str, history: List[Dict] | None = None) -> QueryFilters:
    """LLM 구조화 출력으로 담당자/상태/마감 필터를 추출한다."""
    prompt = ChatPromptTemplate.from_messages([
        ("system", FILTER_EXTRACTION_PROMPT),
        ("human", "{question_context}"),
    ])
    try:
        return (prompt | get_chat_model(tier=FAST_MODEL_TIER).with_structured_output(QueryFilters)).invoke({
            "question_context": _routing_input(question, history),
        })
    except Exception as exc:
        raise SemanticFallback() from exc


def _short_date(value) -> str:
    """날짜/일시 값을 YYYY-MM-DD 형태로 표시한다."""
    return str(value)[:10] if value else ""


def _filters_text(filters: QueryFilters) -> str:
    """사용자에게 보여줄 조회 필터 설명."""
    labels = []
    if filters.owner:
        labels.append(f"담당자={filters.owner}")
    if filters.category:
        labels.append(f"분류={filters.category}")
    if filters.completed is True:
        labels.append("완료됨")
    elif filters.completed is False:
        labels.append("미완료")
    if filters.overdue:
        labels.append("기한 초과")
    if filters.due_within_days is not None:
        labels.append(f"{filters.due_within_days}일 이내 마감")
    return ", ".join(labels) if labels else "필터 없음"


def _format_lookup_row(row: Dict) -> str:
    """조회 결과 한 행을 담당/마감/완료 메타데이터와 함께 한 줄로 만든다."""
    meta = []
    if row.get("owner"):
        meta.append(f"담당: {row['owner']}")
    if _short_date(row.get("due_date")):
        meta.append(f"마감: {_short_date(row.get('due_date'))}")
    if _short_date(row.get("completed_at")):
        meta.append(f"완료: {_short_date(row.get('completed_at'))}")
    elif row.get("category") == "action":
        meta.append("미완료")
    suffix = f" ({', '.join(meta)})" if meta else ""
    return f"- [{row.get('category')}] {row.get('content')}{suffix}"


def answer_filter_lookup(project_id: int, question: str, history: List[Dict] | None, router_stage: str) -> Dict:
    """구조화 필터로 memory를 직접 조회하고 LLM 없이 템플릿 답변을 반환한다."""
    filters = extract_filters(question, history)
    rows = mysql_search.search(
        project_id,
        category=filters.category,
        owner=filters.owner,
        completed=filters.completed,
        due_within_days=filters.due_within_days,
        overdue=filters.overdue,
    )
    sources = []
    for row in rows:
        source = row.get("source")
        if source and source not in sources:
            sources.append(source)

    filter_text = _filters_text(filters)
    if not rows:
        answer = f"조건에 맞는 기록 없음. 조회 필터: {filter_text}"
    else:
        answer = f"조건에 맞는 기록 {len(rows)}건입니다. 조회 필터: {filter_text}\n" + "\n".join(
            _format_lookup_row(row) for row in rows
        )

    return {
        "answer": answer,
        "plan": [],
        "sources": sources,
        "route": "filter_lookup",
        "debug": {
            "route": "filter_lookup",
            "router_stage": router_stage,
            "filter_model_tier": FAST_MODEL_TIER,
            "filters": filters.model_dump(),
            "rows": len(rows),
        },
    }


def _fetch_overview_context(project_id: int) -> Dict:
    """조망형 답변에 필요한 프로젝트 요약/통계/액션을 SQL로 직접 모은다."""
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT summary FROM project_memory WHERE project_id = %s", (project_id,))
            project_memory = cursor.fetchone() or {}
            cursor.execute(
                "SELECT category, COUNT(*) AS count FROM memory WHERE project_id = %s GROUP BY category",
                (project_id,),
            )
            stats = cursor.fetchall()
            cursor.execute(
                "SELECT id, category, content, owner, due_date, completed_at, source"
                " FROM memory"
                " WHERE project_id = %s AND category = 'action' AND completed_at IS NULL"
                " ORDER BY (due_date IS NULL), due_date ASC, created_at DESC"
                " LIMIT 8",
                (project_id,),
            )
            open_actions = cursor.fetchall()
            cursor.execute(
                "SELECT id, category, content, owner, due_date, completed_at, source"
                " FROM memory"
                " WHERE project_id = %s AND category = 'action' AND completed_at IS NOT NULL"
                " ORDER BY completed_at DESC"
                " LIMIT 5",
                (project_id,),
            )
            completed_actions = cursor.fetchall()
    finally:
        conn.close()
    return {
        "project_memory": project_memory.get("summary", ""),
        "category_stats": {row["category"]: row["count"] for row in stats},
        "open_actions": open_actions,
        "recent_completed_actions": completed_actions,
    }


def answer_overview(project_id: int, question: str, router_stage: str) -> Dict:
    """검색 없이 프로젝트 요약/통계/액션 컨텍스트만으로 조망형 답변을 생성한다."""
    context = _fetch_overview_context(project_id)
    prompt = ChatPromptTemplate.from_messages([
        ("system", OVERVIEW_SYSTEM_PROMPT),
        ("human", "직접 컨텍스트(JSON):\n{context}\n\n질문: {question}"),
    ])
    answer = (prompt | get_chat_model() | StrOutputParser()).invoke({
        "context": json.dumps(context, ensure_ascii=False, default=str),
        "question": question,
    })
    sources = []
    for row in list(context["open_actions"]) + list(context["recent_completed_actions"]):
        source = row.get("source")
        if source and source not in sources:
            sources.append(source)
    return {
        "answer": answer,
        "plan": [],
        "sources": sources,
        "route": "overview",
        "debug": {
            "route": "overview",
            "router_stage": router_stage,
            "router_model_tier": FAST_MODEL_TIER if router_stage == "llm" else None,
            "overview": {
                "category_stats": context["category_stats"],
                "open_actions": len(context["open_actions"]),
                "recent_completed_actions": len(context["recent_completed_actions"]),
            },
        },
    }
