import base64
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from backend.main import app

_client = TestClient(app, raise_server_exceptions=False)


def _project_conn():
    conn = MagicMock()
    cur = conn.cursor.return_value.__enter__.return_value
    cur.fetchone.return_value = {"id": 1}
    return conn


def test_query_attachment_goes_to_temporary_context_not_router():
    """첨부가 있으면 라우터를 우회하고 run_qa 임시 컨텍스트로만 전달한다."""
    encoded = base64.b64encode("첨부 전용 사실: 릴리즈명은 Bluefin".encode()).decode()

    def fake_run_qa(**kwargs):
        assert kwargs["attachment_sources"] == ["note.txt"]
        assert "[첨부 자료]" in kwargs["attachment_context"]
        assert "릴리즈명은 Bluefin" in kwargs["attachment_context"]
        return {"answer": "Bluefin", "sources": kwargs["attachment_sources"], "debug": {}}

    with patch("backend.api.query.require_project_access"), \
         patch("backend.api.query.get_connection", return_value=_project_conn()), \
         patch("backend.api.query.classify_question", side_effect=AssertionError("router called")), \
         patch("backend.api.query.run_qa", side_effect=fake_run_qa):
        resp = _client.post(
            "/api/v1/projects/1/query",
            json={
                "question": "릴리즈명이 뭐야?",
                "attachments": [{"filename": "note.txt", "content_base64": encoded}],
            },
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["answer"] == "Bluefin"
    assert body["sources"] == ["note.txt"]
    assert body["route"] == "semantic"
    assert body["debug"]["router_stage"] == "attachment"


def test_query_attachment_context_marks_truncation(monkeypatch):
    """첨부 텍스트 상한 초과 시 앞부분만 넣고 잘림 표시를 남긴다."""
    from backend.api import query as query_api

    monkeypatch.setattr(query_api, "_ATTACHMENT_MAX_CHARS_PER_FILE", 5)
    monkeypatch.setattr(query_api, "_ATTACHMENT_MAX_CHARS_TOTAL", 20)

    encoded = base64.b64encode("1234567890".encode()).decode()
    context, sources = query_api._prepare_attachment_context([
        query_api.QueryAttachment(filename="long.md", content_base64=encoded)
    ])

    assert sources == ["long.md"]
    assert "12345" in context
    assert "첨부 내용 잘림" in context
