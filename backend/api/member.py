import logging

import pymysql
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db.mysql import get_connection
from .auth import get_current_user_id, get_project_role, require_project_access

router = APIRouter(prefix="/projects/{project_id}/members", tags=["members"])
logger = logging.getLogger(__name__)

# owner는 프로젝트 생성 시에만 부여 — API로 두 번째 owner를 만들거나 이관하는 것은 미지원
_ASSIGNABLE_ROLES = {"viewer", "member", "admin"}


class MemberAddRequest(BaseModel):
    email: str
    role: str = "member"


class MemberRoleUpdateRequest(BaseModel):
    role: str


def _validate_assignable_role(role: str) -> str:
    role = role.strip().lower()
    if role not in _ASSIGNABLE_ROLES:
        raise HTTPException(
            status_code=400,
            detail=f"role은 {sorted(_ASSIGNABLE_ROLES)} 중 하나여야 합니다.",
        )
    return role


@router.get("")
def list_members(project_id: int):
    require_project_access(project_id)
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT pm.user_id, u.email, u.name, pm.role, pm.created_at, pm.last_seen_at"
                " FROM project_members pm"
                " JOIN users u ON u.id = pm.user_id"
                " WHERE pm.project_id = %s"
                " ORDER BY FIELD(pm.role, 'owner', 'admin', 'member', 'viewer'), u.name",
                (project_id,),
            )
            return cursor.fetchall()
    finally:
        conn.close()


@router.post("", status_code=201)
def add_member(project_id: int, body: MemberAddRequest):
    require_project_access(project_id, min_role="owner")
    role = _validate_assignable_role(body.role)
    email = body.email.strip().lower()

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id, email, name FROM users WHERE email = %s", (email,))
            user_row = cursor.fetchone()
            if not user_row:
                raise HTTPException(status_code=404, detail="해당 이메일로 가입된 사용자가 없습니다.")
            try:
                cursor.execute(
                    "INSERT INTO project_members (project_id, user_id, role) VALUES (%s, %s, %s)",
                    (project_id, user_row["id"], role),
                )
            except pymysql.err.IntegrityError:
                raise HTTPException(status_code=409, detail="이미 이 프로젝트의 멤버입니다.")
        conn.commit()
    finally:
        conn.close()

    return {"user_id": user_row["id"], "email": user_row["email"], "name": user_row["name"], "role": role}


@router.patch("/{member_user_id}")
def update_member_role(project_id: int, member_user_id: int, body: MemberRoleUpdateRequest):
    require_project_access(project_id, min_role="owner")
    role = _validate_assignable_role(body.role)

    current_user_id = get_current_user_id()
    if member_user_id == current_user_id:
        raise HTTPException(status_code=400, detail="자신의 역할은 변경할 수 없습니다.")

    target_role = get_project_role(project_id, member_user_id)
    if target_role is None:
        raise HTTPException(status_code=404, detail="이 프로젝트의 멤버가 아닙니다.")
    if target_role == "owner":
        raise HTTPException(status_code=403, detail="owner의 역할은 변경할 수 없습니다.")

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "UPDATE project_members SET role = %s WHERE project_id = %s AND user_id = %s",
                (role, project_id, member_user_id),
            )
        conn.commit()
    finally:
        conn.close()

    return {"user_id": member_user_id, "role": role}


@router.delete("/{member_user_id}", status_code=204)
def remove_member(project_id: int, member_user_id: int):
    """멤버 제외. owner는 다른 멤버를 제외할 수 있고,
    owner가 아닌 멤버는 자기 자신만 제외(프로젝트 탈퇴)할 수 있다."""
    require_project_access(project_id, min_role="member")
    current_user_id = get_current_user_id()
    current_role = get_project_role(project_id, current_user_id)

    if member_user_id == current_user_id:
        if current_role == "owner":
            raise HTTPException(
                status_code=400,
                detail="owner는 프로젝트를 탈퇴할 수 없습니다. 프로젝트 삭제를 이용하세요.",
            )
    elif current_role != "owner":
        raise HTTPException(status_code=403, detail="다른 멤버를 제외하려면 owner 권한이 필요합니다.")

    target_role = get_project_role(project_id, member_user_id)
    if target_role is None:
        raise HTTPException(status_code=404, detail="이 프로젝트의 멤버가 아닙니다.")
    if target_role == "owner" and member_user_id != current_user_id:
        raise HTTPException(status_code=403, detail="owner는 제외할 수 없습니다.")

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "DELETE FROM project_members WHERE project_id = %s AND user_id = %s",
                (project_id, member_user_id),
            )
        conn.commit()
    finally:
        conn.close()
