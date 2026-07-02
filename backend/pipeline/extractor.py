# 문서 텍스트에서 결정/액션/이슈/리스크를 LLM으로 추출하는 모듈.
# 대용량 문서는 3000자 단위 청크로 분할해 각각 추출한 뒤 합산하고 중복을 제거한다.
import re
from typing import List, Set, Tuple
from .models import MemoryItem, ExtractionResult
from ..llm import get_llm_client, Message


class PartialExtractionError(Exception):
    """멀티청크 추출 중 일부 청크만 실패했을 때 raise. 부분 결과(items)를 속성으로 포함."""
    def __init__(self, items: List[MemoryItem], failed: int, total: int):
        self.items = items
        self.failed = failed
        self.total = total
        super().__init__(f"{failed}/{total} chunks failed — partial results available")

# LLM에게 전달하는 추출 지침.
# 날짜는 반드시 YYYY-MM-DD 형식, 마감일은 content에 포함시키도록 명시.
SYSTEM_PROMPT = """Extract project decision-related information from the input text.
Rules:
- Extract one object per decision/action/issue/risk.
- Do not extract unclear or ambiguous information.
- Keep extracted content in the same language as the input.
- For action owner, use the assigned person or the person who says
  "~하겠습니다", "~진행하겠습니다", "~공유드리겠습니다", "~정리하겠습니다".
- For decision, owner is the proposer or speaker.
- For issue, owner is the person who raised it.
- For risk, owner is the person who mentioned it.
[Category Definitions & Examples]
- decision: Formally agreed or concluded matters. (e.g., "기술 스택을 FastAPI로 결정함")
- action: Tasks assigned to a specific person with clear next steps. (e.g., "홍길동님이 API 명세서를 작성하겠습니다")
- issue: Current problems that have already occurred and need immediate attention. (e.g., "MySQL 연결 테스트 중 타임아웃 발생")
- risk: Potential future threats, uncertainties, or schedule bottlenecks. (e.g., "다음 달 백엔드 인력 부족으로 일정 지연 우려")
- Do not infer unstated reasons.
- reason field is only for decision category, leave null otherwise.
- topic field: short keyword theme (2-5 words) summarizing what the item is about, e.g. "기술스택 선정", "일정 리스크", "UI 설계". Always fill this in.
- date field must always be the meeting or document date, not a deadline. Format: YYYY-MM-DD (e.g. 2026-06-02). Never use Korean format like "2026년 6월 2일".
- For action items, if a deadline is mentioned, append it to content (e.g. "문서 초안 작성 (~6/22까지)"). Do not put the deadline in the date field."""

_REPO_PROMPTS = {
    "repo_readme": """

Source-specific rules for repository README:
- These source-specific rules override the general extraction examples below.
- This source is a README, not a meeting note.
- Do not extract installation steps, usage instructions, setup commands, CLI examples, or prerequisites as action items.
- Do not extract actions from sections such as Install, Usage, Quick start, Getting started, Environment, Docker, Build, Run, 실행, 설치, 개발 환경, or 사용법.
- Extract project purpose, architecture, technology decisions, explicit limitations, known issues, and risks.
- Extract action items only from explicit Roadmap/TODO/Next steps sections and only when the item is clearly unfinished.
- Before returning an action item, verify that it comes from an explicit roadmap/TODO/next-step section. Otherwise omit it.
""",
    "repo_commits": """

Source-specific rules for repository commits:
- These source-specific rules override the general extraction examples below.
- Commits are records of work that already happened.
- If extracting a commit as an action, the action is already completed and completed must be true.
- Use the commit date as the date field when present.
- Extract valuable decisions such as migrations, architecture changes, or technology choices.
- Do not create unfinished action items from past-tense commit messages.
""",
    "repo_issues": """

Source-specific rules for open repository issues:
- Open issues mainly represent current issues, risks, or unresolved work.
- Existing action extraction is acceptable when the issue body clearly assigns next steps.
- Do not mark open issue actions as completed unless the text explicitly says they are already done.
""",
    "repo_prs": """

Source-specific rules for open repository pull requests:
- Open PRs represent in-progress work.
- Extract concrete pending review/merge/follow-up work as action items.
- Do not mark open PR actions as completed unless the text explicitly says a subtask is already done.
- Extract decisions when the PR states a clear implementation or architecture choice.
""",
}

_CHUNK_SIZE = 3000  # 청크당 최대 문자 수
_CHUNK_OVERLAP = 200  # 청크 경계에서 문맥 유지를 위해 앞 청크와 겹치는 문자 수


def _system_prompt(source_kind: str) -> str:
    """기본 회의록 프롬프트는 유지하고 repo 소스에만 우선 지침을 더한다."""
    return _REPO_PROMPTS.get(source_kind, "") + SYSTEM_PROMPT


_README_ACTION_BLOCKLIST = (
    ".env",
    "api 키",
    "build",
    "db 비밀번호",
    "docker",
    "environment",
    "getting started",
    "install",
    "mysql",
    "node.js",
    "prerequisite",
    "quick start",
    "requirements",
    "run",
    "rust",
    "setup",
    "usage",
    "cargo",
    "xcode",
    "webview2",
    "빌드",
    "사용법",
    "설치",
    "실행",
    "의존성",
    "환경변수",
    "개발 환경",
)


def _post_process_items(items: List[MemoryItem], source_kind: str) -> List[MemoryItem]:
    """repo 소스에서 LLM이 지침을 어긴 대표 케이스를 결정적으로 정리한다."""
    if source_kind == "repo_commits":
        for item in items:
            if item.category == "action":
                item.completed = True
        return items

    if source_kind != "repo_readme":
        return items

    filtered = []
    for item in items:
        if item.category != "action":
            filtered.append(item)
            continue
        content = item.content.lower()
        if any(term in content for term in _README_ACTION_BLOCKLIST):
            continue
        filtered.append(item)
    return filtered


def _split_chunks(text: str) -> List[str]:
    """텍스트를 _CHUNK_SIZE 단위로 분할. 짧으면 그대로 반환."""
    if len(text) <= _CHUNK_SIZE:
        return [text]
    chunks = []
    start = 0
    while start < len(text):
        end = start + _CHUNK_SIZE
        chunks.append(text[start:end])
        start = end - _CHUNK_OVERLAP  # 오버랩만큼 뒤로 물려서 다음 청크 시작
    return chunks


def _extract_chunk(client, text: str, default_source: str, source_kind: str) -> List[MemoryItem]:
    """단일 청크를 LLM function calling으로 구조화 추출.
    tool_input=None → LLM이 tool call 자체를 안 한 것(실패), ValueError raise.
    items=[] → 추출할 내용 없음(정상 빈 결과).
    """
    response = client.chat(
        messages=[Message(role="user", content=f"Input:\n{text}")],
        system=_system_prompt(source_kind),
        tool_schema=ExtractionResult.model_json_schema(),
        tool_name="extract_memory",
    )
    # tool_input이 None이면 LLM이 tool call 자체를 안 한 것 (진짜 실패)
    # items가 빈 리스트면 추출할 내용이 없는 것 (정상)
    if response.tool_input is None:
        raise ValueError("LLM did not return tool output for chunk")
    items = ExtractionResult(**response.tool_input).items
    for item in items:
        if not item.source:
            item.source = default_source  # LLM이 source 미반환 시 파일명으로 fallback
    return _post_process_items(items, source_kind)


def _norm_date_key(date_str: str) -> str:
    """중복 제거 키 생성용 날짜 정규화. '2026년 6월 2일' → '2026-06-02'."""
    if not date_str:
        return ""
    m = re.match(r'(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일', date_str)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.match(r'(\d{4})[./](\d{1,2})[./](\d{1,2})', date_str)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return date_str.strip()


def _dedup(items: List[MemoryItem]) -> List[MemoryItem]:
    """청크 경계 오버랩으로 생긴 중복 항목 제거.
    (category, content, 정규화된 date, source) 4개 키 기준으로 판단.
    날짜가 같아도 date 표현이 다른 경우를 위해 _norm_date_key 적용.
    """
    seen: Set[Tuple] = set()
    result = []
    for item in items:
        key = (
            item.category,
            item.content.strip().lower(),
            _norm_date_key(item.date or ""),
            (item.source or "").strip().lower(),
        )
        if key not in seen:
            seen.add(key)
            result.append(item)
    return result


def extract(
    text: str,
    provider: str = None,
    default_source: str = "",
    source_kind: str = "document",
) -> List[MemoryItem]:
    """메인 추출 함수.
    1. 텍스트를 청크로 분할
    2. 청크별 LLM 추출 (_extract_chunk)
    3. 결과 합산 후 중복 제거 (_dedup)
    일부 청크 실패 시 PartialExtractionError(부분 결과 포함) raise.
    전체 실패 시 ValueError raise.
    """
    client = get_llm_client(provider)
    chunks = _split_chunks(text)

    # 단일 청크면 바로 추출 후 반환 (dedup 불필요)
    if len(chunks) == 1:
        return _extract_chunk(client, chunks[0], default_source, source_kind)

    all_items: List[MemoryItem] = []
    failed_chunks = 0
    for chunk in chunks:
        try:
            all_items.extend(_extract_chunk(client, chunk, default_source, source_kind))
        except ValueError:
            failed_chunks += 1  # 청크 실패 카운트, 나머지 청크는 계속 처리

    if failed_chunks == len(chunks):
        raise ValueError("LLM did not return structured output for any chunk")

    deduped = _dedup(all_items)

    if failed_chunks > 0:
        raise PartialExtractionError(deduped, failed_chunks, len(chunks))

    return deduped
