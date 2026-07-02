"""_split_text() chunk size 불변식 및 upload_document 비동기 경로 테스트."""
from unittest.mock import patch, MagicMock, call, ANY

from fastapi.testclient import TestClient

from backend.main import app

_client = TestClient(app, raise_server_exceptions=False)

_URL = "/api/v1/projects/1/documents"
_FILE = ("test.md", b"test content here", "text/plain")
_DATA = {"doc_type": "meeting"}


# ─── _split_text() chunk size 불변식 ─────────────────────────────────────────

def test_split_text_normal():
    from backend.pipeline.ingestor import _split_text, CHUNK_SIZE
    chunks = _split_text("hello world. " * 100)
    assert chunks
    assert all(len(c) <= CHUNK_SIZE for c in chunks)


def test_split_text_oversized_sentence():
    """단일 문장이 CHUNK_SIZE 초과해도 각 청크는 CHUNK_SIZE 이내."""
    from backend.pipeline.ingestor import _split_text, CHUNK_SIZE
    chunks = _split_text("x" * 800)
    assert chunks
    assert all(len(c) <= CHUNK_SIZE for c in chunks)


def test_split_text_codex_repro():
    """Codex Entry 033 재현: overlap 적용 후 CHUNK_SIZE 초과 없음 (이전: [501, 651])."""
    from backend.pipeline.ingestor import _split_text, CHUNK_SIZE
    chunks = _split_text("a" * 500 + ". " + "b" * 500)
    assert all(len(c) <= CHUNK_SIZE for c in chunks)


def test_split_text_short_returns_as_is():
    from backend.pipeline.ingestor import _split_text
    assert _split_text("짧은 텍스트") == ["짧은 텍스트"]


def test_split_text_whitespace_returns_empty():
    from backend.pipeline.ingestor import _split_text
    assert _split_text("   ") == []


# ─── upload_document 비동기 경로 ──────────────────────────────────────────────

def _make_conn(fetchone=None, fetchall=None, lastrowid=99):
    """get_connection() 단일 호출용 mock."""
    cursor = MagicMock()
    cursor.fetchone.return_value = fetchone
    cursor.fetchall.return_value = fetchall or []
    cursor.lastrowid = lastrowid
    cm = MagicMock()
    cm.__enter__ = lambda s: cursor
    cm.__exit__ = MagicMock(return_value=False)
    conn = MagicMock()
    conn.cursor.return_value = cm
    return conn


def _conn_seq(old_doc_ids=(), new_doc_id=99):
    """get_connection() 호출 순서별 mock 목록.
    1st: project 확인 + old_doc_ids 조회 (endpoint)
    2nd: INSERT document status='processing' (endpoint)
    3rd: _set_doc_status UPDATE (background)
    """
    return [
        _make_conn({"id": 1}, [{"id": i} for i in old_doc_ids]),
        _make_conn(None, [], new_doc_id),
        _make_conn(None, []),
    ]


def test_extract_failure_sets_failed_status():
    """extract 실패 시 응답은 processing, old doc 삭제 없음, 파일 삭제됨."""
    with patch("backend.api.upload.get_connection", side_effect=_conn_seq((42,))), \
         patch("backend.api.upload.save_file", return_value="data/1/test.md"), \
         patch("backend.api.upload.delete_file") as mock_del_file, \
         patch("backend.api.upload.extract", side_effect=ValueError("LLM error")), \
         patch("backend.api.upload._delete_document") as mock_del, \
         patch("backend.api.upload._set_doc_status") as mock_status:

        resp = _client.post(_URL, files={"file": _FILE}, data=_DATA)

        assert resp.status_code == 201
        assert resp.json()["status"] == "processing"
        mock_del.assert_not_called()
        mock_del_file.assert_called_once_with("data/1/test.md")
        mock_status.assert_called_once_with(99, "failed", last_error=ANY)


def test_ingest_failure_sets_failed_status():
    """ingest 실패 시 응답은 processing, doc row 유지(status=failed), memory/파일/벡터 정리됨."""
    with patch("backend.api.upload.get_connection", side_effect=_conn_seq((42,), 99)), \
         patch("backend.api.upload.save_file", return_value="data/1/test.md"), \
         patch("backend.api.upload.delete_file") as mock_del_file, \
         patch("backend.api.upload.extract", return_value=[]), \
         patch("backend.api.upload.ingest", side_effect=RuntimeError("DB error")), \
         patch("backend.api.upload._delete_doc_memory") as mock_del_mem, \
         patch("backend.api.upload._delete_chroma_vectors") as mock_del_chroma, \
         patch("backend.api.upload._delete_document") as mock_del, \
         patch("backend.api.upload._set_doc_status") as mock_status:

        resp = _client.post(_URL, files={"file": _FILE}, data=_DATA)

        assert resp.status_code == 201
        assert resp.json()["status"] == "processing"
        mock_del.assert_not_called()
        mock_del_mem.assert_called_once_with(99)
        mock_del_file.assert_called_once_with("data/1/test.md")
        mock_del_chroma.assert_called_once_with(99)
        mock_status.assert_called_once_with(99, "failed", last_error=ANY)


def test_success_cleans_up_all_old_docs():
    """성공 후 old doc_ids 전체 삭제, 신규 doc(99)은 삭제 안 됨."""
    with patch("backend.api.upload.get_connection", side_effect=_conn_seq((10, 11), 99)), \
         patch("backend.api.upload.save_file", return_value="data/1/test.md"), \
         patch("backend.api.upload.delete_file"), \
         patch("backend.api.upload.extract", return_value=[]), \
         patch("backend.api.upload.ingest"), \
         patch("backend.api.upload._set_doc_status"), \
         patch("backend.api.upload._delete_document") as mock_del:

        resp = _client.post(_URL, files={"file": _FILE}, data=_DATA)

        assert resp.status_code == 201
        assert resp.json()["status"] == "processing"
        assert call(10) in mock_del.call_args_list
        assert call(11) in mock_del.call_args_list
        assert call(99) not in mock_del.call_args_list


def test_no_old_doc_skips_cleanup():
    """기존 문서 없으면 _delete_document 호출 없음."""
    with patch("backend.api.upload.get_connection", side_effect=_conn_seq((), 99)), \
         patch("backend.api.upload.save_file", return_value="data/1/test.md"), \
         patch("backend.api.upload.delete_file"), \
         patch("backend.api.upload.extract", return_value=[]), \
         patch("backend.api.upload.ingest"), \
         patch("backend.api.upload._set_doc_status"), \
         patch("backend.api.upload._delete_document") as mock_del:

        resp = _client.post(_URL, files={"file": _FILE}, data=_DATA)

        assert resp.status_code == 201
        assert resp.json()["status"] == "processing"
        mock_del.assert_not_called()


def test_upload_without_doc_type_uses_default_document():
    """프론트가 doc_type을 보내지 않아도 기본값 document로 저장/ingest된다."""
    conns = _conn_seq((), 99)
    with patch("backend.api.upload.get_connection", side_effect=conns), \
         patch("backend.api.upload.save_file", return_value="data/1/test.md"), \
         patch("backend.api.upload.delete_file"), \
         patch("backend.api.upload.extract", return_value=[]), \
         patch("backend.api.upload.ingest") as mock_ingest, \
         patch("backend.api.upload._set_doc_status"), \
         patch("backend.api.upload._delete_document"):

        resp = _client.post(_URL, files={"file": _FILE}, data={})

        assert resp.status_code == 201
        insert_cursor = conns[1].cursor.return_value.__enter__()
        _, insert_params = insert_cursor.execute.call_args[0]
        assert insert_params[2] == "document"
        mock_ingest.assert_called_once()
        assert mock_ingest.call_args.kwargs["doc_type"] == "document"
        assert mock_ingest.call_args.kwargs["source_metadata"]["source_type"] == "document"
