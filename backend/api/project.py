from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..db.mysql import get_connection

router = APIRouter()


class ProjectCreate(BaseModel):
    name: str


@router.post("/projects", status_code=201)
def create_project(body: ProjectCreate):
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("INSERT INTO projects (name) VALUES (%s)", (body.name,))
            project_id = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()
    return {"id": project_id, "name": body.name}


@router.get("/projects")
def list_projects():
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT * FROM projects ORDER BY created_at DESC")
            return cursor.fetchall()
    finally:
        conn.close()


@router.get("/projects/{project_id}")
def get_project(project_id: int):
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT * FROM projects WHERE id = %s", (project_id,))
            row = cursor.fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return row
