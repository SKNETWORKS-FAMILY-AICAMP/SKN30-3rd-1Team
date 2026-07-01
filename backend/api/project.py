from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..db.mysql import get_connection
from .auth import get_current_user_id, ensure_dev_user, require_project_access

router = APIRouter()


class ProjectCreate(BaseModel):
    name: str


@router.post("/projects", status_code=201)
def create_project(body: ProjectCreate):
    user_id = ensure_dev_user()
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "INSERT INTO projects (name, owner_user_id) VALUES (%s, %s)",
                (body.name, user_id),
            )
            project_id = cursor.lastrowid
            if user_id:
                # DEV_USER_ID 미설정(auth 없는 MVP 모드)이면 project_members 행 생략
                cursor.execute(
                    "INSERT INTO project_members (project_id, user_id, role) VALUES (%s, %s, 'owner')",
                    (project_id, user_id),
                )
        conn.commit()
        with conn.cursor() as cursor:
            cursor.execute("SELECT id, name, created_at FROM projects WHERE id = %s", (project_id,))
            return cursor.fetchone()
    finally:
        conn.close()


@router.get("/projects")
def list_projects():
    user_id = get_current_user_id()
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            if user_id is not None:
                # 인증 있음: 본인이 멤버로 등록된 프로젝트만 반환
                cursor.execute(
                    "SELECT p.* FROM projects p"
                    " JOIN project_members pm ON pm.project_id = p.id"
                    " WHERE pm.user_id = %s"
                    " ORDER BY p.created_at DESC",
                    (user_id,),
                )
            else:
                # 인증 없음(DEV 미설정): 전체 프로젝트 반환
                cursor.execute("SELECT * FROM projects ORDER BY created_at DESC")
            return cursor.fetchall()
    finally:
        conn.close()


@router.get("/projects/{project_id}")
def get_project(project_id: int):
    require_project_access(project_id)
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
