"""ingest() → supersede 판별기(계층2) best-effort 훅 테스트."""
import pytest
from unittest.mock import MagicMock, patch

from backend.pipeline.ingestor import ingest
from backend.pipeline.models import MemoryItem


def _make_conn(lastrowid=10):
    cursor = MagicMock()
    cursor.lastrowid = lastrowid
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    conn.cursor.return_value.__exit__.return_value = False
    return conn, cursor


def _item(category, content):
    return MemoryItem(category=category, content=content, reason="", topic="", owner="", date="")


def test_ingest_calls_supersede_with_new_decisions_only():
    """신규 decision만 detect_supersede로 넘긴다(action 등은 제외)."""
    items = [_item("decision", "이제 매주 금요일 배포한다"), _item("action", "배포 스크립트 수정")]
    conn, _ = _make_conn()
    with patch("backend.pipeline.ingestor.get_connection", return_value=conn), \
         patch("backend.pipeline.ingestor.upsert_memory_vectors"), \
         patch("backend.pipeline.ingestor.get_collection") as mock_coll, \
         patch("backend.reconciler.supersede.detect_supersede") as mock_detect:
        mock_coll.return_value.add = MagicMock()
        ingest(project_id=1, doc_id=5, repo_id=None, items=items,
               raw_text="", source="m.md", date="", doc_type="meeting")

    mock_detect.assert_called_once()
    project_id_arg, new_decisions = mock_detect.call_args.args
    assert project_id_arg == 1
    assert len(new_decisions) == 1
    assert new_decisions[0]["content"] == "이제 매주 금요일 배포한다"


def test_ingest_passes_decision_date_to_supersede():
    """D-3: 시간 순서 검증을 위해 신규 decision의 정규화된 date를 함께 넘긴다."""
    items = [_item("decision", "2024년 방침")]
    items[0].date = "2024-01-05"
    conn, _ = _make_conn()
    with patch("backend.pipeline.ingestor.get_connection", return_value=conn), \
         patch("backend.pipeline.ingestor.upsert_memory_vectors"), \
         patch("backend.pipeline.ingestor.get_collection") as mock_coll, \
         patch("backend.reconciler.supersede.detect_supersede") as mock_detect:
        mock_coll.return_value.add = MagicMock()
        ingest(project_id=1, doc_id=5, repo_id=None, items=items,
               raw_text="", source="m.md", date="", doc_type="meeting")

    _pid, new_decisions = mock_detect.call_args.args
    assert new_decisions[0]["date"] == "2024-01-05"


def test_ingest_skips_supersede_when_chunk_add_fails():
    """D-2: chunk add가 실패하면 supersede 판별(제안 생성)을 실행하지 않는다.
    적재가 롤백/정리될 때 삭제될 신규 memory를 가리키는 제안이 남지 않도록 훅은 맨 마지막에 있다."""
    items = [_item("decision", "새 결정")]
    conn, _ = _make_conn()
    with patch("backend.pipeline.ingestor.get_connection", return_value=conn), \
         patch("backend.pipeline.ingestor.upsert_memory_vectors"), \
         patch("backend.pipeline.ingestor.get_collection") as mock_coll, \
         patch("backend.reconciler.supersede.detect_supersede") as mock_detect:
        mock_coll.return_value.add.side_effect = RuntimeError("embedding down")
        with pytest.raises(RuntimeError):
            ingest(project_id=1, doc_id=5, repo_id=None, items=items,
                   raw_text="회의에서 새 결정을 내렸다.", source="m.md", date="", doc_type="meeting")

    mock_detect.assert_not_called()


def test_ingest_skips_supersede_without_decisions():
    """decision이 없으면 detect_supersede를 호출하지 않는다."""
    items = [_item("action", "배포 스크립트 수정")]
    conn, _ = _make_conn()
    with patch("backend.pipeline.ingestor.get_connection", return_value=conn), \
         patch("backend.pipeline.ingestor.upsert_memory_vectors"), \
         patch("backend.pipeline.ingestor.get_collection") as mock_coll, \
         patch("backend.reconciler.supersede.detect_supersede") as mock_detect:
        mock_coll.return_value.add = MagicMock()
        ingest(project_id=1, doc_id=5, repo_id=None, items=items,
               raw_text="", source="m.md", date="", doc_type="meeting")

    mock_detect.assert_not_called()


def test_ingest_survives_supersede_failure():
    """detect_supersede가 실패해도 적재는 성공한다(best-effort)."""
    items = [_item("decision", "새 결정")]
    conn, cursor = _make_conn()
    with patch("backend.pipeline.ingestor.get_connection", return_value=conn), \
         patch("backend.pipeline.ingestor.upsert_memory_vectors"), \
         patch("backend.pipeline.ingestor.get_collection") as mock_coll, \
         patch("backend.reconciler.supersede.detect_supersede", side_effect=RuntimeError("LLM down")):
        mock_coll.return_value.add = MagicMock()
        ingest(project_id=1, doc_id=5, repo_id=None, items=items,
               raw_text="", source="m.md", date="", doc_type="meeting")

    # 적재 트랜잭션은 커밋되었다(예외가 전파되지 않음)
    assert conn.commit.called
