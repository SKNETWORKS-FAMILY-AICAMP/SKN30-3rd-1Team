import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from .api.auth import auth_middleware
from .api.auth_routes import router as auth_router
from .api.member import router as member_router
from .api.project import router as project_router
from .api.upload import router as upload_router
from .api.query import router as query_router
from .api.repository import router as repository_router
from .api.suggestion import router as suggestion_router
from .api.delta import router as delta_router
from .chat.router import router as chat_router
from .github.router import router as github_router, SessionExpiredException


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    import logging
    from .api.auth import _auth_mode
    from .startup import recover_stale_tasks, backfill_dev_user_membership, stale_watchdog
    from .retriever.memory_vector import backfill_memory_vectors
    if _auth_mode() == "dev":
        logging.getLogger(__name__).warning(
            "PAIM_AUTH_MODE=dev — JWT 검증이 꺼져 있습니다. 로컬 개발 전용이며 배포 환경에서는 사용 금지."
        )
    recover_stale_tasks()
    backfill_dev_user_membership()
    try:
        backfill_memory_vectors()
    except Exception:
        logging.getLogger(__name__).warning("memory vector backfill failed", exc_info=True)
    watchdog_task = asyncio.create_task(stale_watchdog())
    yield
    watchdog_task.cancel()


app = FastAPI(title="PaiM API", version="0.2.0", lifespan=lifespan)

# JWT 인증 미들웨어. CORS보다 먼저 등록해야 CORSMiddleware가 바깥에 위치해
# 401 응답에도 CORS 헤더가 붙는다 (add_middleware는 나중에 등록한 것이 바깥).
app.middleware("http")(auth_middleware)

cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://127.0.0.1:1420,http://localhost:1420,tauri://localhost,http://tauri.localhost",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(SessionExpiredException)
async def session_expired_handler(request: Request, exc: SessionExpiredException):
    return JSONResponse(
        status_code=410,
        content={"detail": "session expired", "code": "SESSION_EXPIRED"},
    )


app.include_router(auth_router,       prefix="/api/v1")
app.include_router(member_router,     prefix="/api/v1")
app.include_router(project_router,    prefix="/api/v1")
app.include_router(upload_router,     prefix="/api/v1")
app.include_router(query_router,      prefix="/api/v1")
app.include_router(repository_router, prefix="/api/v1")
app.include_router(suggestion_router, prefix="/api/v1")
app.include_router(delta_router,      prefix="/api/v1")
app.include_router(chat_router,    prefix="/api/v1")
# github_router는 자체 prefix(/github/app)를 사용하므로 /api/v1 붙이지 않음
app.include_router(github_router)


@app.get("/")
def root():
    return {"service": "PaiM", "status": "ok"}


@app.get("/health")
def health():
    return {"status": "ok"}


def serve():
    import uvicorn
    # 로컬 데스크톱 전용 백엔드 — LAN 노출을 막기 위해 127.0.0.1에만 바인딩한다.
    # reload는 파일 감시용 개발 옵션. 굳힌 sidecar 실행파일에서는 서브프로세스를 못 띄워
    # 오작동하므로, 개발 중에만 PAIM_DEV_RELOAD=1로 켠다.
    uvicorn.run(
        "backend.main:app",
        host="127.0.0.1",
        port=8000,
        reload=os.getenv("PAIM_DEV_RELOAD") == "1",
    )
