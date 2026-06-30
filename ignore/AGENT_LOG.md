# AI Agent Collaboration Log

---

## Entry 001

### Agent
Claude Code (claude-sonnet-4-6)

### Timestamp
2026-06-29 21:37

### Task Summary
PaiM-architecture-v2.md 기반으로 전체 프로젝트 구조를 처음으로 구현.
uv 기반 환경 구성으로 변경 (사용자 요청).

### Snapshot Path
../snapshots/pre_claude_2026-06-29_2137

### Files Inspected
- AGENTS.md
- AGENT_LOG.md
- PaiM-architecture-v2.md
- claude.md

### Files Modified (Created)
**환경 설정**
- pyproject.toml (uv + hatchling 기반, requirements.txt 대체)
- .env.example
- requirements.txt (레퍼런스용 유지)

**backend/llm/**
- __init__.py
- base.py         — BaseLLMClient, Message, LLMResponse 인터페이스
- claude_client.py — Anthropic tool use 구현
- openai_client.py — OpenAI function calling 구현
- google_client.py — Google generativeai 구현
- factory.py      — LLM_PROVIDER env 기반 클라이언트 선택

**backend/pipeline/**
- __init__.py
- models.py       — MemoryItem, ExtractionResult (Pydantic)
- extractor.py    — LLM structured output 추출
- ingestor.py     — MySQL + ChromaDB 동시 저장

**backend/retriever/**
- __init__.py
- classifier.py   — 키워드 기반 mysql/chroma/both 라우팅
- mysql_search.py — category/owner 필터 조회
- chroma_search.py — 유사도 검색
- qa_engine.py    — 히스토리 10개 + 컨텍스트 조합 후 LLM 답변

**backend/db/**
- mysql.py        — pymysql 연결
- chroma.py       — ChromaDB 클라이언트 싱글턴
- schema.sql      — projects / documents / memory 테이블 DDL

**backend/api/**
- __init__.py
- project.py      — POST/GET /projects
- upload.py       — POST /projects/{id}/documents, GET /projects/{id}/memory
- query.py        — POST /projects/{id}/query, POST /projects/{id}/git

**backend/**
- __init__.py
- main.py         — FastAPI 앱 + 라우터 등록

**data/samples/**
- meeting_01.md   — 프로젝트 방향 결정 회의록 (decision/action/issue/risk 포함)
- meeting_02.md   — MVP 기능 축소 결정 회의록
- meeting_03.md   — 발표 준비 역할 분배 회의록

### Changes Made
- 아키텍처 문서 Step 1~6 전체 구현 완료
- uv sync 성공 (109개 패키지 설치 확인)
- requirements.txt는 레퍼런스용으로 유지, pyproject.toml이 공식 의존성 관리

### Issues Found
- pyproject.toml 초기 설정 시 hatchling이 README.md 미존재, packages 미지정 오류 → 수정 완료
- tool.uv.dev-dependencies 구문 deprecated → dependency-groups.dev 로 변경

### Remaining Concerns
1. ChromaDB가 기본 in-memory 모드 → 서버 재시작 시 벡터 데이터 초기화됨
   → `chroma.py`에 PersistentClient 전환 옵션 추가 필요 (발표 전 필수)
2. `.env` 파일 미생성 — 실제 API 키 입력 후 수동 생성 필요
3. MySQL 미기동 — `backend/db/schema.sql` 실행 전 DB 서버 + 스키마 생성 필요
4. `google_client.py`의 `_pydantic_to_google_schema`는 단순 구현 (중첩 List 미지원)
5. frontend/ 디렉토리는 구조만 생성, Streamlit 코드 미구현

### Recommended Next Step (for Codex Review)
1. Codex에게 `backend/` 전체 코드 리뷰 요청:
   - 타입 힌트 누락 확인
   - 에러 핸들링 일관성 점검
   - 특히 `ingestor.py`의 ChromaDB/MySQL 원자성 처리 검토
2. 우선 해결 과제: `db/chroma.py`를 PersistentClient로 전환
3. 다음 구현 목표: `frontend/` Streamlit 대시보드 + 채팅 UI

---

## Entry 002

### Agent
Codex CLI (GPT-5)

### Timestamp
2026-06-29 22:56 KST

### Task Summary
Claude Code 최신 구현에 대한 코드 리뷰 및 검증 수행. 코드 수정은 하지 않음.

### Files Inspected
- AGENTS.md
- AGENT_LOG.md
- codex.md
- PaiM-architecture-v2.md
- pyproject.toml
- backend/main.py
- backend/api/project.py
- backend/api/upload.py
- backend/api/query.py
- backend/pipeline/models.py
- backend/pipeline/extractor.py
- backend/pipeline/ingestor.py
- backend/retriever/classifier.py
- backend/retriever/mysql_search.py
- backend/retriever/chroma_search.py
- backend/retriever/qa_engine.py
- backend/db/mysql.py
- backend/db/chroma.py
- backend/db/schema.sql
- backend/llm/base.py
- backend/llm/claude_client.py
- backend/llm/openai_client.py
- backend/llm/google_client.py
- backend/llm/factory.py
- backend/llm/__init__.py

### Validation Commands
- `uv run python -m compileall backend` 성공
- `uv run pytest` 실행 결과 테스트 0개 수집
- `uv run paim-server` 실패 확인: FastAPI app 객체를 콘솔 스크립트로 직접 호출하여 TypeError 발생
- ChromaDB `collection.add(ids=[], documents=[], metadatas=[])` 실패 확인: 빈 업로드/빈 chunk 처리 필요

### Issues Found
1. High — `pyproject.toml`의 `paim-server = "backend.main:app"` 콘솔 스크립트가 실행 불가. FastAPI ASGI app 객체는 CLI callable이 아니므로 `uv run paim-server`가 TypeError로 종료됨.
2. High — `backend/pipeline/ingestor.py`가 MySQL memory 커밋 후 ChromaDB 저장을 수행하여 Chroma 실패 시 문서/메모리와 벡터 저장 상태가 불일치함. 업로드 엔드포인트도 documents row를 먼저 커밋하므로 LLM 추출 또는 ingestion 실패 시 고아 document row가 남을 수 있음.
3. Medium — `backend/pipeline/ingestor.py`는 `raw_text`가 공백이거나 chunk가 0개일 때 빈 리스트로 Chroma `add()`를 호출하며 ValueError가 발생함.
4. Medium — `backend/llm/google_client.py`의 Pydantic schema 변환이 `items: List[MemoryItem]` 중첩 구조를 문자열 필드로 변환하여 Google provider structured extraction이 아키텍처 계약대로 동작하기 어려움.
5. Medium — `backend/pipeline/models.py`의 `MemoryItem.source`가 필수지만 extractor prompt와 API 입력 흐름에서 item별 source를 안정적으로 채우지 않음. LLM이 source를 생략하면 Pydantic 검증 실패로 업로드가 중단됨.
6. Low — `backend/db/chroma.py`가 in-memory `chromadb.Client()`를 사용하여 서버 재시작 시 벡터 데이터가 사라짐. Claude 로그의 Remaining Concern과 동일하며 발표/데모 전 해결 필요.
7. Low — 테스트가 아직 없어 API/ingestion/retrieval 회귀 검증이 불가능함.

### Recommended Fixes
- `paim-server`를 실제 callable 함수로 바꾸거나 콘솔 스크립트를 제거하고 `uvicorn backend.main:app --reload` 실행 방식을 문서화.
- 업로드 처리에서 document insert, memory insert, Chroma insert 실패 정책을 명확히 정하고 보상 삭제/트랜잭션 경계를 구현.
- chunk가 없을 때 Chroma `add()`를 건너뛰거나 400 응답으로 빈 content를 거부.
- Google provider를 MVP 범위에서 비활성/명시적 미지원 처리하거나 중첩 JSON Schema 변환을 구현.
- `source`는 LLM item 필수값에서 제거하고 ingestion 단계의 문서 source를 저장값으로 사용하도록 정리.
- Chroma PersistentClient 옵션과 최소 회귀 테스트 추가.

### Remaining Concerns
- 실제 MySQL 서버/API 키 없이 end-to-end 업로드/질의 검증은 수행하지 못함.
- 현재 Git 기준으로 전체 프로젝트가 untracked 상태라 Claude 변경분과 기존 파일의 명확한 diff 비교는 불가능했음.

### Recommendation
직접 코드 수정 단계 진행 권장. 우선순위는 콘솔 엔트리포인트, ingestion 원자성/빈 chunk 처리, source 필드 계약 정리, Google provider 처리 순서.

---

## Entry 003

### Agent
Claude Code (claude-sonnet-4-6)

### Timestamp
2026-06-29 23:10

### Task Summary
Codex Entry 002 리뷰 지적 사항 전체 수정 (High 2건, Medium 3건, Low 1건).

### Files Modified
- `pyproject.toml` — `paim-server` 스크립트를 `backend.main:serve` callable로 수정
- `backend/main.py` — `serve()` 함수 추가 (uvicorn 실행 래퍼)
- `backend/pipeline/models.py` — `MemoryItem.source` → `Optional[str] = None`으로 변경
- `backend/pipeline/extractor.py` — `default_source` 파라미터 추가, LLM 미반환 시 fallback 처리
- `backend/pipeline/ingestor.py` — 빈 chunk일 때 Chroma `add()` 스킵, MySQL rollback 처리, `item.source or source` fallback
- `backend/api/upload.py` — 빈 content 400 거부, LLM/ingest 실패 시 `_delete_document()` 보상 삭제
- `backend/db/chroma.py` — `chromadb.Client()` → `PersistentClient(path=CHROMA_PERSIST_DIR)`
- `backend/llm/google_client.py` — tool_schema 사용 시 `NotImplementedError` 명시 (중첩 스키마 미지원)
- `.env` / `.env.example` — `CHROMA_PERSIST_DIR=.chroma` 추가

### Changes Made
| Codex Issue | 조치 |
|---|---|
| High #1: paim-server TypeError | `serve()` 함수로 교체 |
| High #2: MySQL/Chroma 원자성 | MySQL rollback 추가, 업로드 실패 시 보상 삭제 |
| Medium #3: 빈 chunk ValueError | chunk 없으면 Chroma add 스킵 |
| Medium #4: Google 중첩 스키마 | tool_schema 사용 시 NotImplementedError 명시 |
| Medium #5: source 필드 계약 | Optional로 변경, ingestion 단계 source fallback |
| Low #6: ChromaDB in-memory | PersistentClient 전환, CHROMA_PERSIST_DIR env 추가 |

### Validation
- `uv run python -m compileall backend` 성공 (전체 파일 컴파일 통과)

### Remaining Concerns
- 테스트 코드 미존재 — API/ingestion/retrieval 회귀 검증 불가
- MySQL 실 서버 없이 end-to-end 검증 미수행
- frontend/ Streamlit 구현 미완

### Recommended Next Step (완료 → Entry 007 참고)
- `frontend/` Streamlit 대시보드 + 채팅 UI 구현
- 또는 최소 pytest 통합 테스트 작성

---

## Entry 004

### Agent
Codex CLI (GPT-5)

### Timestamp
2026-06-29 23:02 KST

### Task Summary
Claude Code Entry 003 수정 사항 재리뷰 및 검증 수행. 코드 수정은 하지 않음.

### Files Inspected
- AGENT_LOG.md
- pyproject.toml
- .gitignore
- .env.example
- backend/main.py
- backend/api/upload.py
- backend/api/query.py
- backend/pipeline/models.py
- backend/pipeline/extractor.py
- backend/pipeline/ingestor.py
- backend/db/chroma.py
- backend/llm/google_client.py

### Validation Commands
- `uv run python -m compileall backend` 성공
- `uv run pytest` 실행 결과 테스트 0개 수집
- `timeout 5 uv run paim-server` 성공적으로 uvicorn 실행 확인 후 timeout 종료
- `_split_text("   ")`가 빈 리스트를 반환함을 확인
- `git check-ignore -v .env .chroma` 결과 ignore 규칙 없음 확인

### Issues Found
1. High — `backend/api/query.py`의 `/projects/{project_id}/git` 엔드포인트가 `/documents`와 동일한 보상 삭제/빈 content 방어를 적용받지 못함. `documents` row를 먼저 커밋한 뒤 `extract()`/`ingest()`가 실패하면 고아 document row가 남을 수 있음. `default_source`도 넘기지 않아 source fallback 일관성이 깨짐.
2. Medium — `.gitignore`가 `.env`와 `.chroma/`를 무시하지 않음. 현재 `.env`가 untracked로 노출되어 있고, Chroma PersistentClient 도입 후 로컬 벡터 저장소도 실수로 커밋될 수 있음.
3. Low — `google.generativeai` 패키지가 deprecated 경고를 발생시키며, factory import 경로 때문에 일반 실행에서도 경고가 노출됨. 현재 기능 차단 이슈는 아니지만 provider 정리 또는 lazy import가 필요함.

### Resolved From Entry 002
- `paim-server` 콘솔 엔트리포인트 TypeError는 해결됨.
- 일반 문서 업로드 경로의 빈 content 방어, source fallback, 실패 시 MySQL 보상 삭제가 추가됨.
- 빈 chunk에 대한 Chroma `add()` 호출은 방지됨.
- ChromaDB는 PersistentClient로 전환됨.
- Google structured extraction은 명시적 NotImplementedError로 변경됨.

### Recommended Fixes
- `/git` 업로드 로직도 `upload.py`의 문서 업로드 경로와 동일한 검증/try-except 보상 삭제/default_source 처리를 공유하도록 공통 helper로 묶을 것.
- `.gitignore`에 `.env`, `.env.*` 중 필요한 범위, `.chroma/`를 추가하고 `.env.example`만 커밋 대상으로 유지할 것.
- Google provider는 추후 `google.genai`로 이전하거나 factory에서 lazy import해 불필요한 deprecated warning을 줄일 것.

### Remaining Concerns
- 테스트 코드가 없어 회귀 검증은 여전히 불가능함.
- 실제 MySQL 서버/API 키 기반 end-to-end 검증은 수행하지 못함.

### Recommendation
수정 단계 진행 권장. 우선순위는 `/git` ingestion 보상 처리와 `.gitignore` 보안/로컬 데이터 ignore 규칙 추가.

---

## Entry 005

### Agent
Codex CLI (GPT-5)

### Timestamp
2026-06-29 23:05 KST

### Task Summary
사용자가 `.gitignore`를 보강했다고 알림. Codex가 확인 후 Claude Code가 이어서 처리할 남은 작업을 정리함.

### Files Inspected
- `.gitignore`
- `AGENT_LOG.md`

### Validation Commands
- `git check-ignore -v .env .chroma .env.example || true`

### Updated Status
- `.env`는 `.gitignore`에 의해 ignore됨을 확인함.
- `.env.example`은 ignore되지 않아 샘플 설정 파일로 커밋 가능함.
- `.chroma/`는 아직 ignore 규칙이 확인되지 않음.

### Remaining Issues For Claude
1. High — `backend/api/query.py`의 `/projects/{project_id}/git` 엔드포인트에 일반 문서 업로드와 동일한 실패 보상 처리가 필요함.
   - 빈 `content`는 400으로 거부할 것.
   - `extract(body.content, default_source=body.source)` 또는 동일 의미의 source fallback을 적용할 것.
   - `extract()` 또는 `ingest()` 실패 시 생성된 `documents` row와 관련 `memory` row를 삭제할 것.
   - 가능하면 `backend/api/upload.py`의 `_delete_document()` 또는 공통 helper를 재사용해 중복을 줄일 것.
2. Medium — `.gitignore`에 Chroma 로컬 저장소 ignore 규칙 추가 필요.
   - 권장 규칙: `.chroma/`
   - `.env.example`은 계속 추적 가능해야 함.

### Recommended Next Step
Claude Code가 위 2개 항목을 우선 수정한 뒤 `uv run python -m compileall backend`와 가능한 범위의 수동 검증을 수행할 것.

---

## Entry 006

### Agent
Claude Code (claude-sonnet-4-6)

### Timestamp
2026-06-29 23:20

### Task Summary
Codex Entry 004/005 지적 사항 수정 (High 1건, Medium 1건).

### Files Modified
- `backend/api/query.py` — `/git` 엔드포인트에 빈 content 400 거부, `default_source` 전달, 실패 시 `_delete_document()` 보상 삭제 적용
- `.gitignore` — `.chroma/` ignore 규칙 추가

### Changes Made
| Codex Issue | 조치 |
|---|---|
| High #1: /git 엔드포인트 보상 처리 누락 | `upload.py`의 `_delete_document()` 재사용, `default_source` 전달, 빈 content 400 거부 |
| Medium #2: .chroma/ gitignore 누락 | `.gitignore`에 `.chroma/` 추가 |

### Validation
- `uv run python -m compileall backend` 성공
- `git check-ignore -v .env .chroma/ .env.example` → `.env`/`.chroma/` ignore 확인, `.env.example` 추적 가능 확인

### Remaining Concerns
- 테스트 코드 미존재
- MySQL 실 서버 없이 end-to-end 검증 미수행
- `google.generativeai` deprecated 경고 (Low, 기능 차단 없음)
- `frontend/` Streamlit 구현 미완

### Recommended Next Step
- `frontend/` Streamlit 대시보드 + 채팅 UI 구현
- 또는 최소 pytest 통합 테스트 작성

---

## Entry 007

### Agent
Claude Code (claude-sonnet-4-6)

### Timestamp
2026-06-29 23:35

### Task Summary
Streamlit 프론트엔드 전체 구현 (사이드바 프로젝트 선택, 업로드, 대시보드, 채팅, 타임라인).

### Files Created
- `frontend/__init__.py`
- `frontend/app.py` — 메인 엔트리, 사이드바 프로젝트 생성/선택, 페이지 라우팅
- `frontend/app_runner.py` — `paim-ui` 콘솔 스크립트용 실행 래퍼
- `frontend/pages/__init__.py`
- `frontend/pages/upload.py` — 문서 업로드 + LLM 추출 결과 표시
- `frontend/pages/dashboard.py` — 카테고리별 카드 + 요약 지표
- `frontend/pages/chat.py` — Q&A 채팅 (히스토리, 검색 경로 표시)
- `frontend/pages/timeline.py` — 날짜순 시각적 타임라인 (카테고리 필터)
- `frontend/components/__init__.py`
- `frontend/components/memory_card.py` — 카테고리별 색상 카드 컴포넌트
- `frontend/components/timeline_view.py` — HTML/CSS 시각적 타임라인 렌더러

### Files Modified
- `pyproject.toml` — `streamlit` 의존성 추가, `paim-ui` 콘솔 스크립트 추가

### Validation
- `uv sync` 성공
- `uv run python -m compileall frontend` 성공 (전체 파일 통과)

### Remaining Concerns
- MySQL + API 키 세팅 없이 실제 UI 동작 미검증
- 테스트 코드 미존재

### Recommended Next Step
- MySQL 서버 기동 + schema.sql 실행 후 `uv run streamlit run frontend/app.py` 로 실제 동작 검증
- Codex에게 프론트엔드 코드 리뷰 요청

---

## Entry 008

### Agent
Codex CLI (GPT-5)

### Timestamp
2026-06-30 00:29 KST

### Task Summary
Claude Code Entry 007 Streamlit 프론트엔드 구현 리뷰 및 검증 수행. 코드 수정은 하지 않음.

### Files Inspected
- AGENTS.md
- AGENT_LOG.md
- codex.md
- pyproject.toml
- frontend/app.py
- frontend/app_runner.py
- frontend/pages/upload.py
- frontend/pages/dashboard.py
- frontend/pages/chat.py
- frontend/pages/timeline.py
- frontend/components/memory_card.py
- frontend/components/timeline_view.py
- backend/api/query.py

### Validation Commands
- `uv run python -m compileall frontend` 성공
- `uv run python -m compileall backend` 성공
- `uv run pytest` 실행 결과 테스트 0개 수집
- `git check-ignore -v .env .chroma/ .env.example || true` 실행: `.env`와 `.chroma/` ignore 확인, `.env.example`은 추적 가능 확인
- `timeout 5 uv run paim-ui`는 sandbox 내 uv cache lock 생성 실패로 실행 검증 미완료. 권한 상승 재시도는 사용자 인터럽트로 중단됨.

### Issues Found
1. High — `frontend/pages/chat.py`의 `st.session_state.chat_history`가 프로젝트별로 분리되지 않음. 프로젝트 A에서 대화한 뒤 사이드바에서 프로젝트 B로 전환하면 기존 대화가 그대로 렌더링되고, 다음 질문의 `history`로도 전달됨. 아키텍처의 `project_id` 기반 프로젝트 격리 요구와 충돌하며 다른 프로젝트 맥락이 답변에 섞일 수 있음.
2. Medium — `frontend/components/memory_card.py`와 `frontend/components/timeline_view.py`가 DB/LLM에서 온 `content`, `reason`, `topic`, `owner`, `source` 값을 HTML escape 없이 `unsafe_allow_html=True`로 렌더링함. 업로드 문서 또는 LLM 추출 결과에 HTML/스크립트성 문자열이 포함되면 UI 변조/XSS성 렌더링 위험이 있음.
3. Low — `frontend/app.py`의 `project_map = {p["name"]: p["id"] for p in projects}` 구조는 같은 이름의 프로젝트가 여러 개 있을 때 앞선 프로젝트가 덮어써짐. UI에서 프로젝트를 정확히 선택할 수 없고 잘못된 project_id가 선택될 수 있음.
4. Low — Streamlit UI가 백엔드 API 대신 DB/파이프라인 함수를 직접 호출함. 현재 단일 프로세스 MVP에서는 동작 가능하지만 API 경로와 UI 경로의 검증/에러 처리 로직이 계속 중복되어 추후 버그 수정 누락 가능성이 큼.

### Recommended Fixes
- 채팅 히스토리를 `chat_history_{project_id}`처럼 프로젝트별 key로 분리하거나 프로젝트 변경 시 초기화할 것. 가능하면 화면 표시와 `answer(..., history=...)` 모두 같은 project-scoped history를 사용해야 함.
- HTML 렌더링 전 `html.escape()`로 사용자/LLM/DB 문자열을 escape하거나, 가능한 곳은 `st.write`, `st.markdown`의 기본 escaping 동작을 사용해 `unsafe_allow_html=True` 범위를 최소화할 것.
- 프로젝트 선택 옵션은 이름만 쓰지 말고 `"{name} (#{id})"` 또는 `(id, name)` 기반으로 중복 이름을 구분할 것.
- 장기적으로는 프론트가 FastAPI 엔드포인트를 호출하도록 맞추거나, 최소한 업로드/삭제 보상 로직을 공통 함수로 분리해 API와 UI가 같은 경로를 사용하도록 정리할 것.

### Remaining Concerns
- MySQL 서버/API 키 없이 Streamlit 실제 화면 동작은 검증하지 못함.
- `paim-ui` 콘솔 스크립트 실행 검증은 sandbox cache lock 문제와 사용자 인터럽트로 완료하지 못함.
- 테스트 코드가 없어 프론트/백엔드 회귀 검증은 여전히 불가능함.

### Recommendation
수정 단계 진행 권장. 우선순위는 프로젝트별 채팅 히스토리 분리와 HTML escape 처리.

---

## Entry 009

### Agent
Claude Code (claude-sonnet-4-6)

### Timestamp
2026-06-30 01:10

### Task Summary
Codex Entry 008 지적 사항 수정 (High 1건, Medium 1건, Low 1건). FastAPI 관련 Low #4는 사용자 지시로 제외.

### Files Modified
- `frontend/pages/chat.py` — 채팅 히스토리 key를 `chat_history_{project_id}`로 분리
- `frontend/components/memory_card.py` — `html.escape()` 적용, `_e()` 헬퍼 추가
- `frontend/components/timeline_view.py` — `html.escape()` 적용, `_e()` 헬퍼 추가
- `frontend/app.py` — 프로젝트 표시를 `"이름 (#id)"` 형식으로 변경, `label_to_project` dict 기반 id 조회

### Changes Made
| Codex Issue | 조치 |
|---|---|
| High #1: 채팅 히스토리 프로젝트 미분리 | `chat_history_{project_id}` key로 프로젝트별 독립 관리 |
| Medium #2: HTML XSS 위험 | `html.escape()`로 모든 DB/LLM 데이터 escape 처리 |
| Low #3: 중복 프로젝트명 id 충돌 | `"이름 (#id)"` 라벨 + `label_to_project` dict로 정확한 id 선택 |
| Low #4: FastAPI 미사용 | 제외 (추후 React 등 타 프론트 연동 시 사용 예정) |

### Validation
- `uv run python -m compileall frontend` 성공

### Remaining Concerns
- 테스트 코드 미존재
- MySQL + API 키 기반 실제 UI 동작 미검증

---

## Entry 010

### Agent
Claude Code (claude-sonnet-4-6)

### Timestamp
2026-06-30 01:40

### Task Summary
업로드 UX 개선 (드래그 앤 드롭, PDF 지원, 날짜 자동 추출) + extractor 프롬프트 날짜 정책 변경.

### Files Modified
- `frontend/pages/upload.py` — 전면 재작성
  - 탭 2개로 분리: "파일 업로드" (드래그 앤 드롭) / "텍스트 직접 입력"
  - `.md` / `.txt` / `.pdf` 지원 (`pypdf`로 텍스트 추출)
  - `_extract_date()` — 정규식으로 문서 내 날짜 자동 추출 (날짜:/Date:/한국어/ISO 패턴)
  - 파일명 자동 생성 (`doc_type_YYYYMMDD.md`), 입력 항목 최소화 (파일/내용 + 문서 유형만)
  - 날짜 표시 후 수정 가능
- `backend/pipeline/extractor.py` — system prompt 날짜 정책 추가
  - `date` 필드는 항상 회의/문서 날짜 (마감일 아님)
  - action의 마감일은 `content`에 포함 (예: "문서 초안 작성 (~6/22까지)")
- `pyproject.toml` — `pypdf>=6.14.2` 의존성 추가

### Design Decisions
- 업로드와 추출을 분리하지 않고 통합 유지 (MVP 데모 목적, 단계 나눌 이유 없음)
- PDF는 텍스트 기반 PDF만 지원 (스캔 이미지 PDF 제외, OCR 불필요)

### Validation
- `uv run python -m compileall frontend/pages/upload.py` 성공
- `uv add pypdf` 성공 (pypdf 6.14.2 설치)

### Remaining Concerns
- 실제 PDF 파일로 텍스트 추출 품질 미검증
- 테스트 코드 미존재
- end-to-end 동작 미검증

### Recommended Next Step
- Codex 프론트엔드 업로드 UX 리뷰 요청
- 이후 실제 앱 실행 후 샘플 회의록 3개로 데모 시나리오 검증

---

## Entry 011

### Agent
Codex CLI (GPT-5)

### Timestamp
2026-06-30 00:50 KST

### Task Summary
Claude Code Entry 009/010 수정 사항 리뷰. 프로젝트별 채팅 상태/XSS 수정 반영 여부와 새 업로드 UX/PDF/날짜 추출 기능 검토. 코드 수정은 하지 않음.

### Files Inspected
- AGENT_LOG.md
- pyproject.toml
- frontend/app.py
- frontend/pages/upload.py
- frontend/pages/chat.py
- frontend/pages/timeline.py
- frontend/components/memory_card.py
- frontend/components/timeline_view.py
- backend/pipeline/extractor.py
- backend/pipeline/ingestor.py

### Validation Commands
- `uv run python -m compileall frontend backend` 성공
- `uv run pytest` 실행 결과 테스트 0개 수집
- `_extract_date()` 수동 확인: `날짜: 2026-6-3` → `2026-06-03`, `마감 2026-99-99` → `2026-99-99`
- `_read_pdf(b"not a pdf")` 실행 시 `pypdf.errors.PdfStreamError` 발생 확인
- `git check-ignore -v .env .chroma/ .env.example || true` 실행: `.env`와 `.chroma/` ignore 확인, `.env.example`은 추적 가능 확인

### Resolved From Entry 008
- `frontend/pages/chat.py`의 채팅 히스토리가 `chat_history_{project_id}`로 프로젝트별 분리됨.
- `frontend/components/memory_card.py`, `frontend/components/timeline_view.py`에 `html.escape()`가 적용되어 DB/LLM 문자열의 HTML 직접 렌더링 위험이 완화됨.
- `frontend/app.py` 프로젝트 선택이 `"이름 (#id)"` 라벨 기반으로 바뀌어 중복 프로젝트명 충돌이 해소됨.

### Issues Found
1. Medium — `frontend/pages/upload.py`의 날짜 입력값(`detected_date`, 사용자가 수정 가능한 값)이 `ingest(..., date=detected_date)`로 Chroma 메타데이터에만 전달되고, MySQL `memory.date`에는 반영되지 않음. `backend/pipeline/ingestor.py`는 `item.date`를 저장하므로 대시보드/타임라인은 사용자가 확인/수정한 날짜가 아니라 LLM이 반환한 날짜를 사용함. 업로드 화면의 "날짜 자동 추출 — 수정 가능" UX와 실제 표시 결과가 불일치할 수 있음.
2. Medium — PDF 파싱이 렌더 단계에서 예외 처리 없이 수행됨. 깨진 PDF, 암호화 PDF, 비표준 PDF를 올리면 `_read_pdf()`에서 `PdfStreamError` 등이 발생하고 Streamlit 화면이 에러로 중단될 수 있음.
3. Medium — `pyproject.toml`의 wheel packages가 `["backend"]`만 포함하지만 `paim-ui` 콘솔 스크립트는 `frontend.app_runner:main`을 가리킴. 배포/설치된 wheel 환경에서는 `frontend` 패키지가 누락되어 `paim-ui`가 `ModuleNotFoundError`로 실패할 가능성이 큼.
4. Low — `_extract_date()`가 문서 내 첫 ISO 날짜를 문맥 없이 잡고 날짜 유효성도 검증하지 않음. 예: `마감 2026-99-99`도 날짜로 반환함. 현재는 Chroma metadata에 주로 들어가지만, 날짜 fallback에 활용할 경우 MySQL DATE 오류나 잘못된 타임라인 날짜로 이어질 수 있음.

### Recommended Fixes
- 업로드에서 확정된 문서 날짜를 MySQL memory에도 일관되게 반영할 것. 예: `extract(..., default_date=detected_date)`를 추가하거나 `ingest()` 직전 `item.date = item.date or detected_date` 정책을 명시할 것. 사용자가 수정한 날짜를 우선할지, LLM date가 없을 때만 fallback할지도 UI 문구와 맞춰 정해야 함.
- `_read_pdf()` 호출을 try/except로 감싸고, 실패 시 `st.error("PDF 텍스트를 읽을 수 없습니다...")` 후 업로드 버튼이 진행되지 않도록 처리할 것. 추출 텍스트가 공백이면 현재처럼 업로드 거부해야 함.
- `[tool.hatch.build.targets.wheel] packages = ["backend", "frontend"]`로 수정하거나 `paim-ui` 스크립트를 패키징 대상과 일치시킬 것.
- `_extract_date()`는 `datetime.date(year, month, day)`로 유효성 검증하고, 가능하면 `날짜:`/`Date:`/`YYYY년 M월 D일`처럼 문서 날짜 맥락이 강한 패턴을 우선 사용하며 일반 ISO 패턴은 신중히 처리할 것.

### Remaining Concerns
- 테스트 코드가 없어 업로드 날짜 정책/PDF 오류/채팅 상태 분리 회귀 검증이 불가능함.
- MySQL/API 키 기반 실제 Streamlit end-to-end 검증은 수행하지 못함.

### Recommendation
수정 단계 진행 권장. 우선순위는 업로드 날짜가 MySQL memory/timeline에 반영되지 않는 문제와 PDF 파싱 예외 처리.

---

## Entry 013

### Agent
Codex CLI (GPT-5)

### Timestamp
2026-06-30 00:56 KST

### Task Summary
Claude Code Entry 012 수정 사항 재리뷰. Entry 011의 날짜 반영/PDF 예외/패키징/날짜 유효성 이슈 해결 여부 검증. 코드 수정은 하지 않음.

### Files Inspected
- AGENT_LOG.md
- pyproject.toml
- frontend/pages/upload.py
- frontend/pages/chat.py
- frontend/components/memory_card.py
- frontend/components/timeline_view.py

### Validation Commands
- `uv run python -m compileall frontend backend` 성공
- `uv run pytest` 실행 결과 테스트 0개 수집
- `_extract_date()` 수동 확인: `날짜: 2026-6-3` → `2026-06-03`, `마감 2026-99-99` → 빈 문자열
- `_read_pdf(b"not a pdf")` 수동 확인: 빈 문자열 반환
- `uv build --wheel` 성공: `dist/paim-0.1.0-py3-none-any.whl` 생성됨

### Resolved From Entry 011
- 업로드 확정 날짜가 LLM item의 `date`가 비어 있을 때 `item.date = detected_date or None`으로 MySQL `memory.date`에 반영되도록 수정됨.
- PDF 파싱 실패 시 `_read_pdf()`가 빈 문자열을 반환하고, UI에서 텍스트를 읽을 수 없다는 에러를 표시한 뒤 진행을 중단함.
- `pyproject.toml` wheel packages에 `frontend`가 추가되어 `paim-ui` 패키징 누락 문제가 해소됨.
- `_extract_date()`가 `datetime(y, m, d)`로 날짜 유효성을 검증하여 무효 날짜를 스킵함.

### Issues Found
1. Medium — `frontend/pages/upload.py`의 날짜 유효성 검증은 자동 추출 함수에만 적용되고, 사용자가 `st.text_input`에서 직접 수정한 날짜값은 `_submit()` 전에 검증되지 않음. `date_file`/`date_text`에 `2026-99-99` 또는 임의 문자열을 입력하면 `item.date`와 Chroma metadata에 그대로 전달되고, MySQL `DATE` 컬럼 저장 시 실패하거나 추후 타임라인 정렬/표시가 깨질 수 있음.

### Recommended Fixes
- `_submit()` 진입 전에 `detected_date`를 검증/정규화하는 helper를 추가할 것. 허용 정책은 빈 값 또는 `YYYY-MM-DD` 유효 날짜로 제한하는 것이 적절함.
- 잘못된 날짜 입력은 LLM/DB 호출 전에 `st.error("날짜는 YYYY-MM-DD 형식의 유효한 날짜여야 합니다.")`로 막을 것.
- 같은 helper를 자동 추출 결과와 수동 입력값 모두에 적용해 날짜 정책을 한 곳에서 관리할 것.

### Remaining Concerns
- 테스트 코드가 없어 업로드 날짜 검증/PDF 오류/패키징 회귀 검증이 자동화되어 있지 않음.
- MySQL/API 키 기반 실제 Streamlit end-to-end 검증은 수행하지 못함.
- `uv build --wheel` 검증으로 `dist/` 산출물이 생성됨.

### Recommendation
수정 단계 진행 권장. 우선순위는 수동 날짜 입력값 검증 추가.

---

## Entry 012

### Agent
Claude Code (claude-sonnet-4-6)

### Timestamp
2026-06-30 02:00

### Task Summary
Codex Entry 011 지적 사항 전체 수정 (Medium 3건, Low 1건).

### Files Modified
- `frontend/pages/upload.py`
  - Medium #1: `extract()` 후 `item.date`가 없으면 `detected_date`로 채워 MySQL `memory.date`에도 문서 날짜 반영
  - Medium #2: `_read_pdf()` try/except 추가, 빈 텍스트 반환 시 `st.error()` 후 업로드 중단
  - Low #4: `_extract_date()` 패턴 매칭 후 `datetime()` 유효성 검증 추가, 무효 날짜 스킵
- `pyproject.toml`
  - Medium #3: `packages = ["backend", "frontend"]` — wheel 패키지에 frontend 추가

### Changes Made
| Codex Issue | 조치 |
|---|---|
| Medium #1: 문서 날짜 MySQL 미반영 | extract 후 `item.date = item.date or detected_date` 적용 |
| Medium #2: PDF 파싱 예외 미처리 | `_read_pdf()` try/except, 빈 결과 시 st.error 후 중단 |
| Medium #3: wheel에 frontend 누락 | `packages = ["backend", "frontend"]` |
| Low #4: 날짜 유효성 미검증 | `datetime(y, m, d)` 검증 후 ValueError 시 다음 패턴으로 continue |

### Validation
- `uv run python -m compileall frontend backend` 성공

### Remaining Concerns
- 테스트 코드 미존재
- end-to-end 동작 미검증

---

## Entry 014

### Agent
Claude Code (claude-sonnet-4-6)

### Timestamp
2026-06-30 02:15

### Task Summary
Codex Entry 013 지적 사항 수정 (Medium 1건).

### Files Modified
- `frontend/pages/upload.py`
  - `_validate_date()` helper 추가 — 빈 값 또는 `YYYY-MM-DD` 유효 형식만 허용
  - `_submit()` 진입 직후 날짜 검증, 실패 시 `st.error()` 후 LLM/DB 호출 차단

### Changes Made
| Codex Issue | 조치 |
|---|---|
| Medium #1: 수동 입력 날짜 미검증 | `_validate_date()` + `datetime.strptime()` 검증, `_submit()` 초입에 적용 |

### Validation
- `uv run python -m compileall frontend/pages/upload.py` 성공

### Remaining Concerns
- 테스트 코드 미존재
- end-to-end 동작 미검증

---

## Entry 015

### Agent
Claude Code (claude-sonnet-4-6)

### Timestamp
2026-06-30 02:45

### Task Summary
실제 앱 실행 중 발생한 런타임 오류 수정 및 기능 개선 (end-to-end 테스트 기반).

### Files Modified
- `backend/llm/openai_client.py`
  - `finish_reason == "length"` 감지 시 명확한 에러 raise (기존: json.loads에서 Unterminated string)
- `backend/pipeline/extractor.py`
  - 대용량 문서 청킹: `_CHUNK_SIZE=3000`, `_CHUNK_OVERLAP=200`, 청크별 LLM 호출 후 결과 합산
  - SYSTEM_PROMPT: 날짜 형식 `YYYY-MM-DD` 명시 + Korean 형식 금지, topic 필드 설명 추가
- `backend/pipeline/models.py`
  - `topic: str` → `Optional[str] = None` (LLM 미반환 시 Pydantic 검증 실패 방지)
  - 전 필드 `Field(description=...)` 추가 → LLM에 전달되는 JSON 스키마에 설명 포함
- `backend/pipeline/ingestor.py`
  - `_normalize_date()` 추가: Korean/slash/dot 형식 → `YYYY-MM-DD` 변환
  - MySQL INSERT 시 `_normalize_date(item.date)` 적용
- `backend/retriever/qa_engine.py`
  - `_build_context()` 반환값에 `debug` dict 추가 (mysql_rows, chroma_chunks 메타정보)
- `frontend/pages/chat.py`
  - "검색 컨텍스트 디버그" expander 추가 (MySQL 항목 목록, ChromaDB 청크 미리보기)
  - 서비스 배포 시 `if debug:` 블록 제거 예정
- `frontend/pages/upload.py`
  - 단일 → 멀티파일 업로드 (`accept_multiple_files=True`)
  - 파일별 루프 처리 + 진행 프로그레스 바, 실패 파일 skip 후 계속 처리

### Issues Fixed (runtime)
| 오류 | 원인 | 조치 |
|---|---|---|
| `Unterminated string at char 4560` | max_tokens 한도로 JSON 출력 잘림 | 청킹으로 근본 해결 + finish_reason 체크 |
| `Incorrect date value: '2026년 6월 2일'` | LLM이 Korean 날짜 형식 반환 | `_normalize_date()` + SYSTEM_PROMPT 강화 |
| `35 validation errors — topic missing` | `topic: str` 필수인데 LLM 미반환 | `Optional[str] = None` + Field description |

### Validation
- `uv run python -m compileall frontend backend` 성공
- Streamlit 서버 8502 포트 정상 기동 확인

### Remaining Concerns
- 멀티파일 처리 시 LLM 호출 횟수 증가 (청크 수 × 파일 수)
- 키워드 기반 retriever 분류 정확도 낮음 (추후 임베딩 기반 분류 고려)
- 테스트 코드 미존재

---

## Entry 016

### Agent
Codex CLI (GPT-5)

### Timestamp
2026-06-30 01:43 KST

### Task Summary
Claude Code Entry 014/015 수정 사항 리뷰. 수동 날짜 입력 검증 반영 여부, 실제 앱 실행 기반 변경사항(청킹 추출, 날짜 정규화, 채팅 디버그, 멀티파일 업로드) 검토. 코드 수정은 하지 않음.

### Files Inspected
- AGENT_LOG.md
- pyproject.toml
- frontend/pages/upload.py
- frontend/pages/chat.py
- backend/llm/openai_client.py
- backend/pipeline/extractor.py
- backend/pipeline/models.py
- backend/pipeline/ingestor.py
- backend/retriever/qa_engine.py

### Validation Commands
- `uv run python -m compileall frontend backend` 성공
- `uv run pytest` 실행 결과 테스트 0개 수집
- 날짜/PDF helper 수동 확인:
  - `_validate_date("2026-06-30")` → `True`
  - `_validate_date("2026-99-99")` → `False`
  - `_extract_date("마감 2026-99-99")` → 빈 문자열
  - `_read_pdf(b"not a pdf")` → 빈 문자열
  - `_normalize_date("2026-99-99")` → `"2026-99-99"`
  - `_normalize_date("2026/99/99")` → `"2026-99-99"`
- `uv build --wheel` 성공: `dist/paim-0.1.0-py3-none-any.whl` 생성됨

### Resolved From Entry 013
- `frontend/pages/upload.py`에 `_validate_date()`가 추가되어 텍스트 직접 입력 탭의 수동 날짜값은 LLM/DB 호출 전에 차단됨.
- wheel 빌드가 성공하여 `backend`/`frontend` 패키징 설정은 현재 유효함.

### Issues Found
1. Medium — `backend/pipeline/ingestor.py`의 `_normalize_date()`가 `YYYY-MM-DD` 형식이면 실제 날짜 유효성을 검증하지 않고 그대로 반환함. 또한 `YYYY/MM/DD`, `YYYY.MM.DD`, Korean 날짜 변환 시에도 월/일 범위를 검증하지 않음. LLM이 `2026-99-99` 또는 `2026/99/99`를 반환하면 MySQL `DATE` INSERT 시 실패할 수 있음. UI 수동 입력은 막았지만 LLM 출력 경로는 여전히 취약함.
2. Medium — `frontend/pages/chat.py`의 "검색 컨텍스트 디버그"가 MySQL row의 `content`/`source`를 escape 없이 `unsafe_allow_html=True`로 렌더링함. Entry 008에서 해결했던 DB/LLM 문자열 HTML 렌더링 위험이 디버그 UI에서 다시 생김.
3. Medium — `backend/pipeline/extractor.py`의 멀티청크 경로는 `_extract_chunk()`가 structured output을 반환하지 않아도 빈 리스트로 처리하고 계속 진행함. 단일 청크는 같은 상황에서 `ValueError`를 raise하지만, 긴 문서는 특정 청크 또는 전체 청크 추출 실패가 조용히 누락될 수 있어 데이터 손실을 감지하기 어렵다.
4. Low — `frontend/pages/upload.py`의 멀티파일 업로드는 파일별 날짜를 자동 추출만 하고 사용자가 확인/수정할 UI가 없음. 텍스트 직접 입력 탭과 달리 자동 추출 오류를 사람이 보정할 수 없어 잘못된 날짜가 그대로 저장될 수 있음.

### Recommended Fixes
- `_normalize_date()`에서도 `datetime.strptime()` 또는 `datetime(y, m, d)`로 최종 유효성 검증을 수행하고, 무효 날짜는 `None`으로 반환하거나 명시적 오류로 처리할 것.
- 채팅 디버그 렌더링에서 `html.escape()`를 적용하거나 `unsafe_allow_html=True`를 제거하고 Streamlit 기본 escaping을 사용할 것.
- 멀티청크 추출에서 청크별 실패를 추적할 것. 최소한 모든 청크가 빈 결과이면 `ValueError`를 raise하고, 일부 청크만 실패한 경우 경고/로그를 남기거나 재시도 정책을 둘 것.
- 멀티파일 업로드에서 파일별 감지 날짜를 표시하고 수정할 수 있게 하거나, 날짜 자동 추출을 신뢰하지 않는 경우 빈 날짜로 저장하는 명확한 정책을 둘 것.

### Remaining Concerns
- 테스트 코드가 없어 날짜 정규화, HTML escape, 청킹 추출 실패 처리 회귀 검증이 자동화되어 있지 않음.
- MySQL/API 키 기반 전체 end-to-end 검증은 Codex가 수행하지 못함.
- `uv build --wheel` 검증으로 `dist/` 산출물이 생성됨.

### Recommendation
수정 단계 진행 권장. 우선순위는 `_normalize_date()` 유효성 검증과 채팅 디버그 HTML escape 처리.

---

## Entry 017

### Agent
Codex CLI (GPT-5)

### Timestamp
2026-06-30 01:51 KST

### Task Summary
Entry 016 이후 파일 변경분 재리뷰. 날짜 정규화 유효성 검증, 채팅 디버그 escape, 멀티청크 추출 실패 처리 반영 여부를 확인함. 코드 수정은 하지 않음.

### Files Inspected
- AGENT_LOG.md
- backend/pipeline/ingestor.py
- backend/pipeline/extractor.py
- backend/retriever/qa_engine.py
- frontend/pages/chat.py
- frontend/pages/upload.py

### Validation Commands
- `uv run python -m compileall frontend backend` 성공
- `uv run pytest` 실행 결과 테스트 0개 수집
- 날짜/PDF helper 수동 확인:
  - `_normalize_date("2026-99-99")` → `None`
  - `_normalize_date("2026/99/99")` → `None`
  - `_normalize_date("2026년 6월 2일")` → `"2026-06-02"`
  - `_validate_date("2026-99-99")` → `False`
  - `_extract_date("마감 2026-99-99")` → 빈 문자열
- `uv build --wheel` 성공: `dist/paim-0.1.0-py3-none-any.whl` 생성됨

### Resolved From Entry 016
- `backend/pipeline/ingestor.py`의 `_normalize_date()`가 최종 날짜 유효성 검증을 수행하도록 수정됨. 무효 날짜는 `None` 처리됨.
- `frontend/pages/chat.py`의 MySQL 디버그 렌더링에 `html.escape()`가 적용됨.
- `backend/pipeline/extractor.py`의 멀티청크 추출에서 모든 청크가 빈 결과일 경우 `ValueError`를 raise하도록 보완됨.

### Issues Found
1. Medium — `backend/pipeline/extractor.py`의 청킹 추출은 200자 overlap을 사용하지만 중복 제거가 없음. chunk 경계에 걸친 결정/액션/이슈가 양쪽 청크에서 모두 추출되면 동일 memory item이 MySQL에 중복 저장될 수 있음.
2. Medium — `backend/pipeline/extractor.py`는 일부 chunk만 빈 결과를 반환하는 경우 계속 성공 처리함. 실제로 해당 chunk에 추출 가능한 내용이 있었는지, LLM이 tool output을 실패했는지 구분하지 못해 긴 문서의 부분 데이터 누락을 감지하기 어렵다.
3. Low — `frontend/pages/upload.py`의 멀티파일 업로드는 파일별 날짜를 자동 추출만 하고 사용자가 확인/수정할 UI가 없음. 자동 추출 오류를 보정할 수 없어 파일별 timeline 날짜 품질이 낮아질 수 있음.
4. Low — Entry 016 이후 Claude Code의 수정 사항이 `AGENT_LOG.md`에 별도 Claude entry로 기록되지 않았음. 협업 규칙상 구현 에이전트 작업 로그가 누락되어 변경 의도/검증 근거 추적성이 떨어짐.

### Recommended Fixes
- 청킹 추출 결과를 저장 전 dedupe할 것. MVP에서는 `(category, normalized content, date, source)` 기준의 간단한 중복 제거라도 효과가 있음.
- `_extract_chunk()`가 `response.tool_input is None`인 경우와 `{"items": []}`인 경우를 구분하고, tool output 누락은 chunk index/source와 함께 경고 또는 예외로 처리할 것.
- 멀티파일 업로드에서 파일별 감지 날짜를 표시하고 수정할 수 있게 하거나, 최소한 업로드 결과에 파일별 감지 날짜를 표시할 것.
- Claude Code가 이번 수정 내역을 `AGENT_LOG.md`에 보완 기록할 것.

### Remaining Concerns
- 테스트 코드가 없어 날짜 정규화, HTML escape, 청킹 중복/부분 실패 처리를 자동 검증하지 못함.
- MySQL/API 키 기반 전체 end-to-end 검증은 Codex가 수행하지 못함.
- `uv build --wheel` 검증으로 `dist/` 산출물이 생성됨.

### Recommendation
수정 단계 진행 권장. 우선순위는 청킹 추출 중복 제거와 tool output 누락 감지.

---

## Entry 019

### Agent
Codex CLI (GPT-5)

### Timestamp
2026-06-30 01:54 KST

### Task Summary
Claude Code Entry 018 수정 사항 리뷰. 청킹 추출 dedupe와 tool output 누락 구분 처리 반영 여부 검증. 코드 수정은 하지 않음.

### Files Inspected
- AGENT_LOG.md
- backend/pipeline/extractor.py
- frontend/pages/upload.py

### Validation Commands
- `uv run python -m compileall frontend backend` 성공
- `uv run pytest` 실행 결과 테스트 0개 수집
- `_dedup()` 수동 확인: 동일 category/content 항목은 1개로 축약됨
- `_split_chunks("x" * 6000)` 수동 확인: 3개 chunk 생성
- `uv build --wheel` 성공: `dist/paim-0.1.0-py3-none-any.whl` 생성됨

### Resolved From Entry 017
- `backend/pipeline/extractor.py`에 `_dedup()`이 추가되어 멀티청크 결과의 단순 중복 저장 위험이 줄어듦.
- `_extract_chunk()`가 `response.tool_input is None`을 tool call 실패로 보고 `ValueError`를 raise함.
- `{"items": []}`는 정상 빈 결과로 처리되어 tool output 누락과 추출 대상 없음이 구분됨.
- Claude Code가 누락됐던 구현 로그를 Entry 018로 보완함.

### Issues Found
1. Medium — `backend/pipeline/extractor.py`의 `_dedup()` 기준이 `(category, content.strip().lower())`뿐이라 source/date/reason/owner/topic 차이가 있는 항목도 하나로 합쳐질 수 있음. 여러 회의에서 같은 액션 문구가 반복되거나 같은 결정이 다른 이유/날짜로 재확인된 경우 정보가 손실될 수 있음.
2. Medium — `backend/pipeline/extractor.py`는 일부 chunk에서 tool call 실패가 발생해도 `failed_chunks < len(chunks)`이면 조용히 성공 처리함. 사용자에게 부분 추출 실패가 표시되지 않아 긴 문서에서 누락된 항목을 인지하기 어렵다.
3. Low — `frontend/pages/upload.py`의 멀티파일 업로드는 파일별 날짜를 자동 추출만 하고 사용자가 확인/수정할 UI가 없음. 이 이슈는 Entry 017에서 남은 상태와 동일함.

### Recommended Fixes
- `_dedup()` 키에 `date`, `source` 또는 normalized reason/topic 중 최소 하나를 포함하거나, content가 같아도 날짜/source가 다르면 별도 항목으로 유지할 것.
- 멀티청크 추출 결과에 `failed_chunks` 정보를 반환하거나, 최소한 `failed_chunks > 0`이면 upload UI에서 경고를 표시할 수 있도록 예외/메타데이터 경로를 만들 것.
- 멀티파일 업로드에서 파일별 감지 날짜 표시/수정 UI를 추가하거나, 업로드 완료 결과에 파일별 감지 날짜를 표시할 것.

### Remaining Concerns
- 테스트 코드가 없어 dedupe 정책, 부분 chunk 실패 처리, 멀티파일 날짜 UX를 자동 검증하지 못함.
- MySQL/API 키 기반 전체 end-to-end 검증은 Codex가 수행하지 못함.
- `uv build --wheel` 검증으로 `dist/` 산출물이 생성됨.

### Recommendation
수정 단계 진행 권장. 우선순위는 dedupe 기준 보강과 부분 chunk 실패 가시화.

---

## Entry 021

### Agent
Codex CLI (GPT-5)

### Timestamp
2026-06-30 01:57 KST

### Task Summary
Claude Code Entry 020 수정 사항 리뷰. dedupe 기준 보강과 `PartialExtractionError` 기반 부분 추출 실패 가시화 반영 여부를 검증함. 코드 수정은 하지 않음.

### Files Inspected
- AGENT_LOG.md
- backend/pipeline/extractor.py
- backend/pipeline/ingestor.py
- frontend/pages/upload.py

### Validation Commands
- `uv run python -m compileall frontend backend` 성공
- `uv run pytest` 실행 결과 테스트 0개 수집
- `_dedup()` 수동 확인: 같은 category/content라도 date/source가 다르면 별도 항목으로 유지됨
- `PartialExtractionError` 수동 확인: `items`, `failed`, `total` 속성과 메시지 정상
- `uv build --wheel` 성공: `dist/paim-0.1.0-py3-none-any.whl` 생성됨

### Resolved From Entry 019
- `_dedup()` 키가 `(category, content, date, source)`로 확장되어 날짜/출처가 다른 반복 항목 손실 위험이 줄어듦.
- 일부 chunk tool call 실패 시 `PartialExtractionError`가 발생하고, `frontend/pages/upload.py`에서 `st.warning()`으로 사용자에게 표시한 뒤 부분 결과 저장을 진행함.
- 추출 실패와 저장 실패 메시지가 분리되어 UI 에러 원인 파악이 쉬워짐.

### Issues Found
1. Medium — `frontend/pages/upload.py`는 `PartialExtractionError` 발생 시 경고 후 부분 결과를 저장하지만, 저장 성공 후 최종 성공 메시지는 일반 업로드와 동일함. 사용자가 경고를 놓치면 해당 문서가 완전 추출된 것으로 오해할 수 있음. 부분 저장 상태를 업로드 결과/문서 단위 메타데이터로 남기거나, 성공 메시지에도 부분 저장임을 명시하는 편이 안전함.
2. Medium — `backend/pipeline/extractor.py`의 `_dedup()`은 `date`/`source`를 그대로 key에 사용함. 같은 날짜가 `"2026년 6월 2일"`과 `"2026-06-02"`처럼 다른 문자열로 들어오면 중복 제거가 되지 않음. 이후 `ingestor`에서 날짜를 normalize하므로 저장 시에는 같은 날짜가 될 수 있어 중복 memory가 남을 수 있음.
3. Low — `frontend/pages/upload.py`의 멀티파일 업로드는 파일별 날짜를 자동 추출만 하고 사용자가 확인/수정할 UI가 없음. 이 이슈는 아직 남아 있음.

### Recommended Fixes
- `PartialExtractionError` 경로에서는 최종 메시지를 `"부분 업로드 완료"`처럼 별도 표시하고, 가능하면 `documents` 또는 별도 로그에 partial 상태를 남길 것.
- `_dedup()` 전에 날짜를 extractor 레벨에서도 normalize하거나, dedupe key에 normalized date를 사용할 것. `source`도 공백/대소문자 normalize를 적용하는 것이 좋음.
- 멀티파일 업로드에서 파일별 감지 날짜 표시/수정 UI를 추가하거나, 최소한 업로드 결과에 파일별 감지 날짜와 partial 여부를 표시할 것.

### Remaining Concerns
- 테스트 코드가 없어 dedupe 정책, partial extraction, 저장 보상 처리 회귀 검증이 자동화되어 있지 않음.
- MySQL/API 키 기반 전체 end-to-end 검증은 Codex가 수행하지 못함.
- `uv build --wheel` 검증으로 `dist/` 산출물이 생성됨.

### Recommendation
수정 단계 진행 권장. 우선순위는 partial 저장 상태의 UI/메타데이터 가시화와 dedupe 날짜 normalize.

---

## Entry 023

### Agent
Codex CLI (GPT-5)

### Timestamp
2026-06-30 02:00 KST

### Task Summary
Claude Code Entry 022 수정 사항 리뷰. partial 업로드 성공 메시지 분기와 dedupe 날짜/source 정규화 반영 여부를 검증함. 코드 수정은 하지 않음.

### Files Inspected
- AGENT_LOG.md
- backend/pipeline/extractor.py
- frontend/pages/upload.py

### Validation Commands
- `uv run python -m compileall frontend backend` 성공
- `uv run pytest` 실행 결과 테스트 0개 수집
- `_norm_date_key()` 수동 확인:
  - `"2026년 6월 2일"` → `"2026-06-02"`
  - `"2026/6/2"` → `"2026-06-02"`
- `_dedup()` 수동 확인: 날짜 표현/source 공백/대소문자가 다른 동일 항목은 1개로 dedupe되고, 실제 날짜가 다른 항목은 별도 유지됨.
- `uv build --wheel` 성공: `dist/paim-0.1.0-py3-none-any.whl` 생성됨

### Resolved From Entry 021
- `frontend/pages/upload.py`에서 partial extraction 경로의 최종 성공 메시지가 `"부분 업로드 완료 (일부 청크 추출 실패)"`로 분기됨.
- `backend/pipeline/extractor.py`의 `_dedup()`가 `_norm_date_key()`와 source strip/lower를 사용하여 날짜 표현 차이와 source 공백/대소문자 차이로 인한 중복 저장 위험이 줄어듦.

### Issues Found
1. Low — `frontend/pages/upload.py`의 멀티파일 업로드는 파일별 날짜를 자동 추출만 하고 사용자가 확인/수정할 UI가 없음. 자동 추출 오류를 보정할 수 없어 파일별 timeline 날짜 품질이 낮아질 수 있음.
2. Low — 테스트 코드가 없어 현재까지 반복 수정된 날짜 검증, PDF 예외, dedupe, partial extraction 동작이 회귀될 가능성을 자동으로 잡지 못함.

### Recommended Fixes
- 멀티파일 업로드에서 파일별 감지 날짜를 표시하고 수정할 수 있게 하거나, 최소한 업로드 결과에 파일별 감지 날짜와 partial 여부를 표시할 것.
- 우선순위 높은 최소 테스트를 추가할 것:
  - `_extract_date`, `_validate_date`, `_normalize_date`
  - `_dedup`, `PartialExtractionError`
  - PDF 파싱 실패 시 빈 문자열 처리

### Remaining Concerns
- MySQL/API 키 기반 전체 end-to-end 검증은 Codex가 수행하지 못함.
- `uv build --wheel` 검증으로 `dist/` 산출물이 생성됨.

### Recommendation
치명적/중간 심각도 이슈는 현재 리뷰 범위에서 발견되지 않음. 다음 단계는 최소 pytest 추가와 멀티파일 날짜 UX 개선 권장.

---

## Entry 022

### Agent
Claude Code (claude-sonnet-4-6)

### Timestamp
2026-06-30 03:40

### Task Summary
Codex Entry 021 지적 사항 수정 (Medium 2건).

### Files Modified
- `frontend/pages/upload.py`
  - `partial` 플래그 추가: `PartialExtractionError` 경로에서 `True` 설정
  - 성공 메시지 분기: 부분 저장 시 `"부분 업로드 완료 (일부 청크 추출 실패)"`, 정상 시 `"업로드 완료"`
- `backend/pipeline/extractor.py`
  - `_norm_date_key()` 추가: Korean/slash/dot → YYYY-MM-DD 변환 (dedup 전용)
  - `_dedup()` 키를 `(category, content.strip().lower(), _norm_date_key(date), source.strip().lower())` 로 통일

### Changes Made
| Codex Issue | 조치 |
|---|---|
| Medium #1: 부분 저장 성공 메시지 미구분 | `partial` 플래그 + 메시지 분기 |
| Medium #2: dedupe 날짜 비정규화 중복 | `_norm_date_key()` 적용, source도 strip/lower |

### Validation
- `uv run python -m compileall backend/pipeline/extractor.py frontend/pages/upload.py` 성공

### Remaining Concerns
- 멀티파일 업로드 파일별 날짜 확인 UI 미구현 (Low, 반복 지적)
- 테스트 코드 미존재

---

## Entry 020

### Agent
Claude Code (claude-sonnet-4-6)

### Timestamp
2026-06-30 03:25

### Task Summary
Codex Entry 019 지적 사항 수정 (Medium 2건).

### Files Modified
- `backend/pipeline/extractor.py`
  - `_dedup()` 키에 `date`, `source` 추가: `(category, content, date, source)` 기준으로 같은 내용도 날짜/출처가 다르면 별도 항목 유지
  - `PartialExtractionError` 커스텀 예외 추가: `items`, `failed`, `total` 속성 포함
  - 멀티청크 일부 실패 시 `PartialExtractionError` raise (부분 결과 포함)
- `frontend/pages/upload.py`
  - `PartialExtractionError` 별도 catch: `st.warning()` 표시 후 추출된 항목으로 ingest 계속 진행
  - extract/ingest 예외 분리: 추출 실패와 저장 실패 에러 메시지 구분

### Changes Made
| Codex Issue | 조치 |
|---|---|
| Medium #1: dedupe 키 정보 손실 | 키에 `date` + `source` 추가 |
| Medium #2: 부분 청크 실패 비가시 | `PartialExtractionError` + UI 경고 표시 |

### Validation
- `uv run python -m compileall backend/pipeline/extractor.py frontend/pages/upload.py` 성공

### Remaining Concerns
- 멀티파일 업로드 파일별 날짜 확인 UI 미구현 (Low, 반복 지적)
- 테스트 코드 미존재

---

## Entry 018

### Agent
Claude Code (claude-sonnet-4-6)

### Timestamp
2026-06-30 03:10

### Task Summary
Entry 016 수정 누락 기록(Entry 018로 보완) + Codex Entry 017 지적 사항 수정 (Medium 2건).

### Files Modified
- `backend/pipeline/extractor.py`
  - `_extract_chunk()`: `response.tool_input is None` → `ValueError` raise (LLM tool call 미반환), `items == []` → 정상 빈 리스트 반환으로 명확히 구분
  - 멀티청크 루프: chunk별 `ValueError`를 catch하고 `failed_chunks` 카운트, 전체 실패 시에만 최종 raise
  - `_dedup()` 추가: `(category, content.strip().lower())` 기준 중복 제거, 멀티청크 결과에만 적용

### Changes Made
| Codex Issue | 조치 |
|---|---|
| Medium #1: 청크 경계 중복 저장 | `_dedup()` — category + content 기준 Set으로 중복 제거 |
| Medium #2: tool output None vs 빈 리스트 미구분 | `tool_input is None` 시 ValueError, `items == []` 는 정상 처리 |

### Validation
- `uv run python -m compileall backend/pipeline/extractor.py` 성공

### Remaining Concerns
- 일부 청크 실패(failed_chunks > 0 but < total) 시 경고 없이 진행 — 추후 로깅 추가 고려
- 테스트 코드 미존재
