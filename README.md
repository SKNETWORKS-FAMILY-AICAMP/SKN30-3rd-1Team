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
LLM_PROVIDER=claude          # claude | openai | google

ANTHROPIC_API_KEY=...
CLAUDE_MODEL=claude-sonnet-4-6

OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o

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
| Claude | ✅ | ✅ |
| OpenAI | ✅ | ✅ |
| Google | ❌ | ✅ |

> Google Gemini는 Q&A 전용. 중첩 스키마 미지원으로 구조화 추출 불가.

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
