#!/usr/bin/env python3
"""Prepare one isolated corpus for the user-realistic 160-question evaluation.

The route-balanced evaluation's retained Chroma store is the frozen source of
truth.  This script copies that store, reconstructs its active memory rows, and
seeds a fresh MySQL schema without calling an extraction model.  It never drops
or reuses an existing database.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import chromadb
import pymysql
from pymysql.constants import CLIENT
from pymysql.cursors import DictCursor


CORPORA = ("modu", "csbot")
DATABASE_PREFIX = "paim_user160_eval_"
PROJECT_NAMES = {"modu": "Modu", "csbot": "CS-Bot"}
DEFAULT_OVERVIEW_SUMMARIES = {
    "modu": (
        "Modu는 동네 500m 반경의 관심사 기반 모임 매칭 앱 프로젝트다. "
        "MVP와 로그인·모임 기능을 개발하고 베타를 거쳐 2026년 5월 18일 "
        "출시를 준비했으며, 실시간 채팅은 후속 1.1 업데이트로 분리했다. "
        "출시 준비 과정에서는 소셜 로그인, iOS 심사, 이메일 인증, 서버 부하와 "
        "운영 모니터링이 주요 과제로 기록되었다."
    ),
    "csbot": (
        "그린커머스 CS-Bot 유지보수 프로젝트는 정책 문서 갱신, semantic "
        "chunking, 하이브리드 검색, re-ranking, LLM·프롬프트 개선으로 응답 "
        "품질을 높이는 작업이다. 2026년 6월 30일 1차 배포와 이후 모니터링·QA "
        "재측정을 계획했고, 멀티턴 맥락 유지와 일부 운영 과제는 후속 단계로 "
        "분리했다."
    ),
}
MEMORY_CATEGORIES = {"decision", "action", "issue", "risk"}
FIELD_PATTERN = re.compile(
    r"^(분류|내용|주제|근거|담당|마감|상태|완료)\s*:\s*(.*)$"
)
FIELD_NAMES = {
    "분류": "category",
    "내용": "content",
    "주제": "topic",
    "근거": "reason",
    "담당": "owner",
    "마감": "due_date",
    "상태": "status_text",
    "완료": "completed_text",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", required=True, choices=CORPORA)
    parser.add_argument(
        "--state-root",
        required=True,
        type=Path,
        help="Destination root; the isolated store is written under <root>/<corpus>",
    )
    parser.add_argument(
        "--sources-root",
        required=True,
        type=Path,
        help="Root containing <corpus>/*.md source documents",
    )
    parser.add_argument(
        "--overview-summary-file",
        type=Path,
        help="Optional source-grounded project overview text",
    )
    parser.add_argument("--db-host", default="127.0.0.1")
    parser.add_argument("--db-port", type=int, default=3316)
    parser.add_argument("--db-user", default="root")
    parser.add_argument("--db-password", default="eval")
    return parser.parse_args()


def database_name(corpus: str) -> str:
    return f"{DATABASE_PREFIX}{corpus}"


def source_state_root(repo: Path) -> Path:
    return repo / "evals/results/route_balanced_20260722_current/state"


def connect(
    args: argparse.Namespace,
    database: str | None = None,
    *,
    multi: bool = False,
):
    return pymysql.connect(
        host=args.db_host,
        port=args.db_port,
        user=args.db_user,
        password=args.db_password,
        database=database,
        charset="utf8mb4",
        cursorclass=DictCursor,
        autocommit=False,
        client_flag=CLIENT.MULTI_STATEMENTS if multi else 0,
    )


def ensure_database_absent(args: argparse.Namespace, db_name: str) -> None:
    conn = connect(args)
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = %s",
                (db_name,),
            )
            if cursor.fetchone():
                raise RuntimeError(
                    f"database already exists; refusing to reuse or drop it: {db_name}"
                )
    finally:
        conn.close()


def create_schema(repo: Path, args: argparse.Namespace, db_name: str) -> None:
    conn = connect(args)
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                f"CREATE DATABASE `{db_name}` "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
        conn.commit()
    finally:
        conn.close()

    schema = (repo / "backend/db/schema.sql").read_text(encoding="utf-8")
    conn = connect(args, db_name, multi=True)
    try:
        with conn.cursor() as cursor:
            cursor.execute(schema)
            while cursor.nextset():
                pass
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def parse_memory_document(document: str) -> dict[str, str]:
    values: dict[str, str] = {}
    current: str | None = None
    for raw_line in str(document or "").splitlines():
        match = FIELD_PATTERN.match(raw_line)
        if match:
            current = FIELD_NAMES[match.group(1)]
            values[current] = match.group(2).strip()
        elif current and raw_line.strip():
            values[current] = f"{values[current]}\n{raw_line.strip()}".strip()

    if not values.get("category") or not values.get("content"):
        raise RuntimeError(f"unparseable memory vector document: {document!r}")
    if values["category"] not in MEMORY_CATEGORIES:
        raise RuntimeError(f"unsupported memory category: {values['category']!r}")
    return values


def parse_iso_date(value: str | None, *, field: str) -> str | None:
    if not value:
        return None
    match = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", value)
    if not match:
        raise RuntimeError(f"{field} is not an ISO date: {value!r}")
    datetime.strptime(match.group(1), "%Y-%m-%d")
    return match.group(1)


def parse_completion(
    category: str, status_text: str | None, completed_text: str | None
) -> tuple[str, str | None]:
    if category != "action":
        return "unknown", None
    if completed_text:
        return "completed", parse_iso_date(completed_text, field="completed_at")

    normalized = re.sub(r"\s+", " ", str(status_text or "")).strip().lower()
    if not normalized or "미확인" in normalized or "unknown" in normalized:
        return "unknown", None
    if "미완료" in normalized or "진행 중" in normalized or normalized == "open":
        return "open", None
    if "완료" in normalized or normalized == "completed":
        return "completed", None
    raise RuntimeError(f"unsupported action completion status: {status_text!r}")


def canonical_documents(collection: Any) -> dict[int, str]:
    raw = collection.get(
        where={"item_type": "document"}, include=["metadatas"]
    )
    documents: dict[int, str] = {}
    for metadata in raw.get("metadatas") or []:
        metadata = metadata or {}
        doc_id = int(metadata.get("doc_id", -1))
        source = str(metadata.get("source") or "").strip()
        if doc_id <= 0 or not source:
            raise RuntimeError(f"invalid document metadata: {metadata}")
        previous = documents.setdefault(doc_id, source)
        if previous != source:
            raise RuntimeError(
                f"conflicting source names for doc_id={doc_id}: {previous!r} / {source!r}"
            )
    if not documents:
        raise RuntimeError("frozen Chroma contains no document chunks")
    return dict(sorted(documents.items()))


def reconstruct_memory_rows(
    collection: Any, documents: dict[int, str]
) -> list[dict[str, Any]]:
    raw = collection.get(
        where={"item_type": "memory"}, include=["documents", "metadatas"]
    )
    rows: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    base_created_at = datetime(2026, 1, 1)

    for vector_id, metadata, document in zip(
        raw.get("ids") or [],
        raw.get("metadatas") or [],
        raw.get("documents") or [],
    ):
        metadata = metadata or {}
        memory_id = int(metadata.get("memory_id", -1))
        if memory_id <= 0 or memory_id in seen_ids:
            raise RuntimeError(f"invalid or duplicate memory_id: {memory_id}")
        if str(vector_id) != f"memory:{memory_id}":
            raise RuntimeError(
                f"memory vector id mismatch: {vector_id!r} / memory_id={memory_id}"
            )
        if int(metadata.get("project_id", -1)) != 1:
            raise RuntimeError(f"unexpected frozen project_id: {metadata}")

        doc_id = int(metadata.get("doc_id", -1))
        source = str(metadata.get("source") or "").strip()
        if doc_id not in documents or documents[doc_id] != source:
            raise RuntimeError(
                f"memory source mismatch: id={memory_id}, doc_id={doc_id}, source={source!r}"
            )

        fields = parse_memory_document(str(document or ""))
        if str(metadata.get("category") or "") != fields["category"]:
            raise RuntimeError(f"memory category mismatch: id={memory_id}")
        owner = fields.get("owner") or None
        metadata_owner = str(metadata.get("owner") or "").strip() or None
        if owner != metadata_owner:
            raise RuntimeError(f"memory owner mismatch: id={memory_id}")

        status, completed_at = parse_completion(
            fields["category"], fields.get("status_text"), fields.get("completed_text")
        )
        source_date = parse_iso_date(source[:10], field="source date")
        row = {
            "id": memory_id,
            "project_id": 1,
            "doc_id": doc_id,
            "repo_id": None,
            "category": fields["category"],
            "content": fields["content"],
            "reason": fields.get("reason") or None,
            "topic": fields.get("topic") or None,
            "owner": owner,
            "date": source_date,
            "due_date": parse_iso_date(fields.get("due_date"), field="due_date"),
            "completed_at": completed_at,
            "completion_status": status,
            "completion_status_source": (
                "frozen_chroma" if fields["category"] == "action" else None
            ),
            "source": source,
            "sort_order": memory_id,
            "created_at": base_created_at + timedelta(seconds=memory_id),
        }
        rows.append(row)
        seen_ids.add(memory_id)

    if not rows:
        raise RuntimeError("frozen Chroma contains no memory vectors")
    return sorted(rows, key=lambda row: row["id"])


def load_frozen_chroma(
    source_chroma: Path, destination_chroma: Path
) -> tuple[str, dict[int, str], list[dict[str, Any]], int]:
    shutil.copytree(source_chroma, destination_chroma)
    client = chromadb.PersistentClient(path=str(destination_chroma))
    candidates = []
    for collection in client.list_collections():
        sample = collection.get(
            where={"item_type": "memory"}, limit=1, include=["metadatas"]
        )
        if sample.get("ids"):
            candidates.append(collection)
    if len(candidates) != 1:
        raise RuntimeError(
            f"expected one Chroma collection with memory vectors, got {len(candidates)}"
        )
    collection = candidates[0]
    documents = canonical_documents(collection)
    rows = reconstruct_memory_rows(collection, documents)
    document_chunks = collection.count() - len(rows)
    return collection.name, documents, rows, document_chunks


def resolve_sources(
    sources_root: Path, corpus: str, documents: dict[int, str]
) -> dict[int, Path]:
    corpus_root = sources_root.resolve() / corpus
    result: dict[int, Path] = {}
    for doc_id, filename in documents.items():
        path = corpus_root / filename
        if not path.is_file():
            raise RuntimeError(f"missing frozen source document: {path}")
        result[doc_id] = path
    return result


def read_overview_summary(args: argparse.Namespace) -> tuple[str, str]:
    if args.overview_summary_file:
        path = args.overview_summary_file.resolve()
        summary = path.read_text(encoding="utf-8").strip()
        if not summary:
            raise RuntimeError(f"overview summary file is empty: {path}")
        return summary, str(path)
    return DEFAULT_OVERVIEW_SUMMARIES[args.corpus], "built-in-source-grounded-summary-v1"


def seed_mysql(
    args: argparse.Namespace,
    db_name: str,
    source_paths: dict[int, Path],
    rows: list[dict[str, Any]],
    overview_summary: str,
) -> None:
    conn = connect(args, db_name)
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "INSERT INTO projects (id, name) VALUES (1, %s)",
                (PROJECT_NAMES[args.corpus],),
            )
            for doc_id, path in sorted(source_paths.items()):
                cursor.execute(
                    "INSERT INTO documents"
                    " (id, project_id, filename, doc_type, status, file_path)"
                    " VALUES (%s, 1, %s, 'meeting', 'processed', %s)",
                    (doc_id, path.name, str(path)),
                )

            for row in rows:
                cursor.execute(
                    "INSERT INTO memory"
                    " (id, project_id, doc_id, repo_id, category, content, reason, topic,"
                    " owner, date, due_date, source, created_by, updated_by,"
                    " is_user_verified, completed_at, completion_status,"
                    " completion_status_source, superseded_by, superseded_at, sort_order,"
                    " created_at)"
                    " VALUES (%s, 1, %s, NULL, %s, %s, %s, %s, %s, %s, %s, %s,"
                    " 'llm', NULL, 0, %s, %s, %s, NULL, NULL, %s, %s)",
                    (
                        row["id"],
                        row["doc_id"],
                        row["category"],
                        row["content"],
                        row["reason"],
                        row["topic"],
                        row["owner"],
                        row["date"],
                        row["due_date"],
                        row["source"],
                        row["completed_at"],
                        row["completion_status"],
                        row["completion_status_source"],
                        row["sort_order"],
                        row["created_at"],
                    ),
                )
                cursor.execute(
                    "INSERT INTO memory_sources"
                    " (memory_id, source_kind, doc_id, source_type, source_path)"
                    " VALUES (%s, 'document', %s, 'meeting', %s)",
                    (row["id"], row["doc_id"], row["source"]),
                )

            cursor.execute(
                "INSERT INTO project_memory (project_id, summary) VALUES (1, %s)",
                (overview_summary,),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        digest.update(str(path.relative_to(root)).encode("utf-8"))
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def json_ready_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for row in rows:
        result.append(
            {
                key: value.isoformat() if isinstance(value, datetime) else value
                for key, value in row.items()
            }
        )
    return result


def main() -> int:
    args = parse_args()
    if args.db_port == 3306:
        raise RuntimeError(
            "refusing DB port 3306: it is reserved for the development database; "
            "use the isolated evaluation MySQL on port 3316"
        )

    repo = Path(__file__).resolve().parents[1]
    source_chroma = source_state_root(repo) / args.corpus / "chroma"
    if not (source_chroma / "chroma.sqlite3").is_file():
        raise RuntimeError(f"retained frozen Chroma not found: {source_chroma}")

    state_dir = args.state_root.resolve() / args.corpus
    if state_dir.exists():
        raise RuntimeError(f"destination state already exists: {state_dir}")
    destination_chroma = state_dir / "chroma"
    db_name = database_name(args.corpus)

    # Check every destructive boundary before creating either the schema or state.
    ensure_database_absent(args, db_name)
    state_dir.mkdir(parents=True)
    collection_name, documents, rows, document_chunks = load_frozen_chroma(
        source_chroma, destination_chroma
    )
    source_paths = resolve_sources(args.sources_root, args.corpus, documents)
    overview_summary, overview_summary_source = read_overview_summary(args)

    snapshot_path = state_dir / "memory_snapshot.json"
    snapshot_path.write_text(
        json.dumps(json_ready_rows(rows), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    create_schema(repo, args, db_name)
    seed_mysql(args, db_name, source_paths, rows, overview_summary)

    category_counts = Counter(row["category"] for row in rows)
    status_counts = Counter(
        row["completion_status"] for row in rows if row["category"] == "action"
    )
    overview_snapshot_path = state_dir / "overview_snapshot.json"
    overview_snapshot_path.write_text(
        json.dumps({
            "overview_summary": overview_summary,
            "category_stats": {
                category: int(category_counts.get(category, 0))
                for category in ("decision", "action", "issue", "risk")
            },
            "action_plan": {
                "total": int(category_counts.get("action", 0)),
                "status_counts": {
                    status: int(status_counts.get(status, 0))
                    for status in ("open", "completed", "unknown")
                },
                "items": [row for row in json_ready_rows(rows) if row["category"] == "action"],
            },
            "source": overview_summary_source,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    manifest = {
        "corpus": args.corpus,
        "database": db_name,
        "db_host": args.db_host,
        "db_port": args.db_port,
        "project_id": 1,
        "chroma_collection_name": collection_name,
        "chroma_persist_dir": str(destination_chroma),
        "frozen_chroma_source": str(source_chroma),
        "frozen_chroma_sha256": tree_sha256(source_chroma),
        "memory_rows": len(rows),
        "memory_vectors": len(rows),
        "document_chunks": document_chunks,
        "source_documents": len(documents),
        "category_counts": dict(sorted(category_counts.items())),
        "action_status_counts": dict(sorted(status_counts.items())),
        "overview_summary_source": overview_summary_source,
        "overview_snapshot": str(overview_snapshot_path),
        "memory_snapshot": str(snapshot_path),
    }
    manifest_path = state_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
