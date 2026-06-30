use base64::{engine::general_purpose, Engine as _};
use std::path::Path;
use std::process::Command;

const MAX_PREVIEW_BYTES: u64 = 5 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitRepositorySnapshot {
    path: String,
    name: String,
    branch: String,
    is_dirty: bool,
    remote_repo: Option<String>,
    issue_pr_status: String,
    events: Vec<GitTimelineEvent>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitTimelineEvent {
    id: String,
    #[serde(rename = "type")]
    event_type: String,
    title: String,
    created_at: u64,
    status: Option<String>,
    url: Option<String>,
}

// 로컬 이미지 파일을 프론트 미리보기용 data URL로 변환한다.
#[tauri::command]
fn create_attachment_preview(path: String) -> Result<Option<String>, String> {
    let Some(mime_type) = image_mime_type(&path) else {
        return Ok(None);
    };
    let metadata =
        std::fs::metadata(&path).map_err(|_| "이미지 파일을 읽을 수 없습니다".to_string())?;

    if metadata.len() > MAX_PREVIEW_BYTES {
        return Ok(None);
    }

    let bytes = std::fs::read(&path).map_err(|_| "이미지 파일을 읽을 수 없습니다".to_string())?;
    let encoded = general_purpose::STANDARD.encode(bytes);

    Ok(Some(format!("data:{mime_type};base64,{encoded}")))
}

// 선택한 로컬 git 저장소에서 branch/status/commit과 가능한 GitHub issue/PR을 읽는다.
#[tauri::command]
fn inspect_git_repository(path: String) -> Result<GitRepositorySnapshot, String> {
    let root = git_stdout(&path, &["rev-parse", "--show-toplevel"])?;
    let root_path = Path::new(root.trim());

    if !root_path.is_dir() {
        return Err("Git 저장소 경로를 확인할 수 없습니다".to_string());
    }

    let root = root_path.to_string_lossy().into_owned();
    let branch = git_stdout(&root, &["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let branch = if branch.is_empty() {
        git_stdout(&root, &["rev-parse", "--short", "HEAD"])
            .unwrap_or_else(|_| "detached".to_string())
            .trim()
            .to_string()
    } else {
        branch
    };
    let status = git_stdout(&root, &["status", "--short"]).unwrap_or_default();
    let remote_url = git_stdout(&root, &["config", "--get", "remote.origin.url"]).ok();
    let remote_repo = remote_url.as_deref().and_then(parse_github_repo);
    let mut events = git_commit_events(&root, remote_repo.as_deref());
    let issue_pr_status = if let Some(repo) = remote_repo.as_deref() {
        let github_events = github_issue_pr_events(repo);

        if github_events.is_empty() {
            "GitHub CLI 인증이 없거나 issue/PR을 읽을 수 없습니다".to_string()
        } else {
            events.splice(0..0, github_events);
            "GitHub issue/PR 연동됨".to_string()
        }
    } else {
        "GitHub remote가 없습니다".to_string()
    };
    let name = root_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Repository")
        .to_string();

    Ok(GitRepositorySnapshot {
        path: root,
        name,
        branch,
        is_dirty: !status.trim().is_empty(),
        remote_repo,
        issue_pr_status,
        events,
    })
}

// 확장자를 기준으로 미리보기 가능한 이미지 MIME 타입을 반환한다.
fn image_mime_type(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("avif") => Some("image/avif"),
        Some("gif") => Some("image/gif"),
        Some("jpeg") | Some("jpg") => Some("image/jpeg"),
        Some("png") => Some("image/png"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

fn git_stdout(repo_path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(["-C", repo_path])
        .args(args)
        .output()
        .map_err(|_| "git 명령을 실행할 수 없습니다".to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git 저장소를 읽을 수 없습니다".to_string()
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn parse_github_repo(remote_url: &str) -> Option<String> {
    let trimmed = remote_url.trim().trim_end_matches(".git");

    if let Some(path) = trimmed.strip_prefix("git@github.com:") {
        return normalize_github_repo_path(path);
    }

    if let Some(path) = trimmed.strip_prefix("https://github.com/") {
        return normalize_github_repo_path(path);
    }

    if let Some(path) = trimmed.strip_prefix("http://github.com/") {
        return normalize_github_repo_path(path);
    }

    None
}

fn normalize_github_repo_path(path: &str) -> Option<String> {
    let mut parts = path.split('/').filter(|part| !part.is_empty());
    let owner = parts.next()?;
    let repo = parts.next()?;

    Some(format!("{owner}/{repo}"))
}

fn git_commit_events(repo_path: &str, remote_repo: Option<&str>) -> Vec<GitTimelineEvent> {
    let Ok(output) = git_stdout(
        repo_path,
        &["log", "-8", "--pretty=format:%H%x1f%h%x1f%ct%x1f%s"],
    ) else {
        return Vec::new();
    };

    output
        .lines()
        .filter_map(|line| parse_git_commit_event(line, remote_repo))
        .collect()
}

fn parse_git_commit_event(line: &str, remote_repo: Option<&str>) -> Option<GitTimelineEvent> {
    let mut parts = line.split('\x1f');
    let hash = parts.next()?;
    let short_hash = parts.next()?;
    let timestamp = parts.next()?.parse::<u64>().ok()?;
    let title = parts.next()?.to_string();

    Some(GitTimelineEvent {
        id: format!("commit-{hash}"),
        event_type: "commit".to_string(),
        title,
        created_at: timestamp.saturating_mul(1000),
        status: Some(short_hash.to_string()),
        url: remote_repo.map(|repo| format!("https://github.com/{repo}/commit/{hash}")),
    })
}

fn github_issue_pr_events(repo: &str) -> Vec<GitTimelineEvent> {
    let mut events = Vec::new();

    events.extend(gh_list_events(repo, "issue", "issue"));
    events.extend(gh_list_events(repo, "pr", "pull_request"));
    events.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    events.truncate(10);
    events
}

fn gh_list_events(repo: &str, resource: &str, event_type: &str) -> Vec<GitTimelineEvent> {
    let output = Command::new("gh")
        .args([
            resource,
            "list",
            "--repo",
            repo,
            "--limit",
            "10",
            "--json",
            "number,title,state,updatedAt,url",
            "--template",
            "{{range .}}{{.number}}\t{{.title}}\t{{.state}}\t{{.updatedAt}}\t{{.url}}\n{{end}}",
        ])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };

    if !output.status.success() {
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| parse_gh_event_line(line, event_type))
        .collect()
}

fn parse_gh_event_line(line: &str, event_type: &str) -> Option<GitTimelineEvent> {
    let mut parts = line.split('\t');
    let number = parts.next()?.trim();
    let title = parts.next()?.trim();
    let state = parts.next()?.trim();
    let updated_at = parts.next()?.trim();
    let url = parts.next()?.trim();
    let prefix = if event_type == "pull_request" {
        "PR"
    } else {
        "issue"
    };

    Some(GitTimelineEvent {
        id: format!("{event_type}-{number}"),
        event_type: event_type.to_string(),
        title: format!("{prefix} #{number} {title}"),
        created_at: parse_rfc3339_utc_millis(updated_at).unwrap_or(0),
        status: Some(state.to_ascii_lowercase()),
        url: Some(url.to_string()),
    })
}

fn parse_rfc3339_utc_millis(value: &str) -> Option<u64> {
    let date_time = value.strip_suffix('Z')?;
    let (date, time) = date_time.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;
    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<u64>().ok()?;
    let minute = time_parts.next()?.parse::<u64>().ok()?;
    let second = time_parts.next()?.parse::<u64>().ok()?;
    let days = days_from_civil(year, month, day);

    if days < 0 {
        return None;
    }

    Some(((days as u64 * 24 + hour) * 60 * 60 + minute * 60 + second) * 1000)
}

fn days_from_civil(mut year: i32, month: u32, day: u32) -> i64 {
    year -= i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = month as i32;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i32 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;

    i64::from(era * 146_097 + day_of_era - 719_468)
}

// PaiM 데스크톱 앱의 Tauri 런타임을 시작한다.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            create_attachment_preview,
            inspect_git_repository
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PaiM desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    // 테스트끼리 파일명이 겹치지 않도록 현재 시간 기반 임시 경로를 만든다.
    fn temp_path(file_name: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();

        std::env::temp_dir().join(format!("paim-{suffix}-{file_name}"))
    }

    #[test]
    fn image_mime_type_accepts_supported_extensions() {
        assert_eq!(image_mime_type("mock.PNG"), Some("image/png"));
        assert_eq!(image_mime_type("mock.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime_type("mock.webp"), Some("image/webp"));
    }

    #[test]
    fn image_mime_type_rejects_non_images() {
        assert_eq!(image_mime_type("mock.txt"), None);
        assert_eq!(image_mime_type("mock"), None);
    }

    #[test]
    fn parse_github_repo_accepts_common_remote_urls() {
        assert_eq!(
            parse_github_repo("git@github.com:j3s30p/Stampy.git"),
            Some("j3s30p/Stampy".to_string())
        );
        assert_eq!(
            parse_github_repo("https://github.com/j3s30p/Stampy.git"),
            Some("j3s30p/Stampy".to_string())
        );
    }

    #[test]
    fn parse_git_commit_event_maps_log_fields() {
        let event = parse_git_commit_event(
            "abcdef123\x1fabcdef1\x1f1781615505\x1ffix(map): normalize origin",
            Some("j3s30p/Stampy"),
        )
        .expect("commit log line should parse");

        assert_eq!(event.event_type, "commit");
        assert_eq!(event.title, "fix(map): normalize origin");
        assert_eq!(event.created_at, 1_781_615_505_000);
        assert_eq!(
            event.url,
            Some("https://github.com/j3s30p/Stampy/commit/abcdef123".to_string())
        );
    }

    #[test]
    fn parse_rfc3339_utc_millis_handles_github_time() {
        assert_eq!(
            parse_rfc3339_utc_millis("2026-06-16T13:30:04Z"),
            Some(1_781_616_604_000)
        );
    }

    #[test]
    fn create_attachment_preview_returns_data_url_for_small_png() {
        let path = temp_path("preview.png");
        let png_bytes = [
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, b'I', b'H',
            b'D', b'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89,
        ];

        fs::write(&path, png_bytes).expect("test png should be writable");
        let preview = create_attachment_preview(path.to_string_lossy().into_owned())
            .expect("preview command should succeed");
        fs::remove_file(path).expect("test png should be removable");

        let preview = preview.expect("small png should create a preview");
        assert!(preview.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn create_attachment_preview_ignores_non_image_files() {
        let path = temp_path("preview.txt");

        fs::write(&path, "not an image").expect("test file should be writable");
        let preview = create_attachment_preview(path.to_string_lossy().into_owned())
            .expect("non-image preview command should succeed");
        fs::remove_file(path).expect("test file should be removable");

        assert!(preview.is_none());
    }
}
