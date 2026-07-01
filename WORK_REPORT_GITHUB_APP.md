# GitHub App 연동 작업 보고서

## 작업 브랜치
- `codex/github-app-integration`

## 작업 위치
- `backend/github/`
  - GitHub App 설치 세션, callback, installation token, repo preview API 추가
- `backend/main.py`
  - GitHub 라우터 등록
  - desktop/FastAPI 연결용 CORS 설정 추가
- `.env.example`
  - GitHub App 설정값과 CORS origin 예시 추가
- `desktop/src/App.tsx`
  - GitHub 로그인, 설치 확인, repo URL 연결, repo 목록, 연결 해제 UI 구현
  - public repo는 기존 익명 API로 유지
  - private repo는 GitHub App 로그인 세션으로 backend를 통해 연결
- `desktop/src/styles.css`
  - GitHub 섹션을 로그인/연결/목록/timeline 구조로 정리
- `desktop/scripts/layout-smoke.mjs`
  - 새 GitHub 섹션 UX 기준 smoke test 갱신
- `tests/test_github_app.py`
  - GitHub App 세션/callback, repo URL parsing, CORS 검증 추가
- `pyproject.toml`, `uv.lock`
  - `cryptography` 직접 의존성 추가

## 검증
- `npm run build`
- `npm run test:layout`
- `uv run pytest`
- `cargo test`

## 남은 서버 설정
- `.env`의 `GITHUB_APP_SLUG`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`는 사용자가 입력하는 값이 아님
- 위 값들은 PaiM 서버 운영자가 GitHub App을 만들고 AWS/서버 환경변수로 한 번만 설정
- 사용자는 데스크톱 앱에서 `GitHub 로그인`을 누른 뒤 GitHub 화면에서 repo 접근을 승인
