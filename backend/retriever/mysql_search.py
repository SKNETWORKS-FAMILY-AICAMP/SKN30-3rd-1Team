from typing import Optional, List, Dict
from ..db.mysql import get_connection


def search(
    project_id: int,
    category: Optional[str] = None,
    owner: Optional[str] = None,
) -> List[Dict]:
    conditions = ["project_id = %s"]
    params: list = [project_id]

    if category:
        conditions.append("category = %s")
        params.append(category)
    if owner:
        conditions.append("owner = %s")
        params.append(owner)

    where = " AND ".join(conditions)
    sql = f"SELECT * FROM memory WHERE {where} ORDER BY created_at DESC"

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, params)
            return cursor.fetchall()
    finally:
        conn.close()
