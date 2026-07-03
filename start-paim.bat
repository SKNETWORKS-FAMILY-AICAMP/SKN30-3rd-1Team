@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==========================================
echo  PaiM 원클릭 실행 스크립트 (Windows)
echo ==========================================
echo.

REM ---------- 1. 필수 도구 확인 ----------
where uv >nul 2>nul
if errorlevel 1 (
    echo [오류] uv가 설치되어 있지 않습니다.
    echo        PowerShell에서 다음을 실행하세요:
    echo        powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 ^| iex"
    pause
    exit /b 1
)

where docker >nul 2>nul
if errorlevel 1 (
    echo [오류] docker 명령을 찾을 수 없습니다. Docker Desktop을 설치하세요.
    pause
    exit /b 1
)

REM ---------- 2. Docker 데몬 확인 (꺼져 있으면 Docker Desktop 실행) ----------
docker info >nul 2>nul
if not errorlevel 1 goto docker_ok

echo [1/5] Docker가 실행 중이 아닙니다. Docker Desktop을 시작합니다...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
    start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
) else (
    echo [오류] Docker Desktop 실행 파일을 찾을 수 없습니다. 직접 실행한 뒤 이 스크립트를 다시 실행하세요.
    pause
    exit /b 1
)

set /a DOCKER_TRIES=0
:wait_docker
timeout /t 3 /nobreak >nul
docker info >nul 2>nul
if not errorlevel 1 goto docker_ok
set /a DOCKER_TRIES+=1
if !DOCKER_TRIES! geq 40 (
    echo [오류] Docker가 2분 안에 시작되지 않았습니다. Docker Desktop 상태를 확인하세요.
    pause
    exit /b 1
)
goto wait_docker

:docker_ok
echo [1/5] Docker 확인 완료

REM ---------- 3. .env 준비 ----------
if exist .env goto env_ok

echo [2/5] .env가 없어 .env.example에서 새로 생성합니다...
copy .env.example .env >nul

REM SESSION_MEMORY_KEY 자동 생성 (AES-256 키, base64 32바이트)
powershell -NoProfile -Command "$rng=[Security.Cryptography.RandomNumberGenerator]::Create(); $b=New-Object byte[] 32; $rng.GetBytes($b); $k=[Convert]::ToBase64String($b); (Get-Content .env -Raw) -replace 'your_base64_encoded_32byte_key', $k | Set-Content .env -NoNewline -Encoding utf8"

echo.
echo  ┌────────────────────────────────────────────────────┐
echo  │ 메모장이 열립니다. 아래 항목을 입력하고 저장하세요  │
echo  │   - LLM_PROVIDER 및 해당 API 키                    │
echo  │   - DB_PASSWORD (원하는 값 아무거나)               │
echo  │ 저장 후 메모장을 닫으면 계속 진행됩니다            │
echo  └────────────────────────────────────────────────────┘
echo.
notepad .env

:env_ok
findstr /c:"your_db_password" .env >nul 2>nul
if not errorlevel 1 (
    echo [경고] .env의 DB_PASSWORD가 아직 placeholder입니다. 그대로 진행은 되지만 변경을 권장합니다.
)
echo [2/5] .env 확인 완료

REM ---------- 4. MySQL 컨테이너 시작 + 준비 대기 ----------
echo [3/5] MySQL 컨테이너 시작...
docker compose up -d
if errorlevel 1 (
    echo [오류] docker compose up 실패. 위 메시지를 확인하세요.
    pause
    exit /b 1
)

set DB_CID=
for /f %%i in ('docker compose ps -q db') do set DB_CID=%%i
if "!DB_CID!"=="" (
    echo [오류] MySQL 컨테이너를 찾을 수 없습니다.
    pause
    exit /b 1
)

echo        MySQL 준비 대기 중 (최초 실행 시 1~2분 걸릴 수 있음)...
set /a DB_TRIES=0
:wait_db
set DB_STATUS=
for /f %%s in ('docker inspect -f "{{.State.Health.Status}}" !DB_CID!') do set DB_STATUS=%%s
if "!DB_STATUS!"=="healthy" goto db_ok
set /a DB_TRIES+=1
if !DB_TRIES! geq 60 (
    echo [오류] MySQL이 3분 안에 준비되지 않았습니다. docker compose logs db 로 확인하세요.
    pause
    exit /b 1
)
timeout /t 3 /nobreak >nul
goto wait_db

:db_ok
echo [3/5] MySQL 준비 완료

REM ---------- 5. 백엔드 실행 ----------
curl -s -o nul --max-time 2 http://127.0.0.1:8000/health
if not errorlevel 1 (
    echo [4/5] 백엔드가 이미 실행 중입니다. 그대로 사용합니다.
    goto backend_ok
)

echo [4/5] 의존성 동기화 (uv sync)...
uv sync
if errorlevel 1 (
    echo [오류] uv sync 실패. 위 메시지를 확인하세요.
    pause
    exit /b 1
)

echo        백엔드 서버를 새 창에서 시작합니다 (앱 사용 중에는 닫지 마세요)...
start "PaiM Backend" cmd /k "chcp 65001 >nul && uv run paim-server"

set /a API_TRIES=0
:wait_api
timeout /t 2 /nobreak >nul
curl -s -o nul --max-time 2 http://127.0.0.1:8000/health
if not errorlevel 1 goto backend_ok
set /a API_TRIES+=1
if !API_TRIES! geq 45 (
    echo [오류] 백엔드가 90초 안에 응답하지 않습니다. "PaiM Backend" 창의 오류 메시지를 확인하세요.
    pause
    exit /b 1
)
goto wait_api

:backend_ok
echo [4/5] 백엔드 응답 확인 (http://127.0.0.1:8000)

REM ---------- 6. PaiM 앱 실행 ----------
set PAIM_EXE=
if exist "%LOCALAPPDATA%\PaiM\PaiM.exe" set "PAIM_EXE=%LOCALAPPDATA%\PaiM\PaiM.exe"
if exist "%ProgramFiles%\PaiM\PaiM.exe" set "PAIM_EXE=%ProgramFiles%\PaiM\PaiM.exe"

if "!PAIM_EXE!"=="" (
    echo [5/5] PaiM 앱 설치 경로를 찾지 못했습니다. 시작 메뉴에서 PaiM을 직접 실행하세요.
) else (
    echo [5/5] PaiM 앱 실행: !PAIM_EXE!
    start "" "!PAIM_EXE!"
)

echo.
echo ==========================================
echo  완료! 백엔드 창("PaiM Backend")은 앱을 쓰는 동안 켜두세요.
echo  종료하려면: 앱 닫기 → 백엔드 창 닫기 → docker compose down (선택)
echo ==========================================
pause
