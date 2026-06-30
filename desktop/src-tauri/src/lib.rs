use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::Manager;

const MAX_PREVIEW_BYTES: u64 = 5 * 1024 * 1024;
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
struct GithubDeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
struct GithubAccessTokenResponse {
    access_token: Option<String>,
    token_type: Option<String>,
    scope: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
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

// GitHub OAuth device flow 시작은 브라우저 CORS를 피하려고 Tauri에서 호출한다.
#[tauri::command]
fn github_oauth_device_code(
    client_id: String,
    scope: String,
) -> Result<GithubDeviceCodeResponse, String> {
    ureq::post(GITHUB_DEVICE_CODE_URL)
        .set("Accept", "application/json")
        .send_form(&[("client_id", client_id.as_str()), ("scope", scope.as_str())])
        .map_err(|error| error.to_string())?
        .into_json()
        .map_err(|error| error.to_string())
}

// 사용자가 브라우저 인증을 끝냈는지 확인하고 access token을 받는다.
#[tauri::command]
fn github_oauth_access_token(
    client_id: String,
    device_code: String,
) -> Result<GithubAccessTokenResponse, String> {
    ureq::post(GITHUB_ACCESS_TOKEN_URL)
        .set("Accept", "application/json")
        .send_form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code.as_str()),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code",
            ),
        ])
        .map_err(|error| error.to_string())?
        .into_json()
        .map_err(|error| error.to_string())
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

// PaiM 데스크톱 앱의 Tauri 런타임을 시작한다.
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                window
                    .set_decorations(false)
                    .expect("Windows should use the app titlebar");

                window.show().expect("main window should be visible");
            }

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            create_attachment_preview,
            github_oauth_device_code,
            github_oauth_access_token
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
