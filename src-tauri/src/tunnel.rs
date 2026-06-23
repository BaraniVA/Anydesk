use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;

/// Manages the cloudflared quick-tunnel lifecycle.
pub struct TunnelState {
    pub url: Mutex<Option<String>>,
    pub subdomain: Mutex<Option<String>>,
    pub status: Mutex<String>,
    pub child: Mutex<Option<std::process::Child>>,
}

impl TunnelState {
    pub fn new() -> Self {
        Self {
            url: Mutex::new(None),
            subdomain: Mutex::new(None),
            status: Mutex::new("initializing".into()),
            child: Mutex::new(None),
        }
    }
}

fn cloudflared_path() -> PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .join("cloudflared.exe")
}

/// Download cloudflared binary using Windows built-in curl.
fn download_cloudflared(dest: &PathBuf) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
    let status = Command::new("curl")
        .args(["-sL", "--retry", "3", "-o", dest.to_str().unwrap(), url])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .status()
        .map_err(|e| format!("curl failed: {}", e))?;
    if !status.success() {
        return Err("Download failed".into());
    }
    Ok(())
}

/// Extract the trycloudflare.com URL from a line of cloudflared output.
fn extract_tunnel_url(line: &str) -> Option<String> {
    for word in line.split_whitespace() {
        let clean = word.trim_matches(|c: char| c == '|' || c == ' ');
        if clean.contains(".trycloudflare.com") && clean.starts_with("https://") {
            return Some(clean.to_string());
        }
    }
    None
}

/// Blocking function that downloads cloudflared (if needed), spawns the tunnel,
/// and reads stderr until the public URL is found. Designed to run in a std::thread.
pub fn run_tunnel_blocking(ts: &TunnelState, port: u16) {
    let cf = cloudflared_path();

    // Download if missing
    if !cf.exists() {
        *ts.status.lock().unwrap() = "downloading_cloudflared".into();
        if let Err(e) = download_cloudflared(&cf) {
            *ts.status.lock().unwrap() = format!("download_failed:{}", e);
            return;
        }
    }

    *ts.status.lock().unwrap() = "starting_tunnel".into();

    use std::os::windows::process::CommandExt;
    let child = match Command::new(&cf)
        .args(["tunnel", "--url", &format!("http://localhost:{}", port)])
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .stdin(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            *ts.status.lock().unwrap() = format!("spawn_failed:{}", e);
            return;
        }
    };

    // Store the child process handle so we can terminate it later
    if let Ok(mut child_guard) = ts.child.lock() {
        *child_guard = Some(child);
    }

    // Read stderr line-by-line looking for the tunnel URL
    // We need to retrieve a handle to the child process (or stdin/stderr) to read it.
    // However, since we stored the child in ts.child, we can take the stderr here directly before storing, or read it while it's stored.
    // Wait, let's retrieve stderr before storing or store it and read it from child.
    // Let's grab the stderr of the spawned child. Since we did `child.stderr.take()`, we can do it before storing it.
    let mut child_stderr = None;
    if let Ok(mut child_guard) = ts.child.lock() {
        if let Some(ref mut c) = *child_guard {
            child_stderr = c.stderr.take();
        }
    }

    if let Some(stderr) = child_stderr {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(found_url) = extract_tunnel_url(&line) {
                let sub = found_url
                    .replace("https://", "")
                    .replace(".trycloudflare.com", "");
                *ts.url.lock().unwrap() = Some(found_url);
                *ts.subdomain.lock().unwrap() = Some(sub);
                *ts.status.lock().unwrap() = "connected".into();
                // Keep reading so the pipe doesn't fill up and block cloudflared
            }
        }
    }

    // If we get here, cloudflared exited
    let current = ts.status.lock().unwrap().clone();
    if current != "connected" {
        *ts.status.lock().unwrap() = "tunnel_exited".into();
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────

#[tauri::command]
pub fn get_tunnel_info(state: tauri::State<'_, std::sync::Arc<TunnelState>>) -> Result<serde_json::Value, String> {
    let st = state.status.lock().map_err(|e| e.to_string())?.clone();
    let u = state.url.lock().map_err(|e| e.to_string())?.clone();
    let s = state.subdomain.lock().map_err(|e| e.to_string())?.clone();
    Ok(serde_json::json!({ "status": st, "url": u, "subdomain": s }))
}
