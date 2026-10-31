//! Open Log Studio projects on disk: <app data>/projects/<id>/project.json (everything the studio knows),
//! meta.json (title and dates for the list) and assets/ (images and voice lines the project uses).

use crate::files::{safe_name, safe_relative, SaveReport};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("projects");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}
/// A project folder; ids are UUIDs, nothing else is accepted.
fn project_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.len() != 36 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') { return Err("invalid project id".into()); }
    Ok(root(app)?.join(id))
}
fn asset_file(app: &AppHandle, project: &str, rel: &str) -> Result<PathBuf, String> {
    let rel = safe_relative(rel).ok_or("invalid asset path")?;
    if !rel.starts_with("assets") { return Err("not an asset path".into()); }
    Ok(project_dir(app, project)?.join(rel))
}
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn project_list(app: AppHandle) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(root(&app)?).map_err(|e| e.to_string())?.flatten() {
        if let Ok(text) = std::fs::read_to_string(e.path().join("meta.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) { out.push(v); }
        }
    }
    out.sort_by(|a, b| b["updated_at"].as_str().unwrap_or("").cmp(a["updated_at"].as_str().unwrap_or("")));
    Ok(out)
}

#[tauri::command]
pub fn project_load(app: AppHandle, id: String) -> Result<String, String> {
    std::fs::read_to_string(project_dir(&app, &id)?.join("project.json")).map_err(|e| e.to_string())
}

/// Saves the project (JSON text) and its list entry; atomic, so a crash never leaves half a file.
#[tauri::command]
pub fn project_save(app: AppHandle, id: String, data: String, meta: Value) -> Result<(), String> {
    serde_json::from_str::<Value>(&data).map_err(|e| format!("not JSON: {e}"))?;
    let dir = project_dir(&app, &id)?;
    std::fs::create_dir_all(dir.join("assets")).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("project.json"), data.as_bytes())?;
    write_atomic(&dir.join("meta.json"), serde_json::to_string(&meta).map_err(|e| e.to_string())?.as_bytes())
}

#[tauri::command]
pub fn project_delete(app: AppHandle, id: String) -> Result<(), String> {
    let dir = project_dir(&app, &id)?;
    if dir.exists() { std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?; }
    Ok(())
}

const EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "wav", "mp3", "ogg", "m4a", "flac"];
fn new_asset_name(ext: &str) -> Result<String, String> {
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    if !EXTS.contains(&ext.as_str()) { return Err(format!("unsupported file type .{ext}")); }
    Ok(format!("assets/{}.{}", uuid::Uuid::new_v4().simple(), ext))
}

/// Stores bytes (the raw request body) as a new asset of a project; headers `x-project` and `x-ext`.
/// Returns its path inside the project ("assets/<id>.<ext>").
#[tauri::command]
pub fn asset_write(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(String::from).ok_or_else(|| format!("missing {k}"));
    let project = header("x-project")?;
    let rel = new_asset_name(&header("x-ext")?)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected file bytes".into()) };
    if bytes.len() > 200 * 1024 * 1024 { return Err("file too large".into()); }
    let path = project_dir(&app, &project)?.join(&rel);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    write_atomic(&path, bytes)?;
    Ok(rel)
}

/// Copies a file the user picked into the project's assets.
#[tauri::command]
pub fn asset_import(app: AppHandle, project: String, source: String) -> Result<String, String> {
    let src = PathBuf::from(&source);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("");
    let rel = new_asset_name(ext)?;
    let path = project_dir(&app, &project)?.join(&rel);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::copy(&src, &path).map_err(|e| e.to_string())?;
    Ok(rel)
}

/// An asset's bytes (for drawing video frames and building bundles).
#[tauri::command]
pub fn asset_read(app: AppHandle, project: String, path: String) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(std::fs::read(asset_file(&app, &project, &path)?).map_err(|e| e.to_string())?))
}

/// An asset's absolute path (the page shows it through the asset protocol).
#[tauri::command]
pub fn asset_path(app: AppHandle, project: String, path: String) -> Result<String, String> {
    Ok(asset_file(&app, &project, &path)?.to_string_lossy().into_owned())
}

#[derive(Deserialize)]
pub struct ExportFile { path: String, content: Option<String>, asset: Option<String> }

/// Writes files into <parent>/<folder>/: text written as given, project assets copied.
#[tauri::command]
pub fn export_files(app: AppHandle, project: String, parent: String, folder: String, files: Vec<ExportFile>) -> Result<SaveReport, String> {
    let dir = PathBuf::from(parent).join(safe_name(&folder));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut report = SaveReport { dir: dir.to_string_lossy().into_owned(), ..Default::default() };
    for f in files {
        let result = (|| -> Result<(), String> {
            let rel = safe_relative(&f.path).ok_or("unsafe path")?;
            let target = dir.join(rel);
            if let Some(p) = target.parent() { std::fs::create_dir_all(p).map_err(|e| e.to_string())?; }
            if let Some(c) = &f.content { return std::fs::write(&target, c.as_bytes()).map_err(|e| e.to_string()); }
            let src = asset_file(&app, &project, f.asset.as_deref().ok_or("nothing to write")?)?;
            std::fs::copy(src, &target).map(|_| ()).map_err(|e| e.to_string())
        })();
        match result { Ok(()) => report.written += 1, Err(e) => report.failed.push(format!("{}: {e}", f.path)) }
    }
    Ok(report)
}

/// Opens print-ready HTML in its own window and the system print dialog there ("Save as PDF").
#[tauri::command]
pub async fn print_html(app: AppHandle, html: String, title: String) -> Result<(), String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("print");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Old print files go; the one for this window stays until the next print.
    if let Ok(entries) = std::fs::read_dir(&dir) { for e in entries.flatten() { let _ = std::fs::remove_file(e.path()); } }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let file = dir.join(format!("{id}.html"));
    std::fs::write(&file, html.as_bytes()).map_err(|e| e.to_string())?;
    let encoded = percent_encoding::utf8_percent_encode(&file.to_string_lossy(), percent_encoding::NON_ALPHANUMERIC).to_string();
    let url = if cfg!(windows) { format!("http://asset.localhost/{encoded}") } else { format!("asset://localhost/{encoded}") };
    let url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    tauri::WebviewWindowBuilder::new(&app, format!("print-{id}"), tauri::WebviewUrl::External(url))
        .title(title)
        .inner_size(900.0, 1000.0)
        .on_page_load(|w, payload| { if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) { let _ = w.print(); } })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Writes one text file the user chose in a save dialog (HTML, JSON, text exports).
#[tauri::command]
pub fn save_text(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || p.file_name().is_none() { return Err("choose where to save the file".into()); }
    std::fs::write(p, content.as_bytes()).map_err(|e| e.to_string())
}
