import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .api.project import router as project_router
from .api.upload import router as upload_router
from .api.query import router as query_router
from .api.repository import router as repository_router
from .chat.router import router as chat_router
from .github.router import router as github_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .startup import recover_stale_tasks, backfill_dev_user_membership
    recover_stale_tasks()
    backfill_dev_user_membership()
    yield


app = FastAPI(title="PaiM API", version="0.2.0", lifespan=lifespan)

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

app.include_router(project_router,    prefix="/api/v1")
app.include_router(upload_router,     prefix="/api/v1")
app.include_router(query_router,      prefix="/api/v1")
app.include_router(repository_router, prefix="/api/v1")
app.include_router(chat_router)   # /projects/{project_id}/sessions 자체 prefix 보존
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
