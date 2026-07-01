import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .api.project import router as project_router
from .api.upload import router as upload_router
from .api.query import router as query_router
from .github.router import router as github_router

app = FastAPI(title="PaiM API", version="0.1.0")

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

app.include_router(project_router)
app.include_router(upload_router)
app.include_router(query_router)
app.include_router(github_router)


@app.get("/")
def root():
    return {"service": "PaiM", "status": "ok"}


def serve():
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
