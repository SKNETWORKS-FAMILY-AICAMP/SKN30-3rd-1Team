"""질문 의도별 Q&A 분기.

semantic 경로는 기존 graph.run_qa()가 그대로 담당하므로 여기서는
규칙/LLM 라우팅, 구조화 조회, 조망형 컨텍스트 생성만 맡는다.
"""
import json
import re
from collections import Counter
from typing import Dict, List, Literal, Optional

from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel

from . import history_intent, mysql_search, qa_engine
from ..db.mysql import get_connection
from ..llm.chat_model_factory import get_chat_model


RouteLabel = Literal["filter_lookup", "overview", "semantic"]
MemoryCategory = Literal["decision", "action", "issue", "risk"]
CompletionStatus = Literal["open", "completed", "unknown"]
FAST_MODEL_TIER = "fast"


ROUTER_CLASSIFICATION_PROMPT = """당신은 PaiM Q&A 질문 라우터입니다.
현재 질문과 최근 사용자 질문을 보고 다음 세 레이블 중 하나만 고릅니다.

- filter_lookup: 담당자, 완료/미완료, 개수, 목록, 마감, 기한처럼 memory 테이블의 구조화 필터로 직접 답할 수 있는 질문
- overview: 프로젝트 전체 상황, 현황, 요약, 정리, 브리핑처럼 전체 조망을 요청하는 질문
- semantic: 이유, 배경, 근거, 의미 탐색, 일반 대화처럼 검색 컨텍스트와 생성 답변이 필요한 질문
- 특정 작업·기능을 지목하며 그 상태/완료 여부를 묻는 질문은 semantic입니다.
  filter_lookup은 조건 나열형 질의 전용입니다.

예시:
- "박제섭이 담당인 미완료 액션은?" => filter_lookup
- "완료된 액션 몇 개야?" => filter_lookup
- "마감 지난 거 있어?" => filter_lookup
- "프로젝트 전체 상황 정리해줘" => overview
- "데스크탑 앱 FastAPI 연동 작업은 실제로 끝났어?" => semantic

후속 질문이면 최근 사용자 질문의 필터 맥락을 참고합니다.
애매하거나 프로젝트 기록 의도가 약하면 semantic을 선택합니다.
"""

FILTER_EXTRACTION_PROMPT = """PaiM memory 테이블 조회용 필터를 추출합니다.
현재 질문이 후속 질문이면 최근 사용자 질문의 owner/category 맥락을 승계합니다.

필드 규칙:
- owner: 담당자 이름만 추출합니다. 없으면 null.
- category: decision/action/issue/risk 중 하나. 액션, 할 일, 태스크는 action입니다. 없으면 null.
- completion_status: 완료된 것은 completed, 미완료/열린/남은 것은 open,
  완료 여부를 확인할 수 없으면 unknown, 상태 조건이 없으면 null.
- due_within_days: N일 이내/마감 임박이면 N을 정수로 둡니다. 명시가 없으면 null.
- overdue: 마감 지난/기한 초과이면 true, 아니면 null.
"""

OVERVIEW_SYSTEM_PROMPT = qa_engine.SYSTEM_QA + """

이번 질문은 조망형 질문입니다.
검색은 하지 않았고, 아래 직접 컨텍스트만 사용합니다.
overview_summary와 action_plan을 바탕으로 프로젝트 전체 상황을 간결하게 정리하세요.
action_plan은 현재 유효한 액션 전체를 담은 참고 데이터이며 status_counts가 현재 상태의
권위 있는 집계입니다. 사용자가 전체 목록을
명시적으로 요구하지 않았다면 질문에 필요한 핵심 액션만 골라 답하세요.
액션의 현재 상태는 completion_status만 근거로 판단하세요. unknown이면 완료 여부 미확인으로
표현하고 open·미완료·진행 중으로 단정하지 마세요. content나 overview_summary 안의
"진행", "작업" 같은 단어는 현재 상태를 증명하지 않습니다.
요약과 구체적인 액션 행이 충돌하면 구체적인 액션 행을 우선하세요.
진행 상황, 새로 확인된 내용, 주의할 일을 구분해 Markdown으로 읽기 쉽게 답하세요.
"""

_FILTER_RULE_RE = re.compile(r"(담당|누가|몇\s*개|몇개|목록|리스트|마감|기한|지난)")
_OVERVIEW_RE = re.compile(r"(전체|요약|현황|정리|브리핑|상황|프로젝트\s*상태)")


class QueryRoute(BaseModel):
    """라우터가 선택한 질문 경로."""

    route: RouteLabel
    router_stage: str
    history_mode: bool = False


class RouteDecision(BaseModel):
    """LLM 라우터 구조화 출력."""

    label: RouteLabel


class QueryFilters(BaseModel):
    """filter_lookup 경로에서 사용할 MySQL 필터."""

    owner: Optional[str] = None
    category: Optional[MemoryCategory] = None
    completion_status: Optional[CompletionStatus] = None
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
    # 이력 질문 사전 판정 — 기존 규칙보다 우선한다. "변경 이력 정리해줘"(정리→overview),
    # "이전 결정 목록"(목록→filter_lookup)처럼 이력 질문이 다른 규칙에 걸려
    # 체인 없는 경로로 새는 것을 막고 semantic + history_mode로 확정한다.
    if history_intent.detect_history_intent(question):
        return QueryRoute(route="semantic", router_stage="history_rule", history_mode=True)
    has_filter = bool(_FILTER_RULE_RE.search(question))
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
    if filters.completion_status == "completed":
        labels.append("완료됨")
    elif filters.completion_status == "open":
        labels.append("미완료")
    elif filters.completion_status == "unknown":
        labels.append("완료 여부 미확인")
    if filters.overdue:
        labels.append("기한 초과")
    if filters.due_within_days is not None:
        labels.append(f"{filters.due_within_days}일 이내 마감")
    return " · ".join(labels) if labels else "필터 없음"


def _format_lookup_row(row: Dict) -> str:
    """조회 결과 한 행을 담당/마감/완료 메타데이터와 함께 한 줄로 만든다."""
    meta = []
    if row.get("owner"):
        meta.append(f"담당: **{row['owner']}**")
    if _short_date(row.get("due_date")):
        meta.append(f"마감: *{_short_date(row.get('due_date'))}*")
    if row.get("category") == "action":
        completed_at = _short_date(row.get("completed_at"))
        status = row.get("completion_status") or ("completed" if completed_at else "unknown")
        if status == "completed":
            meta.append(f"완료: *{completed_at}*" if completed_at else "**완료**")
        elif status == "open":
            meta.append("**미완료**")
        else:
            meta.append("**완료 여부 미확인**")
    suffix = f" — {' · '.join(meta)}" if meta else ""
    return f"- **[{row.get('category')}]** {row.get('content')}{suffix}"


def answer_filter_lookup(project_id: int, question: str, history: List[Dict] | None, router_stage: str) -> Dict:
    """구조화 필터로 memory를 직접 조회하고 LLM 없이 템플릿 답변을 반환한다."""
    filters = extract_filters(question, history)
    rows = mysql_search.search(
        project_id,
        category=filters.category,
        owner=filters.owner,
        completion_status=filters.completion_status,
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
        answer = f"**조건에 맞는 기록이 없습니다.** _({filter_text})_"
    else:
        answer = f"**조건에 맞는 기록 {len(rows)}건입니다.** _({filter_text})_\n\n" + "\n".join(
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
    """조망형 답변에 필요한 프로젝트 요약과 전체 Action Plan을 모은다."""
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT summary FROM project_memory WHERE project_id = %s", (project_id,))
            project_memory = cursor.fetchone() or {}
            cursor.execute(
                "SELECT category, COUNT(*) AS count FROM active_memory"
                " WHERE project_id = %s GROUP BY category",
                (project_id,),
            )
            stats = cursor.fetchall()
            # active_memory를 읽어 번복된 행은 제외하되, 임의의 Top-N으로
            # 중요한 액션을 LLM 입력 전에 버리지 않는다.
            cursor.execute(
                "SELECT id, content, owner, date, due_date, completed_at,"
                " completion_status, completion_status_source, source"
                " FROM active_memory"
                " WHERE project_id = %s AND category = 'action'"
                " ORDER BY (sort_order IS NULL), sort_order ASC, created_at ASC, id ASC",
                (project_id,),
            )
            action_items = cursor.fetchall()
    finally:
        conn.close()
    counts = Counter(row.get("completion_status") for row in action_items)
    category_stats = {category: 0 for category in ("decision", "action", "issue", "risk")}
    category_stats.update({row["category"]: row["count"] for row in stats})
    return {
        "overview_summary": project_memory.get("summary", ""),
        "category_stats": category_stats,
        "action_plan": {
            "total": len(action_items),
            "status_counts": {
                status: counts[status]
                for status in ("open", "completed", "unknown")
            },
            "items": action_items,
        },
    }


def answer_overview(project_id: int, question: str, router_stage: str) -> Dict:
    """검색 없이 프로젝트 요약과 전체 Action Plan으로 조망형 답변을 생성한다."""
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
    for row in context["action_plan"]["items"]:
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
                "action_plan_total": context["action_plan"]["total"],
            },
        },
    }
