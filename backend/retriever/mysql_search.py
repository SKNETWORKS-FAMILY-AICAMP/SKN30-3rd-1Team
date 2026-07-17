from typing import Optional, List, Dict
from ..db.mysql import get_connection


def search(
    project_id: int,
    category: Optional[str] = None,
    owner: Optional[str] = None,
    completed: Optional[bool] = None,
    due_within_days: Optional[int] = None,
    overdue: Optional[bool] = None,
    include_superseded: bool = False,
) -> List[Dict]:
    conditions = ["m.project_id = %s"]
    params: list = [project_id]

    # 번복된(superseded) 항목은 기본적으로 제외해 최신 상태만 조회한다.
    # "원래 계획은?" 류 이력 질문에서만 include_superseded=True로 체인을 포함한다.
    # (superseded_by는 계층 2 판별이 채우기 전까지 항상 NULL이라 그 전에는 무동작.)
    if not include_superseded:
        conditions.append("m.superseded_by IS NULL")

    if category:
        conditions.append("m.category = %s")
        params.append(category)
    if owner:
        conditions.append("m.owner = %s")
        params.append(owner)
    if completed is True:
        conditions.append("m.completed_at IS NOT NULL")
    elif completed is False:
        conditions.append("m.completed_at IS NULL")
    if overdue is True:
        conditions.append("m.due_date IS NOT NULL")
        conditions.append("m.due_date < CURDATE()")
        conditions.append("m.completed_at IS NULL")
    if due_within_days is not None:
        days = max(0, min(int(due_within_days), 365))
        conditions.append("m.due_date IS NOT NULL")
        conditions.append("m.due_date >= CURDATE()")
        conditions.append(f"m.due_date <= DATE_ADD(CURDATE(), INTERVAL {days} DAY)")

    where = " AND ".join(conditions)
    sql = (
        f"SELECT m.*,"
        f" ms.source_kind, ms.doc_id AS ms_doc_id, ms.repo_id AS ms_repo_id,"
        f" ms.source_type, ms.source_path, ms.source_ref, ms.source_url"
        f" FROM memory m"
        f" LEFT JOIN memory_sources ms ON ms.memory_id = m.id"
        f" WHERE {where}"
        f" ORDER BY (m.sort_order IS NULL), m.sort_order ASC, m.created_at DESC"
    )

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, params)
            rows = cursor.fetchall()
    finally:
        conn.close()

    result = []
    for row in rows:
        row["source_info"] = {
            "kind":    row.pop("source_kind", None),
            "doc_id":  row.pop("ms_doc_id", None),
            "repo_id": row.pop("ms_repo_id", None),
            "type":    row.pop("source_type", None),
            "path":    row.pop("source_path", None),
            "ref":     row.pop("source_ref", None),
            "url":     row.pop("source_url", None),
        }
        result.append(row)
    return result


def fetch_supersede_graph(project_id: int) -> List[Dict]:
    """supersede 관계에 참여하는 decision 행만 반환한다 (이력 체인 재구성용).

    search()는 LIMIT 없이 전 행 + memory_sources JOIN이라 이력 모드 전수 조회에
    부적합하다. 이 조회는 반환 행 수·전송량이 관계 참여 행 수에 비례한다
    (참여 행 = superseded_by가 채워진 행 + 다른 행이 가리키는 행).
    """
    sql = (
        "SELECT m.id, m.project_id, m.category, m.content, m.reason, m.topic,"
        " m.owner, m.date, m.due_date, m.completed_at, m.source,"
        " m.superseded_by, m.superseded_at"
        " FROM memory m"
        " WHERE m.project_id = %s AND m.category = 'decision'"
        " AND (m.superseded_by IS NOT NULL"
        "      OR m.id IN (SELECT s.superseded_by FROM memory s"
        "                  WHERE s.project_id = %s AND s.superseded_by IS NOT NULL))"
        " ORDER BY m.id ASC"
    )
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, [project_id, project_id])
            return cursor.fetchall()
    finally:
        conn.close()
