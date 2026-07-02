"""PR→action Reconciler 단위 테스트."""
import pathlib

from backend.reconciler import pr_actions


class _StructuredLLM:
    def __init__(self):
        self.schema = None
        self.messages = None

    def with_structured_output(self, schema):
        self.schema = schema
        return self

    def invoke(self, messages):
        self.messages = messages
        return {
            "matches": [
                {
                    "memory_id": 10,
                    "pr_number": 20,
                    "rationale": "PR #20이 데스크톱 앱과 FastAPI 백엔드 연동을 명시적으로 구현했습니다.",
                    "confidence": "high",
                }
            ]
        }


def test_reconciler_uses_structured_output(monkeypatch):
    """run_reconciler() — Pydantic structured output으로 매칭 결과를 받는다."""
    llm = _StructuredLLM()
    pr_actions._app = None
    monkeypatch.setattr(pr_actions, "get_chat_model", lambda: llm)

    result = pr_actions.run_reconciler(
        1,
        [
            {
                "number": 20,
                "title": "데스크탑 앱 FastAPI 연동",
                "body_summary": "FastAPI 백엔드 API 연결",
                "url": "https://github.com/o/r/pull/20",
                "merged_at": "2026-07-01T10:00:00Z",
            }
        ],
        [{"id": 10, "content": "데스크탑 앱을 FastAPI 백엔드와 연동한다"}],
    )

    assert llm.schema is pr_actions.ReconcileResult
    assert result.matches[0].memory_id == 10
    assert "매칭이 없으면 빈 배열" in llm.messages[0].content


def test_migrate_v5_declares_suggestions_and_watermark():
    """migrate_v5.sql — suggestion 테이블과 PR 워터마크 컬럼을 생성한다."""
    sql = pathlib.Path("backend/db/migrate_v5.sql").read_text()
    assert "memory_suggestions" in sql
    assert "last_reconciled_pr" in sql
    assert "evidence    JSON" in sql
