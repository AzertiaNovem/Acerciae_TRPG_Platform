//! Acerciae desktop: the web app's own pages in the system web view, plus what a browser tab cannot do well —
//! native "Save as" downloads, a visual novel saved file by file into a folder, and a visual novel exported as a
//! video with FFmpeg.

mod files;
mod video;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(video::Jobs::default())
        .invoke_handler(tauri::generate_handler![
            files::download_file,
            files::save_files,
            video::ffmpeg_status,
            video::video_begin,
            video::video_frame,
            video::video_finish,
            video::video_cancel,
        ])
        .setup(|app| {
            // Leftover video work folders from a crash are removed at start.
            video::clean_stale(&app.path().temp_dir().unwrap_or_else(|_| std::env::temp_dir()));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Acerciae desktop app");
}

/// The HTTP client every download uses: redirects followed (the server sends public media straight to object
/// storage), a generous timeout for large files.
pub(crate) fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("Acerciae-Desktop/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(30 * 60))
        .build()
        .expect("http client")
}
