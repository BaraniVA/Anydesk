// Hide the console window on Windows release builds.
// This prevents the CLI terminal from appearing alongside the GUI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use remotelink::capture;
use remotelink::commands;
use remotelink::input;
use remotelink::server;
use remotelink::tunnel;

use tauri::Manager;

fn main() {
    // On Windows, try to add a firewall rule for the signaling server port range.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("netsh")
            .args([
                "advfirewall", "firewall", "add", "rule",
                "name=RemoteLink Signaling",
                "dir=in",
                "action=allow",
                "protocol=TCP",
                "localport=3000-3010",
                "profile=private",
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
    }

    // Create tunnel state wrapped in Arc for thread sharing
    let tunnel_state = std::sync::Arc::new(tunnel::TunnelState::new());
    let ts_clone = tunnel_state.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(commands::AppState::new())
        .manage(input::EnigoState::new())
        .manage(tunnel_state)
        .setup(move |_app| {
            // 1. Start the local signaling server, get the bound port
            // 2. Start cloudflared tunnel on that port
            let ts = ts_clone;
            tauri::async_runtime::spawn(async move {
                let token = tokio_util::sync::CancellationToken::new();
                match server::start_signaling_server(token).await {
                    Ok(addr) => {
                        // Parse port from "0.0.0.0:3001"
                        let port: u16 = addr.split(':').last()
                            .and_then(|p| p.parse().ok())
                            .unwrap_or(3000);

                        // Spawn cloudflared tunnel in a background thread
                        // (blocking I/O — reads cloudflared stderr)
                        std::thread::spawn(move || {
                            tunnel::run_tunnel_blocking(
                                &ts,
                                port,
                            );
                        });
                    }
                    Err(e) => {
                        eprintln!("Signaling server failed: {}", e);
                        *ts.status.lock().unwrap() = format!("server_failed:{}", e);
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_server,
            commands::stop_server,
            commands::get_local_ip,
            capture::capture_frame,
            capture::get_screen_size,
            input::inject_mouse,
            input::inject_key,
            tunnel::get_tunnel_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle: &tauri::AppHandle, event: tauri::RunEvent| match event {
        tauri::RunEvent::Exit => {
            let state = app_handle.state::<std::sync::Arc<tunnel::TunnelState>>();
            let ts = state.inner().clone();
            if let Ok(mut child_guard) = ts.child.lock() {
                if let Some(mut child) = child_guard.take() {
                    println!("[Tauri Exit] Terminating cloudflared process");
                    let _ = child.kill();
                }
            };
        }
        _ => {}
    });
}
