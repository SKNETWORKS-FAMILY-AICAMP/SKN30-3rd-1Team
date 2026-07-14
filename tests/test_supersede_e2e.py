"""R-004 통합: supersede accept → 계층1 search 제외까지 end-to-end 계약 검증.

accept 경로(api/suggestion.py)와 조회 경로(retriever/mysql_search.py)가 서로 다른 SQL을
쓰지만 같은 memory.superseded_by 컬럼을 통해 연결된다. 공유 인메모리 저장소를 두 경로에
물려, accept가 superseded_by를 채우면 계층1 기본 조회가 그 decision을 실제로 제외함을 확인한다.
"""
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import app
from backend.retriever import mysql_search

_client = TestClient(app, raise_server_exceptions=False)


class _FakeDB:
    """memory + memory_suggestions를 담는 최소 공유 저장소."""

    def __init__(self):
        self.memory = {
            10: {"id": 10, "project_id": 1, "category": "decision", "content": "매주 수요일 배포",
                 "superseded_by": None, "superseded_at": None, "completed_at": None,
                 "owner": None, "due_date": None, "sort_order": None, "created_at": "2026-07-01"},
            42: {"id": 42, "project_id": 1, "category": "decision", "content": "이제 매주 금요일 배포",
                 "superseded_by": None, "superseded_at": None, "completed_at": None,
                 "owner": None, "due_date": None, "sort_order": None, "created_at": "2026-07-02"},
        }
        self.suggestion = {
            8: {"id": 8, "project_id": 1, "memory_id": 10, "kind": "supersede",
                "evidence": '{"type":"supersede","superseding_memory_id":42}',
                "rationale": "새 결정이 기존 배포 방침을 대체합니다.", "confidence": "high",
                "status": "pending", "created_at": "2026-07-02 10:00:00",
                "resolved_at": None, "resolved_by": None},
        }


class _Cursor:
    def __init__(self, db):
        self.db = db
        self._one = None
        self._all = []

    def execute(self, sql, params=None):
        params = params or []
        if "FROM memory_suggestions s" in sql and "JOIN memory m" in sql:
            sid = params[0]
            s = self.db.suggestion.get(sid)
            if not s:
                self._one = None
                return
            m = self.db.memory[s["memory_id"]]
            self._one = {**s,
                         "memory_category": m["category"],
                         "memory_completed_at": m["completed_at"],
                         "memory_superseded_by": m["superseded_by"]}
        elif "UPDATE memory SET superseded_by" in sql:
            superseding_id, memory_id, _pid = params
            self.db.memory[memory_id]["superseded_by"] = superseding_id
            self.db.memory[memory_id]["superseded_at"] = "2026-07-02 11:00:00"
        elif "UPDATE memory_suggestions SET status" in sql:
            status, resolved_by, sid, _pid = params
            self.db.suggestion[sid].update(status=status, resolved_by=resolved_by,
                                           resolved_at="2026-07-02 11:00:00")
        elif "SELECT * FROM memory_suggestions WHERE id" in sql:
            self._one = dict(self.db.suggestion[params[0]])
        elif "FROM memory m" in sql and "LEFT JOIN memory_sources" in sql:
            active_only = "m.superseded_by IS NULL" in sql
            want_category = params[1] if "m.category = %s" in sql else None
            rows = []
            for m in self.db.memory.values():
                if m["project_id"] != params[0]:
                    continue
                if active_only and m["superseded_by"] is not None:
                    continue
                if want_category is not None and m["category"] != want_category:
                    continue
                rows.append(dict(m))
            self._all = rows
        else:
            self._one, self._all = None, []

    def fetchone(self):
        return self._one

    def fetchall(self):
        return self._all

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Conn:
    def __init__(self, db):
        self.db = db

    def cursor(self):
        return _Cursor(self.db)

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


def _search_ids(project_id=1, **kwargs):
    return [r["id"] for r in mysql_search.search(project_id, category="decision", **kwargs)]


def test_accept_supersede_then_layer1_search_excludes_old_decision():
    """accept가 superseded_by를 채우면 계층1 기본 조회에서 구 decision이 빠지고,
    include_superseded=True면 다시 포함된다."""
    db = _FakeDB()

    with patch("backend.retriever.mysql_search.get_connection", return_value=_Conn(db)):
        # accept 전: 두 decision 모두 조회됨
        assert sorted(_search_ids()) == [10, 42]

    with patch("backend.api.suggestion.require_project_access"), \
         patch("backend.api.suggestion.get_current_user_id", return_value=99), \
         patch("backend.api.suggestion.get_connection", return_value=_Conn(db)):
        resp = _client.post("/api/v1/projects/1/suggestions/8/accept")
    assert resp.status_code == 200
    assert resp.json()["status"] == "accepted"
    assert db.memory[10]["superseded_by"] == 42  # accept가 계층1 컬럼을 채움

    with patch("backend.retriever.mysql_search.get_connection", return_value=_Conn(db)):
        # accept 후: 구 decision(10)은 기본 조회에서 제외
        assert _search_ids() == [42]
        # 이력 조회(include_superseded=True)에서는 다시 포함
        assert sorted(_search_ids(include_superseded=True)) == [10, 42]
