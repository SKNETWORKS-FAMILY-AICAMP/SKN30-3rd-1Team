"""memory_sources 분리 테이블: ingest/search/sync 경로 테스트."""
import base64
from unittest.mock import patch, MagicMock, call

from backend.api.repository import _collect_repo_sources, _sync_bg
from backend.pipeline.ingestor import ingest
from backend.pipeline.models import MemoryItem
from backend.retriever.mysql_search import search


# ── 공통 mock 헬퍼 ────────────────────────────────────────────────

def _make_conn(lastrowid=10):
    cursor = MagicMock()
    cursor.lastrowid = lastrowid
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    conn.cursor.return_value.__exit__.return_value = False
    return conn, cursor


# ── ingest() memory_sources INSERT ───────────────────────────────

def test_ingest_inserts_memory_source_row():
    """ingest() — memory INSERT 후 같은 트랜잭션에서 memory_sources INSERT."""
    item = MemoryItem(category="decision", content="we decided X",
                      reason="", topic="", owner="", date="")
    conn, cursor = _make_conn(lastrowid=10)
    with patch("backend.pipeline.ingestor.get_connection", return_value=conn), \
         patch("backend.pipeline.ingestor.get_collection") as mock_coll:
        mock_coll.return_value.add = MagicMock()
        ingest(
            project_id=1, doc_id=5, repo_id=None,
            items=[item], raw_text="test", source="test.md",
            date="", doc_type="meeting",
            source_metadata={"source_kind": "document", "source_type": "meeting", "source_path": "test.md"},
        )
    sql_calls = [c[0][0] for c in cursor.execute.call_args_list]
    assert any("memory_sources" in sql for sql in sql_calls)
    assert any("memory" in sql and "INSERT" in sql for sql in sql_calls)


def test_ingest_no_items_no_source_rows():
    """items 비어있으면 memory/memory_sources INSERT 없음."""
    conn, cursor = _make_conn()
    with patch("backend.pipeline.ingestor.get_connection", return_value=conn), \
         patch("backend.pipeline.ingestor.get_collection") as mock_coll:
        mock_coll.return_value.add = MagicMock()
        ingest(
            project_id=1, doc_id=5, repo_id=None,
            items=[], raw_text="", source="empty.md",
            date="", doc_type="meeting",
        )
    sql_calls = [c[0][0] for c in cursor.execute.call_args_list]
    assert not any("INSERT" in sql for sql in sql_calls)


def test_ingest_source_metadata_in_chroma():
    """source_metadata 값이 ChromaDB 메타데이터에 포함됨."""
    item = MemoryItem(category="action", content="do something",
                      reason="", topic="", owner="", date="")
    conn, cursor = _make_conn(lastrowid=1)
    mock_collection = MagicMock()
    with patch("backend.pipeline.ingestor.get_connection", return_value=conn), \
         patch("backend.pipeline.ingestor.get_collection", return_value=mock_collection):
        ingest(
            project_id=1, doc_id=None, repo_id=3,
            items=[item], raw_text="readme content here",
            source="README.md", date="", doc_type="repository",
            source_metadata={
                "source_kind": "repository",
                "source_type": "readme",
                "source_path": "README.md",
                "source_ref": "abc1234",
                "source_url": "https://github.com/owner/repo/blob/abc1234/README.md",
            },
        )
    assert mock_collection.add.called
    metadatas = mock_collection.add.call_args.kwargs.get("metadatas") or \
                mock_collection.add.call_args[1].get("metadatas") or \
                mock_collection.add.call_args[0][2]
    assert metadatas[0]["source_kind"] == "repository"
    assert metadatas[0]["source_type"] == "readme"
    assert metadatas[0]["source_ref"] == "abc1234"


# ── _collect_repo_sources 반환 형태 ──────────────────────────────

def test_collect_repo_sources_returns_content_and_metadata():
    """README.md 엔트리가 content + metadata dict 형태로 반환됨."""
    encoded = base64.b64encode(b"project readme content").decode()
    with patch("backend.api.repository._gh_get", side_effect=[
        [{"sha": "abc1234", "commit": {"message": "init", "author": {"date": "2026-07-02"}}}],  # commits
        {"content": encoded, "encoding": "base64"},   # readme
        [],   # issues
        [],   # pulls
    ]):
        sources, sha, warnings = _collect_repo_sources("owner/repo", "main")

    assert sha == "abc1234"
    assert "README.md" in sources
    src = sources["README.md"]
    assert "content" in src
    assert "metadata" in src
    assert src["metadata"]["source_type"] == "readme"
    assert src["metadata"]["source_ref"] == "abc1234"
    assert "github.com" in src["metadata"]["source_url"]


def test_collect_repo_sources_commits_metadata():
    """commits.txt 엔트리도 source_type='commits' metadata 포함."""
    with patch("backend.api.repository._gh_get", side_effect=[
        [{"sha": "def5678", "commit": {"message": "feat: add X", "author": {"date": "2026-07-02"}}}],
        {},   # readme empty
        [],
        [],
    ]):
        sources, sha, warnings = _collect_repo_sources("owner/repo", "main")

    assert "commits.txt" in sources
    assert sources["commits.txt"]["metadata"]["source_type"] == "commits"
    assert sources["commits.txt"]["metadata"]["source_ref"] == "def5678"


# ── _sync_bg source_metadata 전달 ────────────────────────────────

def test_sync_bg_passes_source_metadata_to_ingest():
    """_sync_bg — source_data의 metadata가 ingest source_metadata kwarg로 전달됨."""
    sources = {
        "README.md": {
            "content": "readme content",
            "metadata": {"source_type": "readme", "source_path": "README.md",
                         "source_ref": "abc", "source_url": "https://github.com/o/r/blob/abc/README.md"},
        }
    }
    with patch("backend.api.repository._collect_repo_sources", return_value=(sources, "abc", [])), \
         patch("backend.api.repository._clear_repo_indexed_data"), \
         patch("backend.api.repository._set_repo_status"), \
         patch("backend.pipeline.extractor.extract", return_value=[]), \
         patch("backend.pipeline.ingestor.ingest") as mock_ingest:
        _sync_bg(project_id=1, repo_id=10, full_name="owner/repo", branch="main", token=None)

    assert mock_ingest.called
    kwargs = mock_ingest.call_args.kwargs
    assert "source_metadata" in kwargs
    assert kwargs["source_metadata"]["source_type"] == "readme"
    assert kwargs["source_metadata"]["source_kind"] == "repository"


# ── mysql_search source_info ──────────────────────────────────────

def test_memory_search_includes_source_info():
    """search() — LEFT JOIN memory_sources 결과가 source_info 중첩 객체로 반환됨."""
    row = {
        "id": 1, "project_id": 1, "doc_id": 5, "repo_id": None,
        "category": "decision", "content": "we decided X", "source": "test.md",
        "source_kind": "document", "ms_doc_id": 5, "ms_repo_id": None,
        "source_type": "meeting", "source_path": "test.md",
        "source_ref": None, "source_url": None,
    }
    conn, cursor = _make_conn()
    cursor.fetchall.return_value = [row.copy()]
    with patch("backend.retriever.mysql_search.get_connection", return_value=conn):
        results = search(project_id=1)

    assert len(results) == 1
    assert "source_info" in results[0]
    si = results[0]["source_info"]
    assert si["kind"] == "document"
    assert si["path"] == "test.md"
    assert si["doc_id"] == 5


def test_memory_search_source_info_none_when_no_source_row():
    """LEFT JOIN 미매칭 (source row 없음) 시 source_info 값이 None."""
    row = {
        "id": 2, "project_id": 1, "doc_id": None, "repo_id": None,
        "category": "action", "content": "do X", "source": None,
        "source_kind": None, "ms_doc_id": None, "ms_repo_id": None,
        "source_type": None, "source_path": None, "source_ref": None, "source_url": None,
    }
    conn, cursor = _make_conn()
    cursor.fetchall.return_value = [row.copy()]
    with patch("backend.retriever.mysql_search.get_connection", return_value=conn):
        results = search(project_id=1)

    assert results[0]["source_info"]["kind"] is None
    assert results[0]["source_info"]["path"] is None
