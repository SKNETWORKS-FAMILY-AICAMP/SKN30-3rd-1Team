"""파일 저장소 추상화 레이어.

로컬 파일시스템을 기본으로 사용하며, UPLOAD_DIR 환경변수로 루트 경로를 지정한다.
추후 S3 등 클라우드 스토리지로 교체할 때는 이 모듈만 수정하면 된다.
"""
import os
import shutil
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

_UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "data/uploads"))


def _project_dir(project_id: int) -> Path:
    return _UPLOAD_DIR / str(project_id)


def safe_upload_name(filename: str) -> str:
    """업로드 파일명을 프로젝트 내부 상대경로로 정규화한다."""
    parts = []
    for part in filename.replace("\\", "/").split("/"):
        part = part.strip()
        if not part or part == ".":
            continue
        if part == "..":
            raise ValueError("invalid filename")
        parts.append(part)
    if not parts:
        raise ValueError("invalid filename")
    return "/".join(parts)


def save_file(project_id: int, filename: str, data: bytes) -> str:
    """파일을 저장하고 저장된 경로(문자열)를 반환한다."""
    safe_name = safe_upload_name(filename)
    dest_dir = _project_dir(project_id)
    dest = dest_dir / safe_name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return str(dest)


def delete_file(file_path: str, strict: bool = False) -> None:
    """저장된 파일을 삭제한다. strict=True이면 삭제 실패를 호출자에게 알린다."""
    try:
        Path(file_path).unlink(missing_ok=True)
    except Exception:
        if strict:
            raise
        pass


def delete_project_dir(project_id: int) -> None:
    """프로젝트 전체 업로드 디렉터리를 삭제한다."""
    try:
        shutil.rmtree(_project_dir(project_id), ignore_errors=True)
    except Exception:
        pass
