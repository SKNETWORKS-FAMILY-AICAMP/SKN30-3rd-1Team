# PaiM — 에이전트 인수인계 문서

> 작성일: 2026-06-30 | MVP 목업 완료 상태

---

## 프로젝트 목적

회의록·기획서 등 비정형 문서에서 **결정(decision) / 액션(action) / 이슈(issue) / 리스크(risk)** 4종을 LLM으로 구조화 추출해 MySQL + ChromaDB에 저장하고, Q&A 채팅·타임라인으로 조회하는 AI 프로젝트 매니저.

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| 프론트엔드 (MVP) | Streamlit (`frontend/app.py`) |
| 백엔드 API | FastAPI (`backend/main.py`) — **제거 금지, 추후 React 연동용** |
| 구조화 DB | MySQL 8.0 (Docker Compose) |
| 벡터 DB | ChromaDB PersistentClient (`.chroma/` 로컬) |
| LLM | OpenAI / Claude / Google — `LLM_PROVIDER` env로 런타임 전환 |
| 패키지 관리 | `uv` + `hatchling` (`pyproject.toml`) |

---

## 디렉토리 구조

```
PaiM/
├── backend/
│   ├── main.py                  # FastAPI 앱 진입점 (스켈레톤 — 제거 금지)
│   ├── api/                     # FastAPI 라우터 (project, upload, query)
│   ├── pipeline/
│   │   ├── extractor.py         # 청킹 + LLM 추출 + dedup
│   │   ├── ingestor.py          # MySQL + ChromaDB 저장
│   │   └── models.py            # MemoryItem, ExtractionResult (Pydantic)
│   ├── llm/
│   │   ├── factory.py           # get_llm_client() — LLM_PROVIDER 기반 팩토리
│   │   ├── base.py              # BaseLLMClient, Message, LLMResponse
│   │   ├── openai_client.py     # OpenAI function calling
│   │   ├── claude_client.py     # Anthropic tool use
│   │   └── google_client.py     # Google Gemini (Q&A 전용)
│   ├── retriever/
│   │   ├── classifier.py        # 키워드 기반 검색 라우팅
│   │   ├── qa_engine.py         # Q&A 메인 엔진 (debug dict 포함)
│   │   ├── mysql_search.py      # MySQL 구조화 검색
│   │   └── chroma_search.py     # ChromaDB 벡터 검색
│   └── db/
│       ├── mysql.py             # get_connection() — PyMySQL
│       ├── chroma.py            # get_collection() — PersistentClient
│       └── schema.sql           # projects / documents / memory DDL
├── frontend/
│   ├── app.py                   # Streamlit 진입점 + 사이드바 네비게이션
│   ├── views/                   # ⚠️ pages/가 아닌 views/ — Streamlit 자동탐지 방지
│   │   ├── upload.py
│   │   ├── dashboard.py
│   │   ├── chat.py
│   │   └── timeline.py
│   └── components/
│       ├── memory_card.py       # 메모리 카드 HTML 렌더러
│       └── timeline_view.py     # 타임라인 HTML 렌더러
├── data/samples/                # 테스트용 샘플 회의록
├── docker-compose.yml
├── .env                         # git 제외
├── .env.example                 # 환경변수 템플릿 (실제 변수명 기준)
└── pyproject.toml
```

---

## 환경 설정

`.env.example` 기준 실제 변수명:

```env
LLM_PROVIDER=claude          # claude | openai | google

ANTHROPIC_API_KEY=...
CLAUDE_MODEL=claude-sonnet-4-6

OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o

GOOGLE_API_KEY=...
GOOGLE_MODEL=gemini-1.5-pro

DB_HOST=localhost
DB_USER=root
DB_PASSWORD=...
DB_NAME=paiM

CHROMA_PERSIST_DIR=.chroma
```

### 실행 명령

```bash
docker compose up -d
uv sync
uv run streamlit run frontend/app.py --server.port 8502
```

---

## 핵심 설계 결정 (변경 금지)

| 결정 | 이유 |
|------|------|
| FastAPI 유지 | 추후 React 전환 시 사용. 현재 Streamlit이 backend 코드 직접 import해 사용하지만 FastAPI 삭제 금지 |
| `frontend/views/` | `pages/`로 명명하면 Streamlit이 자동 멀티페이지 탐지해 사이드바 중복 nav 발생 |
| `date` 필드 = 회의 날짜 | 액션 마감일은 content에 텍스트로 포함 (`"문서 초안 작성 (~6/22까지)"`). date 필드에 넣지 않음 |
| ChromaDB = 원문 저장 | LLM 추출 결과가 아닌 원문 청크(500자)를 벡터화. Q&A 맥락 검색에 활용 |

---

## 데이터 파이프라인

### 업로드 → 추출 → 저장

```
파일(md/txt/pdf)
  └→ _split_chunks()       3000자 단위, 200자 오버랩 [extractor.py]
       └→ _extract_chunk() LLM function calling → ExtractionResult(Pydantic)
            └→ _dedup()    (category, content, 정규화 날짜, source) 4-key 중복 제거
                 └→ ingest()
                      ├→ MySQL  memory 테이블 INSERT, _normalize_date() 적용
                      └→ ChromaDB  원문 500자 청크 벡터 저장
```

일부 청크 실패 시 `PartialExtractionError(items, failed, total)` raise — 부분 결과 포함.  
전체 실패 시 `ValueError` raise.

### Q&A 검색 라우팅 (`classifier.py`)

| 경로 | 트리거 키워드 |
|------|--------------|
| `mysql` | 미정, 담당, 목록, 누가, 몇 개, 리스트 |
| `chroma` | 왜, 이유, 관련, 어때, 설명, 배경 |
| `both` (기본) | 위 키워드 없음 |

`qa_engine.answer()` 반환값: `{"answer", "sources", "route", "debug"}`.  
`debug`에는 `mysql_rows`, `chroma_chunks` 포함 — `chat.py` expander에서 표시 (서비스 배포 시 제거 예정).

### 날짜 정규화 (2단계)

1. SYSTEM_PROMPT에서 `YYYY-MM-DD` 형식 강제 지시
2. `ingestor._normalize_date()`: 한국어·슬래시·점 형식 폴백 변환 + `datetime()` 유효성 검증

---

## 구현 완료 목록

- [x] 멀티파일 업로드 (md / txt / pdf)
- [x] 날짜 자동 추출 (정규식, 수동 수정 가능)
- [x] 대용량 문서 청킹 (3000자 단위, 200자 오버랩)
- [x] LLM 구조화 추출 (function calling / tool use)
- [x] 부분 실패 처리 (`PartialExtractionError`)
- [x] 중복 제거 (4-key dedup)
- [x] MySQL 날짜 정규화
- [x] ChromaDB 원문 벡터 저장
- [x] MySQL 실패 시 rollback
- [x] 메모리 대시보드 (카테고리별 카드)
- [x] 타임라인 (날짜 그룹화, 카테고리 필터)
- [x] Q&A 채팅 (멀티턴, 프로젝트별 히스토리)
- [x] 검색 컨텍스트 디버그 expander
- [x] 사이드바 커스텀 CSS 버튼 네비게이션
- [x] 프로젝트 목록 collapse/expand (기본 5개)
- [x] XSS 방지 (`html.escape` 전처리)
- [x] 핵심 스크립트 9개 한국어 주석
- [x] 인수인계 문서 (`HANDOVER.html`, `HANDOVER.md`)

---

## 미완료 / 잔여 작업

### Low 우선순위
- [ ] 멀티파일 업로드 시 파일별 날짜 확인·수정 UI (현재 자동 추출만)
- [ ] pytest 자동 테스트 (날짜 정규화, dedup, 추출 실패 시나리오)

### 추후 개선
- [ ] Q&A 검색 라우팅 고도화 (키워드 → 임베딩 기반 의도 분류)
- [ ] 문서/메모리 항목 삭제 기능 (MySQL + ChromaDB 동시)
- [ ] Google provider 구조화 추출 (현재 `NotImplementedError`)
- [ ] MySQL 연결 풀링 (`get_connection()` 매 요청마다 신규 연결 중)
- [ ] FastAPI 엔드포인트 구현 (React 전환 선행 조건)
- [ ] Docker Compose에 Streamlit 컨테이너 추가
- [ ] 채팅 디버그 expander 서비스 배포 시 제거

---

## 해결된 주요 버그 (재발 방지)

| 증상 | 원인 | 해결책 |
|------|------|--------|
| `Unterminated string at char 4560` | 31KB 문서 → max_tokens 초과로 LLM JSON 잘림 | 3000자 청킹 + `finish_reason=="length"` 감지 |
| `Incorrect date value: '2026년 6월 2일'` | LLM이 한국어 날짜 반환 | SYSTEM_PROMPT 강제 + `_normalize_date()` 폴백 |
| `35 validation errors — topic Field required` | `topic: str` 필수인데 LLM이 누락 | `Optional[str] = None` + `Field(description=...)` |
| Streamlit 사이드바 중복 4탭 | `frontend/pages/` 자동 탐지 | `frontend/views/`로 디렉토리명 변경 |
| f-string 백슬래시 SyntaxError | `f'({c[\"date\"]})'` 형식 Python 3 불허 | 변수 먼저 추출 후 f-string 사용 |
| dedup 오작동 | key가 `(category, content)` 2개만 | 4-key `(category, content, 날짜, source)`로 확장 |
| `2026-99-99` 날짜 통과 | 정규식만으로 검증 | `datetime()` 객체로 실제 유효성 검증 |

---

## LLM 제공자별 지원 범위

| 제공자 | 구조화 추출 | Q&A |
|--------|------------|-----|
| OpenAI | ✅ function calling | ✅ |
| Claude | ✅ tool use | ✅ |
| Google | ❌ NotImplementedError | ✅ |

Google은 중첩 List 스키마 미지원 — 구조화 추출 불가. Q&A에만 사용 가능.

---

## 협업 이력 요약

Claude Code(구현) + Codex CLI(코드 리뷰) 멀티에이전트 협업. 상세 이력: `AGENT_LOG.md`

- Entry 001–007: 전체 구조 구현, 백엔드·프론트엔드 초기 구현
- Entry 008–015: 업로드 UX, PDF 지원, 날짜 자동 추출, 멀티파일
- Entry 016–023: 런타임 오류 수정, 청킹, 날짜 정규화, dedup, 검색 디버그, 사이드바 재설계
- 최종: 핵심 스크립트 9개 한국어 주석 + 인수인계 문서 생성
