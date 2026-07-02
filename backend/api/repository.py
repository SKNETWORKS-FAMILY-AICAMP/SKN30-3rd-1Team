import base64
import json
import logging
from typing import Optional
from urllib import error, parse, request

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel
from ..db.mysql import get_connection
from ..reconciler import reconcile_repository_prs
from .auth import require_project_access

router = APIRouter()
logger = logging.getLogger(__name__)

_GITHUB_API = "https://api.github.com"
_GITHUB_API_VERSION = "2022-11-28"
_SUPPORTED_PROVIDERS = {"github"}


# ── GitHub API 헬퍼 ───────────────────────────────────────────────

def _gh_get(path: str, token: str | None = None):
    """GitHub API GET. token 있으면 인증 요청. 실패 시 빈 값 반환 (로그 후 흡수)."""
    url = path if path.startswith("https://") else f"{_GITHUB_API}{path}"
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": _GITHUB_API_VERSION,
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = request.Request(url, headers=headers)
    try:
        with request.urlopen(req, timeout=15) as resp:
            payload = resp.read().decode("utf-8")
            return json.loads(payload) if payload else {}
    except error.HTTPError as exc:
        if exc.code in (401, 403):
            logger.warning("GitHub API 인증 오류 %s: %s (비공개 저장소거나 토큰 권한 부족)", exc.code, path)
        else:
            logger.warning("GitHub API HTTP 오류 %s: %s", exc.code, path)
        return {}
    except error.URLError as exc:
        logger.warning("GitHub API 네트워크 오류: %s — %s", path, exc.reason)
        return {}
    except Exception:
        logger.warning("GitHub API 예외: %s", path, exc_info=True)
        return {}


def _get_github_token(state: str | None) -> str | None:
    """GitHub App session state → installation token. state 없으면 None 반환."""
    if not state:
        return None
    try:
        from ..github.router import _installation_token
        return _installation_token(state)
    except HTTPException as exc:
        raise HTTPException(status_code=401, detail=f"GitHub App 세션 오류: {exc.detail}")


def _parse_github_full_name(url: str) -> str:
    """'https://github.com/owner/repo' 형식을 'owner/repo'로 변환. 실패 시 HTTPException."""
    trimmed = url.strip().removesuffix(".git")
    try:
        parsed = parse.urlparse(trimmed if trimmed.startswith("http") else f"https://{trimmed}")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid repository URL")
    if parsed.netloc != "github.com":
        raise HTTPException(status_code=400, detail="GitHub URL만 지원합니다 (github.com)")
    parts = [p for p in parsed.path.strip("/").split("/") if p]
    if len(parts) < 2:
        raise HTTPException(status_code=400, detail="URL에 owner/repo 형식이 포함되어야 합니다")
    return f"{parts[0]}/{parts[1]}"


def _collect_repo_sources(
    full_name: str, branch: str, token: str | None = None
) -> tuple[dict[str, dict], str | None, list[dict]]:
    """GitHub API로 README·commits·issues·PRs 텍스트 수집.
    Returns (sources_dict, latest_commit_sha, warnings).
    sources_dict 형태: {"README.md": {"content": str, "metadata": dict}, ...}
    warnings: API 호출 부분 실패 목록 [{"source_type": str, "reason": str}, ...]
    """
    sources: dict[str, dict] = {}
    latest_sha: str | None = None
    warnings: list[dict] = []

    # Commits (sha를 먼저 확보해 README metadata에 활용)
    commits = _gh_get(f"/repos/{full_name}/commits?sha={parse.quote(branch)}&per_page=20", token=token)
    if not isinstance(commits, list):
        warnings.append({"source_type": "commits", "reason": "GitHub API 응답 오류 (인증/네트워크 문제일 수 있음)"})
    elif commits:
        latest_sha = commits[0].get("sha")
        lines = []
        for c in commits:
            sha = (c.get("sha") or "")[:7]
            commit_info = c.get("commit") or {}
            msg = commit_info.get("message", "").split("\n")[0]
            date = (commit_info.get("author") or {}).get("date", "")[:10]
            lines.append(f"[{sha}] {date}: {msg}")
        if lines:
            sources["commits.txt"] = {
                "content": "\n".join(lines),
                "metadata": {
                    "source_type": "commits",
                    "source_path": "commits.txt",
                    "source_ref": latest_sha or "",
                    "source_url": "",
                },
            }

    # README (404는 README 없는 저장소로 정상 — warning 생략)
    readme = _gh_get(f"/repos/{full_name}/readme", token=token)
    if isinstance(readme, dict) and readme.get("content"):
        try:
            decoded = base64.b64decode(readme["content"]).decode("utf-8", errors="replace")
            readme_url = (
                f"https://github.com/{full_name}/blob/{latest_sha}/README.md"
                if latest_sha else ""
            )
            sources["README.md"] = {
                "content": decoded,
                "metadata": {
                    "source_type": "readme",
                    "source_path": "README.md",
                    "source_ref": latest_sha or "",
                    "source_url": readme_url,
                },
            }
        except Exception:
            pass

    # Issues (PR 제외)
    issues = _gh_get(f"/repos/{full_name}/issues?state=open&per_page=20", token=token)
    if not isinstance(issues, list):
        warnings.append({"source_type": "issues", "reason": "GitHub API 응답 오류 (인증/네트워크 문제일 수 있음)"})
    else:
        issue_texts = [
            f"Issue #{i.get('number')} ({i.get('state', 'open')}): {i.get('title', '')}\n{i.get('body') or ''}"
            for i in issues if not i.get("pull_request")
        ]
        if issue_texts:
            sources["issues.txt"] = {
                "content": "\n\n".join(issue_texts),
                "metadata": {
                    "source_type": "issues",
                    "source_path": "issues.txt",
                    "source_ref": latest_sha or "",
                    "source_url": "",
                },
            }

    # Pull Requests
    pulls = _gh_get(f"/repos/{full_name}/pulls?state=open&per_page=20", token=token)
    if not isinstance(pulls, list):
        warnings.append({"source_type": "pulls", "reason": "GitHub API 응답 오류 (인증/네트워크 문제일 수 있음)"})
    else:
        pr_texts = [
            f"PR #{p.get('number')} ({p.get('state', 'open')}): {p.get('title', '')}\n{p.get('body') or ''}"
            for p in pulls
        ]
        if pr_texts:
            sources["pulls.txt"] = {
                "content": "\n\n".join(pr_texts),
                "metadata": {
                    "source_type": "pulls",
                    "source_path": "pulls.txt",
                    "source_ref": latest_sha or "",
                    "source_url": "",
                },
            }

    return sources, latest_sha, warnings


def _extract_source_kind(source_type: str | None) -> str:
    """repo 수집 source_type을 extractor 전용 지침 키로 바꾼다."""
    return {
        "readme": "repo_readme",
        "commits": "repo_commits",
        "issues": "repo_issues",
        "pulls": "repo_prs",
    }.get(source_type or "", "document")


def _summarize_pr_body(body: str | None) -> str:
    """PR 본문을 Reconciler 입력용 짧은 요약 필드로 줄인다."""
    text = (body or "").strip()
    if len(text) <= 1200:
        return text
    return f"{text[:1200].rstrip()}..."


def _collect_merged_prs(full_name: str, last_reconciled_pr: int | None, token: str | None = None) -> list[dict]:
    """last_reconciled_pr 이후의 merged PR을 GitHub에서 조회해 Reconciler 입력으로 만든다."""
    watermark = int(last_reconciled_pr or 0)
    merged = []
    page = 1
    while True:
        pulls = _gh_get(
            f"/repos/{full_name}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page={page}",
            token=token,
        )
        if not isinstance(pulls, list):
            logger.warning("merged PR 수집 실패 full_name=%s page=%s", full_name, page)
            return []
        for pr in pulls:
            number = pr.get("number")
            if not number or int(number) <= watermark or not pr.get("merged_at"):
                continue
            merged.append(
                {
                    "number": int(number),
                    "title": pr.get("title") or "",
                    "body_summary": _summarize_pr_body(pr.get("body")),
                    "url": pr.get("html_url") or "",
                    "merged_at": pr.get("merged_at") or "",
                }
            )
        if len(pulls) < 100:
            break
        page += 1
    return sorted(merged, key=lambda item: item["number"])


# ── DB 헬퍼 ──────────────────────────────────────────────────────

class RepositoryConnect(BaseModel):
    provider: str = "github"
    repository_url: str
    branch: Optional[str] = None
    state: Optional[str] = None  # GitHub App session state (비공개 저장소용)


class SyncRequest(BaseModel):
    state: Optional[str] = None  # GitHub App session state (비공개 저장소용)


def _repo_or_404(cursor, project_id: int, repo_id: int) -> dict:
    cursor.execute(
        "SELECT * FROM repositories WHERE id = %s AND project_id = %s",
        (repo_id, project_id),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Repository not found")
    return row


def _clear_repo_indexed_data(repo_id: int, refresh_project_memory: bool = False):
    """재동기화 전 기존 memory/vector 정리 (repositories 행은 유지)."""
    project_id = None
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT project_id FROM repositories WHERE id = %s", (repo_id,))
            row = cursor.fetchone()
            if row:
                project_id = row.get("project_id")
            cursor.execute("DELETE FROM memory WHERE repo_id = %s", (repo_id,))
        conn.commit()
    except Exception:
        logger.warning("기존 memory 정리 실패 repo_id=%s", repo_id, exc_info=True)
    finally:
        conn.close()
    try:
        from ..db.chroma import get_collection
        get_collection().delete(where={"repo_id": repo_id})
    except Exception:
        logger.warning("기존 ChromaDB vector 정리 실패 repo_id=%s", repo_id, exc_info=True)
    if refresh_project_memory and project_id is not None:
        from ..graph import refresh_project_memory_after_delete
        refresh_project_memory_after_delete(project_id)


def _delete_repo_data(repo_id: int):
    """memory 행 + repositories 행 + ChromaDB 벡터 삭제."""
    project_id = None
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT project_id FROM repositories WHERE id = %s", (repo_id,))
            row = cursor.fetchone()
            if row:
                project_id = row.get("project_id")
            cursor.execute("DELETE FROM memory WHERE repo_id = %s", (repo_id,))
            cursor.execute("DELETE FROM repositories WHERE id = %s", (repo_id,))
        conn.commit()
    except Exception:
        logger.warning("MySQL delete failed for repo_id=%s", repo_id, exc_info=True)
    finally:
        conn.close()

    try:
        from ..db.chroma import get_collection
        get_collection().delete(where={"repo_id": repo_id})
    except Exception:
        logger.warning("ChromaDB vector cleanup failed for repo_id=%s", repo_id, exc_info=True)
    if project_id is not None:
        from ..graph import refresh_project_memory_after_delete
        refresh_project_memory_after_delete(project_id)


# None은 commit_sha=None처럼 DB에 저장될 유효한 값이므로 "미전달"을 구분하는 sentinel 사용
_UNSET = object()


def _set_repo_status(
    repo_id: int,
    status: str,
    commit_sha=_UNSET,
    indexed_files=_UNSET,
    last_error=_UNSET,
    sync_warning=_UNSET,
):
    updates: dict = {"status": status}
    if commit_sha is not _UNSET:
        updates["commit_sha"] = commit_sha
    if indexed_files is not _UNSET:
        updates["indexed_files"] = indexed_files
    if last_error is not _UNSET:
        updates["last_error"] = last_error
    if sync_warning is not _UNSET:
        updates["sync_warning"] = sync_warning

    set_clause = ", ".join(f"{k}=%s" for k in updates)
    values = list(updates.values()) + [repo_id]

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(f"UPDATE repositories SET {set_clause} WHERE id=%s", values)
        conn.commit()
    except Exception:
        logger.warning("repositories status update failed repo_id=%s", repo_id, exc_info=True)
    finally:
        conn.close()


def _get_last_reconciled_pr(repo_id: int) -> int | None:
    """repositories 워터마크를 읽는다. 컬럼이 없거나 읽기 실패 시 첫 실행처럼 처리한다."""
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT last_reconciled_pr FROM repositories WHERE id = %s", (repo_id,))
            row = cursor.fetchone()
        return row.get("last_reconciled_pr") if row else None
    except Exception:
        logger.warning("last_reconciled_pr 조회 실패 repo_id=%s", repo_id, exc_info=True)
        return None
    finally:
        conn.close()


# ── 백그라운드 처리 ───────────────────────────────────────────────

def _sync_bg(project_id: int, repo_id: int, full_name: str, branch: str, token: str | None):
    """GitHub 수집 → 기존 index 삭제 → ingest → status 갱신."""
    from ..pipeline.extractor import extract
    from ..pipeline.ingestor import ingest

    try:
        last_reconciled_pr = _get_last_reconciled_pr(repo_id)
        sources, latest_sha, warnings = _collect_repo_sources(full_name, branch, token=token)

        if not sources:
            detail = "저장소에서 수집할 콘텐츠가 없습니다."
            if not token:
                detail += " 비공개 저장소라면 GitHub App 인증 후 state를 전달해주세요."
            _set_repo_status(repo_id, "failed", last_error=detail)
            return

        merged_prs = _collect_merged_prs(full_name, last_reconciled_pr, token=token)

        _clear_repo_indexed_data(repo_id)

        indexed = 0
        for source_name, source_data in sources.items():
            content = source_data["content"]
            src_metadata = source_data.get("metadata", {})
            if not content or not content.strip():
                continue
            try:
                items = extract(
                    content,
                    default_source=source_name,
                    source_kind=_extract_source_kind(src_metadata.get("source_type")),
                )
            except Exception:
                logger.warning("extract 실패 — source=%s repo_id=%s", source_name, repo_id, exc_info=True)
                items = []
            try:
                ingest(
                    project_id=project_id,
                    doc_id=None,
                    repo_id=repo_id,
                    items=items,
                    raw_text=content,
                    source=source_name,
                    date="",
                    doc_type="repository",
                    source_metadata={"source_kind": "repository", "repo_id": repo_id, **src_metadata},
                )
                indexed += 1
            except Exception:
                logger.warning("ingest 실패 — source=%s repo_id=%s", source_name, repo_id, exc_info=True)

        from ..graph import refresh_project_memory_after_delete
        refresh_project_memory_after_delete(project_id)

        import json as _json
        sync_warning = _json.dumps(warnings, ensure_ascii=False) if warnings else None
        if warnings:
            logger.warning("repo sync partial failure repo_id=%s warnings=%s", repo_id, warnings)

        _set_repo_status(
            repo_id, "indexed",
            commit_sha=latest_sha,
            indexed_files=indexed,
            last_error=None,
            sync_warning=sync_warning,
        )

        try:
            result = reconcile_repository_prs(project_id, repo_id, merged_prs)
            logger.info("reconciler 완료 repo_id=%s result=%s", repo_id, result)
        except Exception:
            logger.warning("reconciler 실패 (sync는 성공 유지) repo_id=%s", repo_id, exc_info=True)

    except Exception as exc:
        logger.error("sync_bg 실패 repo_id=%s", repo_id, exc_info=True)
        _set_repo_status(repo_id, "failed", last_error=str(exc))


# ── Endpoints ────────────────────────────────────────────────────

@router.post("/projects/{project_id}/repositories", status_code=201)
def connect_repository(project_id: int, body: RepositoryConnect):
    require_project_access(project_id, min_role="member")
    if body.provider not in _SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 provider입니다: {body.provider}")

    full_name = _parse_github_full_name(body.repository_url)
    token = _get_github_token(body.state)

    # 저장소 존재 확인 + default branch 조회
    repo_meta = _gh_get(f"/repos/{full_name}", token=token)
    if not isinstance(repo_meta, dict) or not repo_meta.get("id"):
        detail = "저장소를 찾을 수 없습니다."
        if not token:
            detail += " 비공개 저장소라면 GitHub App 인증 후 state를 전달해주세요."
        raise HTTPException(status_code=404, detail=detail)
    branch = body.branch or repo_meta.get("default_branch") or "main"

    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Project not found")
            cursor.execute(
                "INSERT INTO repositories (project_id, provider, repository_url, branch, status)"
                " VALUES (%s, %s, %s, %s, 'connected')",
                (project_id, body.provider, body.repository_url, branch),
            )
            repo_id = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()

    # 연결만 등록 (status='connected'). sync는 POST .../repositories/{id}/sync 로 별도 트리거
    return {"repo_id": repo_id, "status": "connected", "branch": branch}


@router.get("/projects/{project_id}/repositories")
def list_repositories(project_id: int):
    require_project_access(project_id)
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="Project not found")
            cursor.execute(
                "SELECT id, provider, repository_url, branch, status, connected_at"
                " FROM repositories WHERE project_id = %s ORDER BY connected_at DESC",
                (project_id,),
            )
            return cursor.fetchall()
    finally:
        conn.close()


@router.get("/projects/{project_id}/repositories/{repo_id}")
def get_repository(project_id: int, repo_id: int):
    require_project_access(project_id)
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            row = _repo_or_404(cursor, project_id, repo_id)
            return {
                "id": row["id"],
                "provider": row["provider"],
                "repository_url": row["repository_url"],
                "branch": row["branch"],
                "status": row["status"],
                "commit_sha": row["commit_sha"],
                "indexed_files": row["indexed_files"],
                "sync_warning": row.get("sync_warning"),
                "connected_at": row["connected_at"],
            }
    finally:
        conn.close()


@router.get("/projects/{project_id}/repositories/{repo_id}/status")
def get_repository_status(project_id: int, repo_id: int):
    require_project_access(project_id)
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            row = _repo_or_404(cursor, project_id, repo_id)
            cursor.execute(
                "SELECT category, COUNT(*) as cnt FROM memory WHERE repo_id = %s GROUP BY category",
                (repo_id,),
            )
            counts = {"decision": 0, "action": 0, "issue": 0, "risk": 0}
            for r in cursor.fetchall():
                if r["category"] in counts:
                    counts[r["category"]] = r["cnt"]
    finally:
        conn.close()

    return {
        "repo_id": row["id"],
        "status": row["status"],
        "provider": row["provider"],
        "repository_url": row["repository_url"],
        "branch": row["branch"],
        "commit_sha": row["commit_sha"],
        "indexed_files": row["indexed_files"],
        "last_error": row.get("last_error"),
        "sync_warning": row.get("sync_warning"),
        "extracted": counts,
    }


@router.post("/projects/{project_id}/repositories/{repo_id}/sync", status_code=202)
def sync_repository(
    project_id: int,
    repo_id: int,
    background_tasks: BackgroundTasks,
    body: SyncRequest = SyncRequest(),
):
    require_project_access(project_id, min_role="member")
    # token 먼저 검증 — 실패 시 DB 변경 없이 즉시 401 반환
    token = _get_github_token(body.state)

    # 존재 확인 + syncing 상태 설정
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            repo_row = _repo_or_404(cursor, project_id, repo_id)
            cursor.execute(
                "UPDATE repositories SET status='syncing', last_error=NULL, sync_warning=NULL WHERE id=%s",
                (repo_id,),
            )
        conn.commit()
    finally:
        conn.close()

    full_name = _parse_github_full_name(repo_row["repository_url"])
    branch = repo_row["branch"] or "main"

    background_tasks.add_task(_sync_bg, project_id, repo_id, full_name, branch, token)

    return {"repo_id": repo_id, "status": "syncing"}


@router.delete("/projects/{project_id}/repositories/{repo_id}", status_code=204)
def delete_repository(project_id: int, repo_id: int):
    require_project_access(project_id, min_role="member")
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            _repo_or_404(cursor, project_id, repo_id)
    finally:
        conn.close()

    _delete_repo_data(repo_id)
