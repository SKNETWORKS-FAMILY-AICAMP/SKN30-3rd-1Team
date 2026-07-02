# 🧠 PaiM — Project AI Manager

> 회의록과 기획 문서에서 **결정 · 액션 · 이슈 · 리스크**를 자동으로 추출해 관리하는 LLM 기반 AI 프로젝트 매니저

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| **문서 업로드** | `.md` / `.txt` / `.pdf` 멀티파일 업로드. 날짜 자동 추출 |
| **구조화 추출** | LLM이 결정·액션·이슈·리스크 4종을 JSON으로 구조화 |
| **메모리 대시보드** | 카테고리별 카드 뷰, 탭 필터 |
| **Q&A 채팅** | 자연어로 프로젝트 기록 조회. 멀티턴 히스토리 유지 |
| **타임라인** | 날짜별 그룹화 시각적 타임라인 |

---

## 시스템 흐름

```
문서 업로드 → 3000자 청크 분할 → LLM 구조화 추출 → 중복 제거
                                                        ├→ MySQL (카테고리 검색)
                                                        └→ ChromaDB (벡터 검색)

Q&A 질문 → 키워드 분류 → MySQL / ChromaDB / Both → LLM 답변 생성
```

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
