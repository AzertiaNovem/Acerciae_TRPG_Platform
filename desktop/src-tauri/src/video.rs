//! A visual novel as a video. The app's pages draw each distinct picture of the story once (a line on screen does
//! not change while it is read); this side stores those frames, fetches the voice lines, and has FFmpeg turn them
//! into a video in which every picture lasts exactly as long as its line. Most of the video is still pictures, so
//! the lossless encoding stays small.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use tokio::io::{AsyncBufReadExt, BufReader};

const PREFIX: &str = "acerciae-video-";

#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, PathBuf>>);

fn job_dir(jobs: &State<Jobs>, job: &str) -> Result<PathBuf, String> {
    jobs.0.lock().unwrap().get(job).cloned().ok_or_else(|| "unknown video job".to_string())
}

pub fn clean_stale(tmp: &Path) {
    if let Ok(entries) = std::fs::read_dir(tmp) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with(PREFIX) { let _ = std::fs::remove_dir_all(e.path()); }
        }
    }
}

/// The bundled FFmpeg next to the app (added at packaging), else the one on PATH.
fn ffmpeg_path() -> PathBuf {
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        let bundled = dir.join(name);
        if bundled.exists() { return bundled; }
    }
    PathBuf::from(name)
}

fn command(program: &Path) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)]
    { c.creation_flags(0x0800_0000); }   // CREATE_NO_WINDOW: no console flashing up
    c.kill_on_drop(true);
    c
}

#[derive(Serialize)]
pub struct FfmpegStatus { available: bool, path: String, version: String }

#[tauri::command]
pub async fn ffmpeg_status() -> FfmpegStatus {
    let path = ffmpeg_path();
    let out = command(&path).arg("-version").output().await;
    let version = out.ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").to_string());
    FfmpegStatus { available: version.is_some(), path: path.to_string_lossy().into_owned(), version: version.unwrap_or_default() }
}

#[tauri::command]
pub fn video_begin(app: AppHandle, jobs: State<Jobs>) -> Result<String, String> {
    let id = format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let dir = app.path().temp_dir().unwrap_or_else(|_| std::env::temp_dir()).join(format!("{PREFIX}{id}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    jobs.0.lock().unwrap().insert(id.clone(), dir);
    Ok(id)
}

/// One frame as PNG bytes (the raw request body); headers `x-job` and `x-index`.
#[tauri::command]
pub fn video_frame(request: tauri::ipc::Request<'_>, jobs: State<Jobs>) -> Result<(), String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(String::from).ok_or_else(|| format!("missing {k}"));
    let dir = job_dir(&jobs, &header("x-job")?)?;
    let index: u32 = header("x-index")?.parse().map_err(|_| "bad index".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected PNG bytes".into()) };
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" { return Err("not a PNG".into()); }
    std::fs::write(dir.join(format!("frame_{index:06}.png")), bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn video_cancel(job: String, jobs: State<Jobs>) {
    if let Some(dir) = jobs.0.lock().unwrap().remove(&job) { let _ = std::fs::remove_dir_all(dir); }
}

#[derive(Deserialize)]
pub struct Segment { frame: u32, ms: u64 }
#[derive(Deserialize)]
pub struct Voice { url: String, start_ms: u64 }
#[derive(Deserialize)]
pub struct Spec { output: String, quality: String, segments: Vec<Segment>, audio: Vec<Voice>, total_ms: u64 }

#[derive(Serialize, Clone)]
struct Progress { phase: &'static str, done: u64, total: u64 }

const RATE: u64 = 48_000;
const BYTES_PER_MS: u64 = RATE * 4 / 1000;   // 16-bit stereo

fn secs(ms: u64) -> String { format!("{}.{:03}", ms / 1000, ms % 1000) }

async fn run(program: &Path, args: &[String], dir: &Path) -> Result<(), String> {
    let out = command(program).args(args).current_dir(dir).output().await.map_err(|e| format!("FFmpeg could not start ({e}). Install FFmpeg or use a build that includes it."))?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).lines().rev().take(4).collect::<Vec<_>>().join(" | ")) }
}

/// Fetches and normalizes the voice lines, lays them on a silent track at their start times, and encodes the video:
/// "lossless" = H.264 RGB at QP 0 with FLAC in MKV (bit-exact pictures, still frames cost almost nothing);
/// "compatible" = H.264 4:2:0 + AAC in MP4 (plays everywhere, visually lossless).
#[tauri::command]
pub async fn video_finish(app: AppHandle, jobs: State<'_, Jobs>, job: String, spec: Spec) -> Result<String, String> {
    let dir = job_dir(&jobs, &job)?;
    let progress = |phase: &'static str, done: u64, total: u64| { let _ = app.emit("video-progress", Progress { phase, done, total }); };
    let result = async {
        let voices = fetch_voices(&dir, &spec.audio, &progress).await?;
        encode(&dir, &spec, &voices, &progress).await
    }.await;
    jobs.0.lock().unwrap().remove(&job);
    let _ = tokio::fs::remove_dir_all(&dir).await;
    result.map(|_| spec.output.clone())
}

/// Downloads the voice lines into the work folder (`voice_<n>.src`); a line that cannot be fetched stays silent.
async fn fetch_voices(dir: &Path, audio: &[Voice], progress: &impl Fn(&'static str, u64, u64)) -> Result<Vec<(String, u64)>, String> {
    let client = crate::http();
    let mut voices: Vec<&Voice> = audio.iter().collect();
    voices.sort_by_key(|v| v.start_ms);
    let mut out = Vec::new();
    for (i, v) in voices.iter().enumerate() {
        progress("voices", i as u64, voices.len() as u64);
        let Ok(resp) = client.get(&v.url).send().await else { continue };
        if !resp.status().is_success() { continue; }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        let name = format!("voice_{i:05}.src");
        tokio::fs::write(dir.join(&name), &bytes).await.map_err(|e| e.to_string())?;
        out.push((name, v.start_ms));
    }
    Ok(out)
}

/// The frames (`frame_<n>.png`) and fetched voices in `dir` → the video at `spec.output`.
async fn encode(dir: &Path, spec: &Spec, voices: &[(String, u64)], progress: &impl Fn(&'static str, u64, u64)) -> Result<(), String> {
    if spec.segments.is_empty() { return Err("nothing to encode".into()); }
    let ffmpeg = ffmpeg_path();
    // Pictures: each frame for its line's duration (the concat format repeats the last one to close the list).
    let mut list = String::new();
    for s in &spec.segments { list += &format!("file 'frame_{:06}.png'\nduration {}\n", s.frame, secs(s.ms.max(40))); }
    list += &format!("file 'frame_{:06}.png'\n", spec.segments.last().unwrap().frame);
    tokio::fs::write(dir.join("video.txt"), list).await.map_err(|e| e.to_string())?;

    // Voices: each converted to the same PCM format, then placed after silence up to its start.
    let has_audio = !voices.is_empty();
    if has_audio {
        run(&ffmpeg, &["-hide_banner".into(), "-y".into(), "-f".into(), "lavfi".into(), "-i".into(), format!("anullsrc=r={RATE}:cl=stereo"), "-t".into(), "60".into(), "-c:a".into(), "pcm_s16le".into(), "-bitexact".into(), "-map_metadata".into(), "-1".into(), "silence.wav".into()], dir).await?;
        let mut track = String::new();
        let mut cursor = 0u64;
        let silence = |track: &mut String, mut ms: u64| { while ms > 0 { let take = ms.min(60_000); *track += &format!("file 'silence.wav'\noutpoint {}\n", secs(take)); ms -= take; } };
        for (i, (src, start)) in voices.iter().enumerate() {
            let wav = format!("voice_{i:05}.wav");
            if run(&ffmpeg, &["-hide_banner".into(), "-y".into(), "-i".into(), src.clone(), "-ar".into(), RATE.to_string(), "-ac".into(), "2".into(), "-c:a".into(), "pcm_s16le".into(), "-bitexact".into(), "-map_metadata".into(), "-1".into(), wav.clone()], dir).await.is_err() { continue; }
            let len = tokio::fs::metadata(dir.join(&wav)).await.map(|m| m.len()).unwrap_or(44);
            let dur = len.saturating_sub(44) / BYTES_PER_MS;
            if *start > cursor { silence(&mut track, start - cursor); cursor = *start; }
            track += &format!("file '{wav}'\n");
            cursor += dur;
        }
        if spec.total_ms > cursor { silence(&mut track, spec.total_ms - cursor); }
        if track.is_empty() { silence(&mut track, spec.total_ms.max(40)); }
        tokio::fs::write(dir.join("audio.txt"), track).await.map_err(|e| e.to_string())?;
    }

    let mut args: Vec<String> = ["-hide_banner", "-y", "-nostdin", "-progress", "pipe:1", "-nostats", "-f", "concat", "-safe", "0", "-i", "video.txt"].iter().map(|s| s.to_string()).collect();
    if has_audio { args.extend(["-f", "concat", "-safe", "0", "-i", "audio.txt", "-map", "0:v", "-map", "1:a"].iter().map(|s| s.to_string())); }
    let lossless = spec.quality == "lossless";
    let codec: &[&str] = if lossless {
        &["-c:v", "libx264rgb", "-qp", "0", "-preset", "veryslow", "-pix_fmt", "bgr24", "-fps_mode", "vfr", "-c:a", "flac"]
    } else {
        &["-c:v", "libx264", "-crf", "14", "-preset", "slow", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-r", "30", "-fps_mode", "cfr", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    };
    args.extend(codec.iter().map(|s| s.to_string()));
    args.extend(["-t".to_string(), secs(spec.total_ms.max(40)), spec.output.clone()]);

    let mut child = command(&ffmpeg).args(&args).current_dir(dir).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn()
        .map_err(|e| format!("FFmpeg could not start ({e}). Install FFmpeg or use a build that includes it."))?;
    let stderr = child.stderr.take().unwrap();
    let errors = tokio::spawn(async move { let mut lines = BufReader::new(stderr).lines(); let mut tail = Vec::new(); while let Ok(Some(l)) = lines.next_line().await { tail.push(l); if tail.len() > 6 { tail.remove(0); } } tail.join(" | ") });
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(us) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")).and_then(|v| v.parse::<u64>().ok()) {
            progress("encode", (us / 1000).min(spec.total_ms), spec.total_ms);
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let tail = errors.await.unwrap_or_default();
    if !status.success() { let _ = tokio::fs::remove_file(&spec.output).await; return Err(format!("FFmpeg failed: {tail}")); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn ff(dir: &Path, args: &str) { assert!(command(&ffmpeg_path()).args(args.split(' ')).current_dir(dir).output().await.unwrap().status.success(), "ffmpeg {args}"); }
    async fn probe(path: &Path, entries: &str) -> String {
        let o = command(Path::new("ffprobe")).args(["-v", "error", "-show_entries", entries, "-of", "default=nw=1", &path.to_string_lossy()]).output().await.unwrap();
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    // Three pictures and one voice line → a video as long as the timeline, with the voice in it; the lossless one
    // keeps every picture exactly and stores each still once.
    #[tokio::test]
    async fn encodes_stills_and_voices() {
        if !ffmpeg_status().await.available { eprintln!("ffmpeg not installed; skipped"); return; }
        let dir = std::env::temp_dir().join(format!("{PREFIX}test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (i, c) in ["red", "green", "blue"].iter().enumerate() { ff(&dir, &format!("-y -f lavfi -i color={c}:s=320x180 -frames:v 1 frame_{i:06}.png")).await; }
        ff(&dir, "-y -f lavfi -i sine=frequency=440:duration=1.5 -c:a libmp3lame -f mp3 voice_00000.src").await;
        let spec = |out: &str, quality: &str| Spec { output: dir.join(out).to_string_lossy().into_owned(), quality: quality.into(),
            segments: vec![Segment { frame: 0, ms: 2000 }, Segment { frame: 1, ms: 3000 }, Segment { frame: 2, ms: 1500 }], audio: vec![], total_ms: 6500 };
        let voices = vec![("voice_00000.src".to_string(), 2200u64)];
        let none = |_: &'static str, _: u64, _: u64| {};
        let lossless = spec("out.mkv", "lossless");
        encode(&dir, &lossless, &voices, &none).await.unwrap();
        let fmt = probe(Path::new(&lossless.output), "format=duration").await;
        let secs: f64 = fmt.trim().trim_start_matches("duration=").parse().unwrap();
        assert!((secs - 6.5).abs() < 0.3, "duration {secs}");
        let streams = probe(Path::new(&lossless.output), "stream=codec_name").await;
        assert!(streams.contains("h264") && streams.contains("flac"), "{streams}");
        let o = command(Path::new("ffprobe")).args(["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1", &lossless.output]).output().await.unwrap();
        let frames = String::from_utf8_lossy(&o.stdout).into_owned();
        let n: u32 = frames.trim().trim_start_matches("nb_read_frames=").parse().unwrap_or(999);
        assert!(n <= 4, "each still is stored once, got {n} frames");
        // The middle picture comes back pixel-exact.
        ff(&dir, &format!("-y -ss 3.5 -i {} -frames:v 1 back.png", lossless.output)).await;
        let a = command(&ffmpeg_path()).args(["-v", "error", "-i", "back.png", "-i", "frame_000001.png", "-lavfi", "psnr", "-f", "null", "-"]).current_dir(&dir).output().await.unwrap();
        let log = String::from_utf8_lossy(&a.stderr).into_owned() + &String::from_utf8_lossy(&a.stdout);
        assert!(log.is_empty() || log.contains("inf"), "not lossless: {log}");
        let compatible = spec("out.mp4", "compatible");
        encode(&dir, &compatible, &voices, &none).await.unwrap();
        let streams = probe(Path::new(&compatible.output), "stream=codec_name").await;
        assert!(streams.contains("h264") && streams.contains("aac"), "{streams}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
