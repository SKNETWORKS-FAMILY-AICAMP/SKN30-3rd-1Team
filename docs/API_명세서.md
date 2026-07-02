# PaiM FastAPI 명세서

**Base URL (로컬)**: `http://127.0.0.1:8000`  
**API Prefix**: `/api/v1`  
**Content-Type**: `application/json` (파일 업로드는 `multipart/form-data`)  
**에러 형식**: FastAPI 기본 `{"detail": "..."}`

---

## 서버 상태

### `GET /`

서비스 식별 및 구동 확인.

**응답 `200`**
```json
{
  "service": "PaiM",
  "status": "ok"
}
```

---

### `GET /health`

서버 정상 구동 여부 확인 (헬스체크 전용).

**응답 `200`**
```json
{
  "status": "ok"
}
```

---

## 프로젝트

### `POST /api/v1/projects`

프로젝트 생성.

**요청 Body**
```json
{
  "name": "PaiM MVP"
}
```

**응답 `201`**
```json
{
  "id": 1,
  "name": "PaiM MVP",
  "created_at": "2026-07-01T12:00:00"
}
```

---

### `GET /api/v1/projects`

프로젝트 목록 조회 (최신순).

**응답 `200`**
```json
[
  {
    "id": 1,
    "name": "PaiM MVP",
    "created_at": "2026-07-01T12:00:00"
  }
]
```

---

### `GET /api/v1/projects/{project_id}`

프로젝트 단건 조회.

**응답 `200`**
```json
{
  "id": 1,
  "name": "PaiM MVP",
  "created_at": "2026-07-01T12:00:00"
}
```

**응답 `404`**
```json
{ "detail": "Project not found" }
```

---

## 문서

### `POST /api/v1/projects/{project_id}/documents`

문서 업로드. 서버가 파일을 저장하고 텍스트 추출 → 청킹 → Vector DB → LLM 추출 → DB 저장을 처리한다.

**요청** `multipart/form-data`

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `file` | File | ✅ | `.md` / `.txt` / `.pdf` (최대 10 MB) |
| `date` | string | - | 문서 날짜 `YYYY-MM-DD` |

> **`doc_type` 변경 (2026-07-02)**: 프론트에서 전송하지 않습니다. 서버가 파일명 기반으로 자동 추론합니다.
> - `회의`, `meeting`, `minutes` 포함 → `meeting`
> - `기획`, `plan`, `planning`, `roadmap`, `spec` 포함 → `planning`
> - 그 외 → `document`

**응답 `201`**
```json
{
  "doc_id": 12,
  "status": "processing"
}
```

**응답 `400`**
```json
{ "detail": "지원하지 않는 파일 형식입니다. (.md / .txt / .pdf)" }
```

**응답 `404`**
```json
{ "detail": "Project not found" }
```

**응답 `413`**
```json
{ "detail": "파일 크기는 10 MB를 초과할 수 없습니다." }
```

> **처리 흐름**: 업로드 즉시 `processing` 반환 → 백그라운드 처리 완료 후 `indexed` 또는 `failed` 로 상태 갱신.

---

### `GET /api/v1/projects/{project_id}/documents`

문서 목록 조회.

**응답 `200`**
```json
[
  {
    "id": 12,
    "filename": "planning.pdf",
    "doc_type": "planning",
    "status": "indexed",
    "uploaded_at": "2026-07-01T12:00:00"
  }
]
```

---

### `GET /api/v1/projects/{project_id}/documents/{doc_id}/status`

문서 처리 상태 조회. 데스크톱 앱이 폴링으로 사용.

**상태값**

| 값 | 의미 |
|----|------|
| `uploaded` | 업로드 완료, 처리 대기 |
| `processing` | 처리 중 |
| `indexed` | 처리 완료 |
| `failed` | 처리 실패 |

**응답 `200`**
```json
{
  "doc_id": 12,
  "status": "indexed",
  "extracted": {
    "decision": 2,
    "action": 4,
    "issue": 1,
    "risk": 1
  }
}
```

**응답 `404`**
```json
{ "detail": "Document not found" }
```

---

### `DELETE /api/v1/projects/{project_id}/documents/{doc_id}`

문서 삭제. 아래 데이터를 함께 삭제한다.

- 문서 메타데이터 (DB)
- 해당 문서에서 생성된 Project Memory (DB)
- 해당 문서의 Vector DB chunks
- 서버에 저장한 원본 파일

**응답 `204`** (No Content)

**응답 `404`**
```json
{ "detail": "Document not found" }
```

---

## Git Repository

### `POST /api/v1/projects/{project_id}/repositories`

GitHub repository 연결. MVP는 public repo만 지원.

**요청 Body**
```json
{
  "provider": "github",
  "repository_url": "https://github.com/org/repo",
  "branch": "main"
}
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `provider` | string | ✅ | `github` 고정 (MVP) |
| `repository_url` | string | ✅ | public GitHub repo URL |
| `branch` | string | - | 미지정 시 default branch 사용 |

**응답 `201`**
```json
{
  "repo_id": 3,
  "status": "connected",
  "branch": "main"
}
```

**응답 `400`**
```json
{ "detail": "Invalid repository URL" }
```

> 연결 후 서버가 README / commits / issues / PRs 수집 → 처리 시작.

---

### `GET /api/v1/projects/{project_id}/repositories`

연결된 repository 목록 조회.

**응답 `200`**
```json
[
  {
    "id": 3,
    "provider": "github",
    "repository_url": "https://github.com/org/repo",
    "branch": "main",
    "status": "indexed",
    "connected_at": "2026-07-01T12:00:00"
  }
]
```

---

### `GET /api/v1/projects/{project_id}/repositories/{repo_id}`

Repository 단건 조회.

**응답 `200`**
```json
{
  "id": 3,
  "provider": "github",
  "repository_url": "https://github.com/org/repo",
  "branch": "main",
  "status": "indexed",
  "commit_sha": "abc123",
  "indexed_files": 3,
  "sync_warning": null,
  "connected_at": "2026-07-01T12:00:00"
}
```

---

### `GET /api/v1/projects/{project_id}/repositories/{repo_id}/status`

Repository sync 상태 조회. 데스크톱 앱이 폴링으로 사용.

**상태값**

| 값 | 의미 |
|----|------|
| `connected` | 연결 완료, 수집 대기 |
| `syncing` | 수집 및 처리 중 |
| `indexed` | 처리 완료 |
| `failed` | 처리 실패 |

**응답 `200`**
```json
{
  "repo_id": 3,
  "status": "indexed",
  "provider": "github",
  "repository_url": "https://github.com/org/repo",
  "branch": "main",
  "commit_sha": "abc123",
  "indexed_files": 3,
  "last_error": null,
  "sync_warning": null,
  "extracted": {
    "decision": 3,
    "action": 7,
    "issue": 4,
    "risk": 2
  }
}
```

---

### `POST /api/v1/projects/{project_id}/repositories/{repo_id}/sync`

Repository 재동기화 요청.

**응답 `202`**
```json
{
  "repo_id": 3,
  "status": "syncing"
}
```

---

### `DELETE /api/v1/projects/{project_id}/repositories/{repo_id}`

Repository 연결 해제. 아래 데이터를 함께 삭제한다.

- repo 연결 정보 (DB)
- 해당 repo에서 생성된 Project Memory (DB)
- 해당 repo의 Vector DB chunks
- 서버에 캐시한 repo 파일

**응답 `204`** (No Content)

**응답 `404`**
```json
{ "detail": "Repository not found" }
```

---

## Project Memory

LLM이 문서 또는 repository에서 추출한 구조화된 프로젝트 기억.

**카테고리**: `decision` / `action` / `issue` / `risk`

### `GET /api/v1/projects/{project_id}/memory`

Memory 목록 조회.

**Query Parameters**

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `category` | string | `decision` \| `action` \| `issue` \| `risk` |
| `owner` | string | 담당자 이름 필터 |

**응답 `200`**
```json
[
  {
    "id": 1,
    "project_id": 1,
    "doc_id": 12,
    "repo_id": null,
    "category": "action",
    "content": "API 규약을 정리한다",
    "owner": "지훈",
    "date": "2026-06-30",
    "topic": "API 설계",
    "reason": null,
    "source": "planning.pdf",
    "created_by": "llm",
    "updated_by": null,
    "is_user_verified": false,
    "created_at": "2026-07-01T12:00:00",
    "source_info": {
      "kind": "document",
      "doc_id": 12,
      "repo_id": null,
      "type": "meeting",
      "path": "planning.pdf",
      "ref": null,
      "url": null
    }
  }
]
```

---

### `POST /api/v1/projects/{project_id}/memory`

Memory 항목 수동 추가.

**요청 Body**
```json
{
  "category": "action",
  "content": "배포 전 보안 점검 수행",
  "owner": "지훈",
  "date": "2026-07-05",
  "topic": "배포 준비"
}
```

| 필드 | 타입 | 필수 |
|------|------|------|
| `category` | string | ✅ |
| `content` | string | ✅ |
| `owner` | string | - |
| `date` | string | - |
| `topic` | string | - |
| `reason` | string | - |

**응답 `201`**
```json
{
  "id": 99,
  "category": "action",
  "content": "배포 전 보안 점검 수행",
  "owner": "지훈",
  "date": "2026-07-05",
  "topic": "배포 준비",
  "reason": null,
  "created_by": "user",
  "updated_by": null,
  "is_user_verified": true,
  "created_at": "2026-07-01T12:00:00"
}
```

---

### `PATCH /api/v1/projects/{project_id}/memory/{memory_id}`

Memory 항목 수정. 사용자가 수정한 항목은 `is_user_verified: true` 로 마킹되어 LLM 재처리 시 덮어쓰지 않는다.

**요청 Body** (수정할 필드만 포함)
```json
{
  "content": "API 규약을 이번 주 내로 정리한다",
  "owner": "지훈"
}
```

**응답 `200`**
```json
{
  "id": 1,
  "category": "action",
  "content": "API 규약을 이번 주 내로 정리한다",
  "owner": "지훈",
  "date": "2026-06-30",
  "topic": "API 설계",
  "updated_by": "user",
  "is_user_verified": true
}
```

**응답 `404`**
```json
{ "detail": "Memory item not found" }
```

---

### `DELETE /api/v1/projects/{project_id}/memory/{memory_id}`

Memory 항목 삭제.

**응답 `204`** (No Content)

**응답 `404`**
```json
{ "detail": "Memory item not found" }
```

---

## 채팅 세션

> **경로 확정 (2026-07-02)**: 세션 엔드포인트는 `/api/v1/projects/{id}/sessions/*` 로 확정되었습니다.

### `POST /api/v1/projects/{project_id}/sessions`

채팅 세션 생성.

**요청 Body**
```json
{ "title": "스프린트 3 리뷰" }
```

**응답 `201`**
```json
{
  "id": "sess_a1b2c3d4e5f6",
  "project_id": 1,
  "title": "스프린트 3 리뷰",
  "created_at": "2026-07-02T10:00:00",
  "updated_at": "2026-07-02T10:00:00"
}
```

---

### `GET /api/v1/projects/{project_id}/sessions`

세션 목록 조회 (최신순).

**응답 `200`**
```json
[
  {
    "id": "sess_a1b2c3d4e5f6",
    "project_id": 1,
    "title": "스프린트 3 리뷰",
    "created_at": "2026-07-02T10:00:00",
    "updated_at": "2026-07-02T10:00:00"
  }
]
```

---

### `PATCH /api/v1/projects/{project_id}/sessions/{session_id}`

세션 제목 수정.

**요청 Body**
```json
{ "title": "새 제목" }
```

**응답 `200`** — 수정된 세션 객체 반환

**응답 `404`**
```json
{ "detail": "해당 프로젝트에서 요청하신 세션을 찾을 수 없습니다." }
```

---

### `DELETE /api/v1/projects/{project_id}/sessions/{session_id}`

세션 삭제. 하위 메시지(`chat_messages`)와 요약(`chat_summaries`)도 함께 삭제됨.

**응답 `204`** (No Content)

**응답 `404`**
```json
{ "detail": "해당 프로젝트에서 요청하신 세션을 찾을 수 없습니다." }
```

---

### `GET /api/v1/projects/{project_id}/sessions/{session_id}/messages`

세션 메시지 이력 조회. 메시지 본문은 AES-256-GCM으로 저장되며 응답 시 복호화됨.

**응답 `200`**
```json
[
  {
    "id": 1,
    "role": "user",
    "text": "로그인 기능은 왜 제외했나요?",
    "token_count": 12,
    "created_at": "2026-07-02T10:00:00"
  },
  {
    "id": 2,
    "role": "assistant",
    "text": "MVP 범위에서 제외됐습니다...",
    "token_count": 47,
    "created_at": "2026-07-02T10:00:01"
  }
]
```

---

### `POST /api/v1/projects/{project_id}/sessions/{session_id}/query`

세션 기반 대화형 질의. 암호화된 대화 이력을 컨텍스트로 사용하며 롤링 요약을 자동 관리함.

**요청 Body**
```json
{
  "current_question": "현재 가장 큰 리스크가 뭐야?",
  "rag_context": ""
}
```

| 필드 | 타입 | 설명 |
|---|---|---|
| `current_question` | string | 현재 질문 |
| `rag_context` | string | RAG 검색 결과 평문 (선택, 프론트에서 먼저 `/query` 호출 후 전달 가능) |

**응답 `200`**
```json
{
  "status": "success",
  "session_id": "sess_a1b2c3d4e5f6",
  "answer": "현재 가장 큰 리스크는 API 계약 변경 가능성입니다."
}
```

**응답 `503`**
```json
{ "detail": "LLM 응답 생성 중 오류가 발생했습니다. 서버 로그를 확인하세요." }
```

---

## 질의 (Q&A)

### `POST /api/v1/projects/{project_id}/query`

프로젝트 기반 자연어 질의.

**요청 Body**
```json
{
  "question": "현재 가장 큰 리스크가 뭐야?",
  "history": [
    { "role": "user", "content": "이전 질문" },
    { "role": "assistant", "content": "이전 답변" }
  ]
}
```

**응답 `200`**
```json
{
  "answer": "현재 가장 큰 리스크는 API 계약 변경 가능성입니다.",
  "plan": [
    "API 계약 변경 사항을 프론트엔드 팀과 공유한다",
    "영향받는 엔드포인트 목록을 작성한다"
  ],
  "sources": ["planning.pdf", "meeting_notes.md"],
  "route": "both",
  "debug": {
    "filters": { "category": null },
    "mysql_rows": [
      { "category": "risk", "content": "...", "source": "planning.pdf" }
    ],
    "chroma_chunks": [
      { "text": "...(200자)", "source": "planning.pdf", "date": "2026-06-30" }
    ]
  }
}
```

> **`plan`**: LLM이 답변을 근거로 생성한 다음 할 일 목록 (best-effort — 생성 실패 시 빈 배열 `[]` 반환).

**응답 `503`**
```json
{ "detail": "Q&A 처리 중 오류가 발생했습니다. 서버 로그를 확인하세요." }
```

---

## 공통 에러 코드

| 상태 코드 | 의미 |
|----------|------|
| `400` | 잘못된 요청 (빈 content, 잘못된 날짜 형식 등) |
| `404` | 리소스 없음 |
| `422` | Pydantic 유효성 검사 실패 |
| `503` | LLM / 외부 서비스 오류 |

---

## 구현 현황

> 갱신: 2026-07-02 (`feature/api-build-on-main` 기준 — origin/main 병합 완료)

| 엔드포인트 | 상태 |
|-----------|------|
| `GET /` | ✅ 구현 완료 |
| `GET /health` | ✅ 구현 완료 |
| `POST /api/v1/projects` | ✅ 구현 완료 (DEV user 시 project_members 자동 등록) |
| `GET /api/v1/projects` | ✅ 구현 완료 (DEV user 시 membership JOIN 필터) |
| `GET /api/v1/projects/{id}` | ✅ 구현 완료 |
| `POST /api/v1/projects/{id}/documents` | ✅ 구현 완료 (BackgroundTask async) |
| `GET /api/v1/projects/{id}/documents` | ✅ 구현 완료 |
| `GET /api/v1/projects/{id}/documents/{doc_id}/status` | ✅ 구현 완료 (last_error 포함) |
| `DELETE /api/v1/projects/{id}/documents/{doc_id}` | ✅ 구현 완료 (memory + chroma + file cleanup) |
| `POST /api/v1/projects/{id}/repositories` | ✅ 구현 완료 (async sync 시작) |
| `GET /api/v1/projects/{id}/repositories` | ✅ 구현 완료 |
| `GET /api/v1/projects/{id}/repositories/{repo_id}` | ✅ 구현 완료 (sync_warning 포함) |
| `POST .../repositories/{repo_id}/sync` | ✅ 구현 완료 (기존 index 삭제 후 재수집) |
| `GET .../repositories/{repo_id}/status` | ✅ 구현 완료 (last_error, sync_warning 포함) |
| `DELETE .../repositories/{repo_id}` | ✅ 구현 완료 (memory + chroma cleanup) |
| `GET /api/v1/projects/{id}/memory` | ✅ 구현 완료 (source_info 중첩 객체 포함) |
| `POST /api/v1/projects/{id}/memory` | ✅ 구현 완료 |
| `PATCH /api/v1/projects/{id}/memory/{memory_id}` | ✅ 구현 완료 |
| `DELETE /api/v1/projects/{id}/memory/{memory_id}` | ✅ 구현 완료 |
| `POST /api/v1/projects/{id}/query` | ✅ 구현 완료 |
| `POST /api/v1/projects/{id}/sessions` | ✅ 구현 완료 (require_project_access member) |
| `GET /api/v1/projects/{id}/sessions` | ✅ 구현 완료 (require_project_access viewer) |
| `PATCH /api/v1/projects/{id}/sessions/{sid}` | ✅ 구현 완료 |
| `DELETE /api/v1/projects/{id}/sessions/{sid}` | ✅ 구현 완료 (messages + summaries cascade) |
| `GET /api/v1/projects/{id}/sessions/{sid}/messages` | ✅ 구현 완료 (AES-256-GCM 복호화) |
| `POST /api/v1/projects/{id}/sessions/{sid}/query` | ✅ 구현 완료 (롤링 요약, 토큰 예산 관리) |

---

## 응답 필드 노트

### documents/{doc_id}/status 응답

`last_error` 필드가 추가됨. 처리 실패 시 오류 메시지 포함, 성공 시 null.

```json
{
  "doc_id": 12,
  "status": "failed",
  "last_error": "텍스트 추출 실패: 빈 파일",
  "extracted": { "decision": 0, "action": 0, "issue": 0, "risk": 0 }
}
```

### repositories/{repo_id}/status 응답

`last_error`, `sync_warning` 필드가 추가됨.

```json
{
  "repo_id": 3,
  "status": "indexed",
  "provider": "github",
  "repository_url": "https://github.com/org/repo",
  "branch": "main",
  "commit_sha": "abc123",
  "indexed_files": 3,
  "last_error": null,
  "sync_warning": "[{\"source_type\": \"issues\", \"reason\": \"GitHub API 응답 오류\"}]",
  "extracted": { "decision": 3, "action": 7, "issue": 4, "risk": 2 }
}
```

- `last_error`: 전체 실패 원인. 성공 시 null
- `sync_warning`: 부분 실패 목록 (JSON string). 일부 GitHub API 호출 실패 시 설정. 완전 성공 시 null. 새 sync 시작 시 초기화됨

### memory 응답 — 구조 (코드 기준 정정)

응답은 **배열** (`[ {...} ]`). `{ items: [] }` 래퍼 없음.

- `doc_id`, `repo_id`, `source`(문자열) — 최상위 필드
- `source_info` — 출처 상세 객체 (추가 제공, 무시 가능)

```json
[
  {
    "id": 1,
    "project_id": 1,
    "doc_id": 12,
    "repo_id": null,
    "source": "planning.pdf",
    "source_info": {
      "kind": "document",
      "doc_id": 12,
      "repo_id": null,
      "type": "meeting",
      "path": "planning.pdf",
      "ref": null,
      "url": null
    }
  }
]
```

- `source_info.kind`: `"document"` 또는 `"repository"`
- `source_info.ref`: repository 출처인 경우 commit SHA
- `source_info.url`: repository 출처인 경우 GitHub 파일 URL
- 출처 정보가 없으면 각 필드 `null`

---

## 상태 폴링 흐름

### 문서 처리

```
POST /documents → { "doc_id": N, "status": "processing" }
  → GET /documents/{N}/status 폴링
  → status: "processing" → 계속 대기
  → status: "indexed"    → 처리 완료
  → status: "failed"     → last_error 확인
```

### Repository sync

```
POST /repositories 또는 /repositories/{id}/sync → { "status": "syncing" }
  → GET /repositories/{id}/status 폴링
  → status: "syncing" → 계속 대기
  → status: "indexed" → 완료 (sync_warning 확인 권장)
  → status: "failed"  → last_error 확인
```

---

## 주의 사항

1. `sync_warning`은 JSON-encoded string (null 또는 `"[{...}]"`) — 프론트에서 파싱 필요
2. 서버 재시작 시 30분 이상 stale `processing`/`syncing` → 자동으로 `failed`로 전환 (`BACKGROUND_TASK_STALE_MINUTES` 설정)
3. 현재 인증은 `DEV_USER_ID` env 기반 fallback. 운영 도입 시 토큰 헤더 추가 예정
