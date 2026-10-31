//! Provider API keys for Open Log Studio: in the system keychain (macOS Keychain, Windows Credential Manager,
//! Secret Service on Linux). Where no keychain is available (some Linux desktops), a file only the user can read
//! in the app's data folder is used instead.

use tauri::{AppHandle, Manager};

const SERVICE: &str = "app.acerciae.desktop";

fn valid(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') { Err("invalid secret name".into()) } else { Ok(()) }
}
fn fallback(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("secrets");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)); }
    Ok(dir.join(name))
}

#[tauri::command]
pub fn secret_set(app: AppHandle, name: String, value: String) -> Result<(), String> {
    valid(&name)?;
    if keyring::Entry::new(SERVICE, &name).and_then(|e| e.set_password(&value)).is_ok() { let _ = std::fs::remove_file(fallback(&app, &name)?); return Ok(()); }
    let path = fallback(&app, &name)?;
    std::fs::write(&path, value.as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
pub fn secret_get(app: AppHandle, name: String) -> Result<Option<String>, String> {
    valid(&name)?;
    if let Ok(v) = keyring::Entry::new(SERVICE, &name).and_then(|e| e.get_password()) { return Ok(Some(v)); }
    Ok(std::fs::read_to_string(fallback(&app, &name)?).ok())
}

#[tauri::command]
pub fn secret_delete(app: AppHandle, name: String) -> Result<(), String> {
    valid(&name)?;
    let _ = keyring::Entry::new(SERVICE, &name).and_then(|e| e.delete_credential());
    let _ = std::fs::remove_file(fallback(&app, &name)?);
    Ok(())
}
