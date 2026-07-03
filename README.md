# 🧠 PaiM — Project AI Manager

> **내가 쉬는 동안 프로젝트를 파악해주는 AI PM.**
> 회의록·문서·GitHub 활동을 하나의 **살아있는 메모리**로 쌓고, AI가 스스로 Issue와 PR을 읽어 액션 완료를 감지하고 다음 할 일(Action Plan)을 제안합니다.

---

## 왜 PaiM인가 — 살아있는 메모리 (Living Memory)

대부분의 프로젝트 관리 도구는 사람이 상태를 직접 갱신해야 하는 **죽은 기록**입니다. PaiM의 메모리는 프로젝트가 움직이면 따라 움직입니다.

```
        ① 기록                    ② 관찰                       ③ 대조 (Reconciler)
  회의록·문서 업로드      GitHub 저장소 동기화           머지된 PR ↔ 열린 액션을
  → 결정·액션·이슈·      → README·커밋·열린            LLM이 매칭 → "이 액션,
    리스크 자동 추출        Issue·PR을 메모리에 적재       이 PR로 완료된 것 같아요"
        │                        │                            │
        └────────────┬───────────┘                            │
                     ▼                                        ▼
        ④ 브리핑 (Delta Briefing)                ⑤ 제안 (Suggestion + Action Plan)
  앱을 다시 열면 "지난 확인 이후                 완료 제안은 승인/거절로 확정하고,
  진행된 것 / 새로 생긴 것 / 급한 것"을          모든 Q&A 답변에는 다음 할 일
  스탠드업 브리핑으로 요약                        todo(Action Plan)가 따라붙음
```

동작 방식을 단계별로 풀면:

1. **기록** — 회의록을 올리면 LLM이 결정·액션·이슈·리스크를 구조화 추출해 MySQL(카테고리 검색)과 ChromaDB(벡터 검색)에 쌓고, 프로젝트 전체 요약 메모리를 갱신합니다.
2. **관찰** — GitHub 저장소를 연결하면 README·커밋·열린 Issue·열린 PR 텍스트를 수집해 같은 추출 파이프라인으로 메모리에 합칩니다. 회의에서 말한 것과 코드에서 벌어지는 일이 한 메모리에 모입니다.
3. **대조 (Reconciler)** — 저장소 동기화 직후 자동 실행됩니다. 지난 동기화 이후 **새로 머지된 PR**과 **메모리의 열린 액션**을 LLM이 대조해, PR이 액션을 실제로 수행했다고 판단되면 완료 제안을 만듭니다. 애매하면 제안하지 않는 **정확도 우선 원칙**(high/medium 확신 + 한 줄 근거 필수)으로 오탐을 줄입니다.
4. **브리핑 (Delta Briefing)** — 프로젝트를 다시 열면 지난 확인 시점 이후의 변화만 골라 "무엇이 진행됐고, 무엇이 새로 생겼고, 무엇이 급한가"를 스탠드업 대체 브리핑으로 요약합니다. 자리를 비운 사이의 공백이 8문장 안에 메워집니다.
5. **제안 (Suggestion + Action Plan)** — 완료 제안은 사용자가 승인/거절로 확정합니다(승인 시 액션 자동 완료 처리). 또한 모든 Q&A 답변 뒤에는 답변을 근거로 한 다음 할 일 todo 목록이 따라붙어, 조회가 곧 계획으로 이어집니다.

핵심은 **루프가 스스로 닫힌다**는 것입니다: 회의에서 "A가 X를 하기로 함"이 액션으로 기록되고 → A가 PR을 머지하면 → PaiM이 그 PR을 읽고 액션 완료를 제안하고 → 다음 브리핑에서 "X 진행됨"으로 보고됩니다. 사람은 상태를 갱신하는 대신 **제안을 승인만** 하면 됩니다.

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| **문서 업로드** | `.md` / `.txt` / `.pdf` 멀티파일 업로드. 날짜 자동 추출 |
| **구조화 추출** | LLM이 결정·액션·이슈·리스크 4종을 JSON으로 구조화 |
| **GitHub 동기화** | README·커밋·열린 Issue·PR을 메모리에 적재 (GitHub App 인증) |
| **완료 제안 (Reconciler)** | 머지된 PR과 열린 액션을 LLM이 매칭해 완료 제안 → 승인/거절 |
| **델타 브리핑** | 지난 확인 이후 진행·신규·긴급 사항을 스탠드업 브리핑으로 요약 |
| **Q&A 채팅 + Action Plan** | 자연어로 프로젝트 기록 조회 + 답변 기반 다음 할 일 제안. 멀티턴 히스토리 유지 |
| **메모리 대시보드** | 카테고리별 카드 뷰, 탭 필터 |
| **타임라인** | 날짜별 그룹화 시각적 타임라인 |

---

## 시스템 흐름

```
문서 업로드 → 3000자 청크 분할 → LLM 구조화 추출 → 중복 제거
                                                        ├→ MySQL (카테고리 검색)
                                                        └→ ChromaDB (벡터 검색)

GitHub 동기화 → README·커밋·Issue·PR 수집 → 같은 추출 파이프라인 → 메모리 적재
             └→ 머지 PR 감지 → Reconciler(LLM 매칭) → 완료 제안 생성

Q&A 질문 → 키워드 분류 → MySQL / ChromaDB / Both → LLM 답변 생성
        → 답변 자기검증(부족하면 질의 확장 후 재검색) → Action Plan 제안
```

---

## 핵심 설계 포인트

- **스스로 닫히는 메모리 루프, 최종 결정은 사람** — Reconciler가 PR을 읽고 액션 완료를 감지하지만 자동으로 닫지 않고 제안으로 만듭니다. AI가 감지하고 사람이 승인하는 human-in-the-loop 구조라 메모리가 조용히 오염되지 않습니다.
- **정확도 > 재현율** — 완료 매칭은 "애매하면 보고하지 않는다"가 규칙입니다. 놓친 제안은 다음 동기화나 사람이 잡을 수 있지만, 틀린 완료 처리는 신뢰를 무너뜨리기 때문입니다.
- **자기검증하는 답변 그래프** — Q&A는 LangGraph로 검색 → 답변 → 검증 → (부족하면) 질의 확장 후 재검색 → Action Plan 생성 → 계획 검증까지 도는 그래프입니다. Plan 생성이 실패해도 답변은 유지되는 best-effort 설계입니다.
- **로컬 우선 + 암호화** — 백엔드는 `127.0.0.1`에만 바인딩되어 LAN에 노출되지 않고, 세션 대화는 AES-256-GCM으로 암호화 저장됩니다. 회의록이라는 민감 데이터를 다루는 도구로서의 기본기입니다.

---

## 기술 스택

- **프론트엔드**: Streamlit (MVP)
- **백엔드**: FastAPI (추후 React 연동용)
- **구조화 DB**: MySQL 8.0 (Docker)
- **벡터 DB**: ChromaDB
- **LLM**: OpenAI · Claude · Google (`.env`에서 전환)
- **패키지 관리**: `uv` + `hatchling`

---

## 빠른 시작

### 1. 환경변수 설정

```bash
cp .env.example .env
# .env에서 API 키와 DB 비밀번호 입력
```

```env
LLM_PROVIDER=openai          # openai | claude | google | local

OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini

ANTHROPIC_API_KEY=...
CLAUDE_MODEL=claude-sonnet-4-6

GOOGLE_API_KEY=...
GOOGLE_MODEL=gemini-1.5-pro

# local provider (Ollama / vLLM / LM Studio 등 OpenAI 호환 서버)
# LOCAL_LLM_URL=http://localhost:11434/v1
# LOCAL_LLM_MODEL=llama3

DB_HOST=localhost
DB_USER=root
DB_PASSWORD=...
DB_NAME=paiM

CHROMA_PERSIST_DIR=.chroma
```

### 2. MySQL 실행

```bash
docker compose up -d
```

### 3. 의존성 설치 및 앱 실행

```bash
uv sync
uv run streamlit run frontend/app.py --server.port 8502
```

브라우저에서 `http://localhost:8502` 접속

### 4. 데스크톱 앱 설치

개발 목적이 아니라 앱을 사용만 한다면 직접 빌드하지 말고 GitHub Release에서 설치 파일을 내려받습니다.

- macOS: `PaiM-...-macos-...` 파일
- Windows: `PaiM-...-windows-...-setup.exe` 또는 `.msi` 파일

설치 파일이 없다면 개발 환경을 직접 맞추는 대신 새 Release 생성을 요청합니다.

> **주의**: 설치 파일에는 UI만 포함됩니다. 앱은 로컬 백엔드(`http://127.0.0.1:8000`)에 접속하므로 MySQL과 백엔드 서버가 같은 PC에서 실행 중이어야 합니다.

#### Windows 원클릭 실행 (`start-paim.bat`)

uv와 Docker Desktop이 설치되어 있다면, 저장소 클론 후 루트의 `start-paim.bat`을 더블클릭하면 아래 과정이 자동으로 진행됩니다.

1. Docker 데몬 확인 — 꺼져 있으면 Docker Desktop 자동 실행
2. `.env` 자동 생성 — 최초 1회만 메모장이 열리며 API 키와 `DB_PASSWORD` 입력 필요 (`SESSION_MEMORY_KEY`는 자동 생성)
3. MySQL 컨테이너 시작 후 준비될 때까지 대기
4. `uv sync` 후 백엔드를 새 창("PaiM Backend")에서 실행
5. 설치된 PaiM 앱 자동 실행

앱을 쓰는 동안 "PaiM Backend" 창은 켜둡니다. 두 번째 실행부터는 입력 없이 끝까지 자동 진행됩니다.

### 5. 데스크톱 앱 개발 실행

데스크톱 앱은 `desktop/` 폴더에 분리되어 있습니다. 개발 실행에는 아래 도구가 필요합니다.

- Node.js LTS
- Rust/Cargo
- Windows: Microsoft C++ Build Tools, WebView2 Runtime
- macOS: Xcode Command Line Tools

루트 폴더에서 아래 명령을 실행합니다.

```bash
npm ci --prefix desktop
npm run demo --prefix desktop
```

현재 소스는 macOS/Windows 모두 같은 명령으로 실행할 수 있습니다.

설치 파일을 직접 빌드하려면:

```bash
npm run app:build --prefix desktop
```

빌드 결과는 보통 아래 폴더에 생성됩니다.

- macOS: `desktop/src-tauri/target/release/bundle/`
- Windows: `desktop/src-tauri/target/release/bundle/msi/` 또는 `desktop/src-tauri/target/release/bundle/nsis/`

macOS에서 `.app`만 빌드하고 바로 실행하려면:

```bash
npm run demo:mac --prefix desktop
```

데스크톱 앱 검증:

```bash
npm run test:offline --prefix desktop
npm run test:layout --prefix desktop
```

---

## 프로젝트 구조

```
PaiM/
├── backend/
│   ├── pipeline/        # 추출(extractor) + 저장(ingestor)
│   ├── llm/             # LLM 클라이언트 (OpenAI · Claude · Google)
│   ├── retriever/       # Q&A 엔진 + 검색 라우팅
│   └── db/              # MySQL · ChromaDB 연결 + schema.sql
├── frontend/
│   ├── app.py           # Streamlit 진입점
│   ├── views/           # 업로드 · 대시보드 · 채팅 · 타임라인
│   └── components/      # 공통 UI 컴포넌트
├── desktop/             # Tauri + React 데스크톱 앱
│   ├── src/             # React UI
│   └── src-tauri/       # Tauri 런타임
├── data/samples/        # 테스트용 샘플 회의록
├── docker-compose.yml
├── .env.example
└── pyproject.toml
```

---

## LLM 제공자 지원 범위

| 제공자 | 구조화 추출 | Q&A |
|--------|:----------:|:---:|
| OpenAI | ✅ | ✅ |
| Claude | ✅ | ✅ |
| Google | ❌ | ✅ |
| Local  | ✅ | ✅ |

> Google Gemini는 Q&A 전용. 중첩 스키마 미지원으로 구조화 추출 불가.
> Local은 Ollama, vLLM, LM Studio 등 OpenAI 호환 서버를 사용. `LOCAL_LLM_URL`, `LOCAL_LLM_MODEL`로 지정.

---

## 데이터 모델

추출된 항목은 `category` 필드로 분류됩니다.

| 카테고리 | 설명 |
|----------|------|
| `decision` | 회의에서 결정된 사항 (결정 이유 포함) |
| `action` | 담당자 배정 액션 아이템 (마감일은 content에 포함) |
| `issue` | 미해결 문제 |
| `risk` | 잠재적 위험 요소 |

`date` 필드는 항상 **회의/문서 날짜** (`YYYY-MM-DD`). 액션 마감일은 `content` 필드 텍스트에 포함.

## Roadmap

### 3차 프로젝트 마무리 (현재 — 로컬 서버, 개인 사용)

- [ ] 검색 품질 평가셋(골든 질문 20~30개) 구축 및 baseline 측정
- [ ] 세션 기반 채팅에 RAG 내장 — 서버 측 대화 이력 축적
- [ ] 임베딩 모델·리랭커 개선 — 평가셋 측정 결과 기반으로 결정

### 4차 프로젝트 (약 한 달 뒤 — 팀 서비스로 확장)

- [ ] AWS 서버 전환 — 로컬 전용에서 벗어나 상시 접속 가능한 서버로 (HTTPS, 서버 주소 계약)
- [ ] 로그인 시스템 — 사용자 계정과 토큰 인증 (현재 DEV 임시 인증 대체)
- [ ] 팀 협업 — 하나의 프로젝트를 팀원들이 공유 (멤버·권한 관리, 함께 쓰는 프로젝트 메모리)
- [ ] 입력 파일 확장 — 음성(회의 녹음), 이미지(화이트보드·스크린샷) 등도 분석 대상으로
