//! Downloads: a single API file through a native "Save as" dialog, and a list of files into a folder.

use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;

/// The file name a server gives in Content-Disposition (RFC 5987 `filename*` first), if any.
pub(crate) fn disposition_name(header: &str) -> Option<String> {
    for part in header.split(';').map(str::trim) {
        if let Some(v) = part.strip_prefix("filename*=") {
            let v = v.trim_matches('"');
            let encoded = v.splitn(3, '\'').nth(2).unwrap_or(v);
            if let Ok(s) = percent_encoding::percent_decode_str(encoded).decode_utf8() { return Some(s.into_owned()); }
        }
    }
    for part in header.split(';').map(str::trim) {
        if let Some(v) = part.strip_prefix("filename=") { return Some(v.trim_matches('"').to_string()); }
    }
    None
}

/// A name safe on every file system: no separators, no reserved characters, not empty.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() { "download".into() } else { trimmed.chars().take(120).collect() }
}

/// A relative path from the server, kept only if it stays inside the target folder.
pub fn safe_relative(path: &str) -> Option<PathBuf> {
    let p = Path::new(path);
    let mut out = PathBuf::new();
    for c in p.components() {
        match c { Component::Normal(s) => out.push(safe_name(&s.to_string_lossy())), _ => return None }
    }
    if out.as_os_str().is_empty() { None } else { Some(out) }
}

async fn stream_to(resp: reqwest::Response, target: &Path) -> Result<u64, String> {
    let tmp = target.with_extension("part");
    let r = stream_to_tmp(resp, &tmp, target).await;
    if r.is_err() { let _ = tokio::fs::remove_file(&tmp).await; }   // no half-written file left behind
    r
}
async fn stream_to_tmp(resp: reqwest::Response, tmp: &Path, target: &Path) -> Result<u64, String> {
    let mut f = tokio::fs::File::create(tmp).await.map_err(|e| e.to_string())?;
    let mut body = resp.bytes_stream();
    let mut n = 0u64;
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        n += chunk.len() as u64;
        f.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    f.flush().await.map_err(|e| e.to_string())?;
    drop(f);
    tokio::fs::rename(tmp, target).await.map_err(|e| e.to_string())?;
    Ok(n)
}

/// GET `url` and save it where the user chooses. Returns the saved path, or None when the dialog was cancelled.
#[tauri::command]
pub async fn download_file(app: AppHandle, url: String, suggested_name: Option<String>) -> Result<Option<String>, String> {
    let resp = crate::http().get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v["message"].as_str().map(String::from)).unwrap_or_else(|| status.to_string());
        return Err(msg);
    }
    let from_server = resp.headers().get(reqwest::header::CONTENT_DISPOSITION).and_then(|v| v.to_str().ok()).and_then(disposition_name);
    let from_url = resp.url().path_segments().and_then(|s| s.last().map(|x| percent_encoding::percent_decode_str(x).decode_utf8_lossy().into_owned()));
    let name = safe_name(&from_server.or(suggested_name).or(from_url).unwrap_or_else(|| "download".into()));
    let dialog = app.dialog().file().set_file_name(&name);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file()).await.map_err(|e| e.to_string())?;
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    stream_to(resp, &path).await?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[derive(Deserialize)]
pub struct ManifestFile { pub path: String, pub url: Option<String>, pub content: Option<String>, pub bytes: Option<u64> }

#[derive(Serialize, Default, Debug)]
pub struct SaveReport { pub dir: String, pub written: u32, pub skipped: u32, pub failed: Vec<String> }

#[derive(Serialize, Clone)]
struct Progress { done: usize, total: usize }

/// Writes `files` into `<parent>/<folder>/`. Inline files are written when they changed; downloaded files that are
/// already there with the expected size are skipped (paths name the asset version, so a changed asset is a new
/// path). Four downloads run at once; `files-progress` events report progress.
#[tauri::command]
pub async fn save_files(app: AppHandle, parent: String, folder: String, files: Vec<ManifestFile>) -> Result<SaveReport, String> {
    save_into(PathBuf::from(parent), &folder, files, move |done, total| { let _ = app.emit("files-progress", Progress { done, total }); }).await
}

pub(crate) async fn save_into(parent: PathBuf, folder: &str, files: Vec<ManifestFile>, progress: impl Fn(usize, usize)) -> Result<SaveReport, String> {
    let dir = parent.join(safe_name(folder));
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let total = files.len();
    let mut report = SaveReport { dir: dir.to_string_lossy().into_owned(), ..Default::default() };
    let client = crate::http();
    let done = std::sync::atomic::AtomicUsize::new(0);
    let results: Vec<(String, Result<bool, String>)> = stream::iter(files.into_iter())
        .map(|f| {
            let client = client.clone();
            let dir = dir.clone();
            let done = &done;
            let progress = &progress;
            async move {
                let outcome = async {
                    let rel = safe_relative(&f.path).ok_or_else(|| "unsafe path".to_string())?;
                    let target = dir.join(&rel);
                    if let Some(p) = target.parent() { tokio::fs::create_dir_all(p).await.map_err(|e| e.to_string())?; }
                    if let Some(content) = &f.content {
                        if tokio::fs::read(&target).await.ok().as_deref() == Some(content.as_bytes()) { return Ok(false); }
                        tokio::fs::write(&target, content.as_bytes()).await.map_err(|e| e.to_string())?;
                        return Ok(true);
                    }
                    let url = f.url.as_deref().ok_or_else(|| "no url".to_string())?;
                    if let (Ok(meta), Some(expected)) = (tokio::fs::metadata(&target).await, f.bytes) {
                        if expected > 0 && meta.len() == expected { return Ok(false); }
                    }
                    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
                    if !resp.status().is_success() { return Err(format!("HTTP {}", resp.status())); }
                    stream_to(resp, &target).await.map(|_| true)
                }.await;
                let n = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                progress(n, total);
                (f.path, outcome)
            }
        })
        .buffer_unordered(4)
        .collect()
        .await;
    for (path, r) in results {
        match r { Ok(true) => report.written += 1, Ok(false) => report.skipped += 1, Err(e) => report.failed.push(format!("{path}: {e}")) }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    // A tiny HTTP server: /a.png and /b.wav answer with fixed bytes, anything else 404; counts requests.
    async fn serve() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h = hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let h = h.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 2048];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let body: Option<&[u8]> = if req.starts_with("GET /a.png") { Some(b"PNGDATA-12345") } else if req.starts_with("GET /b.wav") { Some(b"WAV") } else { None };
                    let resp = match body {
                        Some(b) => { let mut r = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b.len()).into_bytes(); r.extend_from_slice(b); r }
                        None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                    };
                    let _ = sock.write_all(&resp).await;
                });
            }
        });
        (format!("http://{addr}"), hits)
    }

    #[tokio::test]
    async fn saves_a_folder_and_skips_what_is_there() {
        let (base, hits) = serve().await;
        let parent = std::env::temp_dir().join(format!("acerciae-save-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&parent);
        let files = || vec![
            ManifestFile { path: "index.html".into(), url: None, content: Some("<html>vn</html>".into()), bytes: None },
            ManifestFile { path: "assets/a-v1.png".into(), url: Some(format!("{base}/a.png")), content: None, bytes: Some(13) },
            ManifestFile { path: "audio/b.wav".into(), url: Some(format!("{base}/b.wav")), content: None, bytes: Some(3) },
            ManifestFile { path: "assets/missing.png".into(), url: Some(format!("{base}/missing.png")), content: None, bytes: Some(1) },
            ManifestFile { path: "../escape.txt".into(), url: None, content: Some("x".into()), bytes: None },
        ];
        let seen = std::sync::Mutex::new(Vec::new());
        let r = save_into(parent.clone(), "My/VN", files(), |d, t| seen.lock().unwrap().push((d, t))).await.unwrap();
        let dir = parent.join("My_VN");
        assert_eq!(r.written, 3, "{r:?}");
        assert_eq!(r.failed.len(), 2, "{r:?}");   // the 404 and the path leaving the folder
        assert_eq!(std::fs::read(dir.join("assets/a-v1.png")).unwrap(), b"PNGDATA-12345");
        assert_eq!(std::fs::read_to_string(dir.join("index.html")).unwrap(), "<html>vn</html>");
        assert!(!parent.join("escape.txt").exists());
        assert!(!dir.join("assets/missing.png").exists() && !dir.join("assets/missing.part").exists());
        assert_eq!(seen.lock().unwrap().last(), Some(&(5, 5)));
        // Saving again fetches nothing that is already there.
        let before = hits.load(std::sync::atomic::Ordering::SeqCst);
        let again = save_into(parent.clone(), "My/VN", files(), |_, _| {}).await.unwrap();
        assert_eq!(again.skipped, 3, "{again:?}");
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst) - before, 1, "only the missing file is asked for again");
        let _ = std::fs::remove_dir_all(&parent);
    }
    #[test]
    fn names_and_paths() {
        assert_eq!(disposition_name("attachment; filename=\"a.zip\"; filename*=UTF-8''%E9%9B%BE%E6%B8%AF.zip").as_deref(), Some("雾港.zip"));
        assert_eq!(disposition_name("attachment; filename=\"log.json\"").as_deref(), Some("log.json"));
        assert_eq!(safe_name("a/b:c?.zip"), "a_b_c_.zip");
        assert_eq!(safe_name(" .. "), "download");
        assert!(safe_relative("../etc/passwd").is_none());
        assert!(safe_relative("/abs").is_none());
        assert_eq!(safe_relative("assets/x-v2.png"), Some(PathBuf::from("assets").join("x-v2.png")));
    }
}
