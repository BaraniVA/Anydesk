#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod commands;
mod input;
mod server;

fn main() {
    // On Windows, try to add a firewall rule for the signaling server port range.
    // This runs silently and is a no-op if the rule already exists or if not admin.
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

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(commands::AppState::new())
        .manage(input::EnigoState::new())
        .invoke_handler(tauri::generate_handler![
            commands::start_server,
            commands::stop_server,
            commands::get_local_ip,
            capture::capture_frame,
            capture::get_screen_size,
            input::inject_mouse,
            input::inject_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
