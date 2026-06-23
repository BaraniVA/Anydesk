use std::sync::Mutex;
use tokio_util::sync::CancellationToken;
use crate::server::start_signaling_server;

pub struct AppState {
    pub cancel_token: Mutex<Option<CancellationToken>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            cancel_token: Mutex::new(None),
        }
    }
}

#[tauri::command]
pub async fn start_server(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let mut did_cancel = false;
    // Stop any existing signaling server before spinning up a new one
    {
        let mut token_guard = state.cancel_token.lock().map_err(|e| format!("Mutex error: {}", e))?;
        if let Some(token) = token_guard.take() {
            token.cancel();
            did_cancel = true;
        }
    }
    
    if did_cancel {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    
    let token = CancellationToken::new();
    let addr = start_signaling_server(token.clone()).await?;
    
    {
        let mut token_guard = state.cancel_token.lock().map_err(|e| format!("Mutex error: {}", e))?;
        *token_guard = Some(token);
    }
    
    Ok(addr)
}

#[tauri::command]
pub fn stop_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut token_guard = state.cancel_token.lock().map_err(|e| format!("Mutex error: {}", e))?;
    if let Some(token) = token_guard.take() {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub fn get_local_ip() -> Result<String, String> {
    match local_ip_address::local_ip() {
        Ok(ip) => Ok(ip.to_string()),
        Err(e) => Err(format!("Failed to retrieve local IP: {}", e)),
    }
}
