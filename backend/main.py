from fastapi import FastAPI
from .api.project import router as project_router
from .api.upload import router as upload_router
from .api.query import router as query_router
from .chat.router import router as chat_router

app = FastAPI(title="PaiM API", version="0.1.0")

app.include_router(project_router)
app.include_router(upload_router)
app.include_router(query_router)
app.include_router(chat_router)


@app.get("/")
def root():
    return {"service": "PaiM", "status": "ok"}


def serve():
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
