#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

API_URL="http://127.0.0.1:8000/health"
BACKEND_PID=""
COMPOSE=()

finish() {
  if [[ -n "$BACKEND_PID" ]]; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}

fail() {
  echo
  echo "[오류] $*" >&2
  read -r -p "Enter를 눌러 종료하세요..." _
  exit 1
}

trap finish EXIT

echo "=========================================="
echo " PaiM 원클릭 실행 스크립트 (macOS)"
echo "=========================================="
echo

command -v uv >/dev/null 2>&1 || fail "uv가 설치되어 있지 않습니다: curl -LsSf https://astral.sh/uv/install.sh | sh"
command -v docker >/dev/null 2>&1 || fail "docker 명령을 찾을 수 없습니다. Homebrew라면 brew install docker colima 를 실행하세요."
command -v openssl >/dev/null 2>&1 || fail "openssl을 찾을 수 없습니다."

if ! docker info >/dev/null 2>&1; then
  if command -v colima >/dev/null 2>&1; then
    echo "[1/5] Docker 데몬이 실행 중이 아닙니다. Colima를 시작합니다..."
    colima start || fail "Colima 시작 실패. colima start 오류를 확인하세요."
  elif [[ -d "/Applications/Docker.app" || -d "$HOME/Applications/Docker.app" ]]; then
    echo "[1/5] Docker가 실행 중이 아닙니다. Docker Desktop을 시작합니다..."
    open -a Docker || fail "Docker Desktop을 직접 실행한 뒤 다시 시도하세요."
  else
    fail "Docker 데몬이 실행 중이 아닙니다. Homebrew라면 brew install colima && colima start 후 다시 실행하세요."
  fi

  for _ in {1..40}; do
    sleep 3
    docker info >/dev/null 2>&1 && break
  done
fi

docker info >/dev/null 2>&1 || fail "Docker 데몬이 2분 안에 시작되지 않았습니다. colima status 또는 Docker Desktop 상태를 확인하세요."
echo "[1/5] Docker 확인 완료"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  fail "Docker Compose가 없습니다. Homebrew라면 brew install docker-compose 후 다시 실행하세요."
fi

if [[ ! -f .env ]]; then
  echo "[2/5] .env가 없어 .env.example에서 새로 생성합니다..."
  cp .env.example .env
  SESSION_KEY="$(openssl rand -base64 32)"
  SESSION_KEY="$SESSION_KEY" perl -0pi -e 's/your_base64_encoded_32byte_key/$ENV{SESSION_KEY}/g' .env

  echo
  echo "TextEdit에서 .env가 열립니다. LLM_PROVIDER/API 키와 DB_PASSWORD를 입력하고 저장하세요."
  open -e .env
  read -r -p "저장 후 Enter를 누르면 계속합니다..."
fi

if grep -q "your_db_password" .env; then
  echo "[경고] .env의 DB_PASSWORD가 아직 placeholder입니다. 그대로 진행은 되지만 변경을 권장합니다."
fi
echo "[2/5] .env 확인 완료"

echo "[3/5] MySQL 컨테이너 시작..."
"${COMPOSE[@]}" up -d || fail "docker compose up 실패. 위 메시지를 확인하세요."

DB_CID="$("${COMPOSE[@]}" ps -q db)"
[[ -n "$DB_CID" ]] || fail "MySQL 컨테이너를 찾을 수 없습니다."

echo "       MySQL 준비 대기 중 (최초 실행 시 1~2분 걸릴 수 있음)..."
DB_STATUS=""
for _ in {1..60}; do
  DB_STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$DB_CID" 2>/dev/null || true)"
  [[ "$DB_STATUS" == "healthy" ]] && break
  sleep 3
done

[[ "$DB_STATUS" == "healthy" ]] || fail "MySQL이 3분 안에 준비되지 않았습니다. ${COMPOSE[*]} logs db 로 확인하세요."
echo "[3/5] MySQL 준비 완료"

if curl -fsS --max-time 2 "$API_URL" >/dev/null 2>&1; then
  echo "[4/5] 백엔드가 이미 실행 중입니다. 그대로 사용합니다."
else
  echo "[4/5] 의존성 동기화 (uv sync)..."
  uv sync || fail "uv sync 실패. 위 메시지를 확인하세요."

  echo "       백엔드 서버를 시작합니다. 이 창은 앱을 쓰는 동안 닫지 마세요."
  uv run paim-server &
  BACKEND_PID="$!"

  for _ in {1..45}; do
    sleep 2
    curl -fsS --max-time 2 "$API_URL" >/dev/null 2>&1 && break
  done

  curl -fsS --max-time 2 "$API_URL" >/dev/null 2>&1 || fail "백엔드가 90초 안에 응답하지 않습니다. 위 오류 메시지를 확인하세요."
fi
echo "[4/5] 백엔드 응답 확인 ($API_URL)"

PAIM_APP=""
for candidate in \
  "/Applications/PaiM.app" \
  "$HOME/Applications/PaiM.app" \
  "$PWD/desktop/src-tauri/target/release/bundle/macos/PaiM.app"
do
  if [[ -d "$candidate" ]]; then
    PAIM_APP="$candidate"
    break
  fi
done

if [[ -n "$PAIM_APP" ]]; then
  echo "[5/5] PaiM 앱 실행: $PAIM_APP"
  open -n "$PAIM_APP"
else
  echo "[5/5] PaiM 앱 설치 경로를 찾지 못했습니다."
  echo "       개발 실행은 다른 터미널에서 실행하세요: npm run demo --prefix desktop"
fi

echo
echo "=========================================="
echo " 완료! 이 창은 백엔드용입니다."
echo " 종료하려면 앱을 닫고 이 창에서 Ctrl-C를 누르세요."
echo "=========================================="

if [[ -n "$BACKEND_PID" ]]; then
  wait "$BACKEND_PID"
else
  read -r -p "Enter를 누르면 창을 닫습니다..."
fi
