use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone)]
pub struct Peer {
    pub tx: mpsc::UnboundedSender<Message>,
    pub password: String,
}

pub type PeerMap = Arc<DashMap<String, Peer>>;

#[derive(Clone)]
pub struct AppState {
    pub peers: PeerMap,
    /// The first peer to connect is the "host" (the machine running the tunnel).
    /// Remote viewers send connect-request with to="host" which resolves to this ID.
    pub host_id: Arc<std::sync::Mutex<Option<String>>>,
}

pub async fn start_signaling_server(cancel_token: CancellationToken) -> Result<String, String> {
    let state = AppState {
        peers: Arc::new(DashMap::new()),
        host_id: Arc::new(std::sync::Mutex::new(None)),
    };

    let app = Router::new()
        .route("/", get(ws_handler))
        .with_state(state);

    // Try binding to ports 3000-3004 (in case some are already in use)
    let mut listener_opt = None;
    let mut bound_addr = String::new();
    for port in 3000..=3004 {
        let addr = format!("0.0.0.0:{}", port);
        match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => {
                bound_addr = addr;
                listener_opt = Some(l);
                break;
            }
            Err(_) => continue,
        }
    }

    let listener = listener_opt
        .ok_or_else(|| "Failed to bind to any signaling port (3000-3004)".to_string())?;

    // Spawn the axum server in a background task
    tokio::spawn(async move {
        let server = axum::serve(listener, app);
        let graceful = server.with_graceful_shutdown(async move {
            cancel_token.cancelled().await;
        });

        if let Err(e) = graceful.await {
            eprintln!("Signaling server error: {}", e);
        }
    });

    Ok(bound_addr)
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    println!("[Server] ws_handler: Incoming connection upgrade request");
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Generate unique 9-digit peer ID
    let num = Uuid::new_v4().as_u128() % 900_000_000 + 100_000_000;
    let peer_id = format!("{}", num);

    // Generate random 5-digit password
    let pwd_num = Uuid::new_v4().as_u128() % 90_000 + 10_000;
    let password = format!("{}", pwd_num);

    println!("[Server] upgraded socket for peer_id: {} with password: {}", peer_id, password);

    // Create a channel for sending messages to this peer
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Store Peer in DashMap
    let peer = Peer {
        tx,
        password: password.clone(),
    };
    state.peers.insert(peer_id.clone(), peer);

    // First peer to connect is the "host" (the machine running the tunnel)
    {
        let mut host = state.host_id.lock().unwrap();
        if host.is_none() {
            *host = Some(peer_id.clone());
        }
    }

    // Send the init notification to the client
    let init_msg = serde_json::json!({
        "type": "init",
        "id": peer_id,
        "password": password
    });
    if let Ok(init_str) = serde_json::to_string(&init_msg) {
        println!("[Server] sending init to peer_id {}: {}", peer_id, init_str);
        let _ = ws_sender.send(Message::Text(init_str)).await;
    }

    // Spawn task to forward channel messages to the WebSocket
    let mut ws_send_task = tokio::spawn({
        let peer_id = peer_id.clone();
        async move {
            while let Some(msg) = rx.recv().await {
                if ws_sender.send(msg).await.is_err() {
                    break;
                }
            }
            peer_id
        }
    });

    // Handle incoming messages from this client
    let mut ws_recv_task = tokio::spawn({
        let peer_id = peer_id.clone();
        let peers = state.peers.clone();
        let state_clone = state.clone();
        async move {
            while let Some(Ok(msg)) = ws_receiver.next().await {
                if let Message::Text(text) = msg {
                    if let Ok(mut json_val) = serde_json::from_str::<Value>(&text) {
                        if let Some(msg_type) = json_val.get("type").and_then(|v| v.as_str()) {
                            match msg_type {
                                "ping" => {
                                    // Send pong directly back
                                    let pong = serde_json::json!({ "type": "pong" });
                                    if let Some(peer) = peers.get(&peer_id) {
                                        let _ = peer.tx.send(Message::Text(pong.to_string()));
                                    }
                                }
                                "update-password" => {
                                    // Let client update its password (e.g. refresh password button)
                                    if let Some(new_pwd_val) = json_val.get("password").and_then(|v| v.as_str()) {
                                        if let Some(mut peer_entry) = peers.get_mut(&peer_id) {
                                            peer_entry.password = new_pwd_val.to_string();
                                            
                                            // Acknowledge update
                                            let ack = serde_json::json!({
                                                "type": "update-password-ack",
                                                "success": true,
                                                "password": new_pwd_val
                                            });
                                            let _ = peer_entry.tx.send(Message::Text(ack.to_string()));
                                        }
                                    }
                                }
                                "connect-request" => {
                                    // A viewer is trying to connect to a partner
                                    if let Some(to_val) = json_val.get("to").and_then(|v| v.as_str()) {
                                        // Resolve "host" to the actual host peer ID (for tunnel connections)
                                        let target_id = if to_val == "host" {
                                            match state_clone.host_id.lock().unwrap().clone() {
                                                Some(id) => id,
                                                None => {
                                                    let resp = serde_json::json!({
                                                        "type": "connect-response",
                                                        "success": false,
                                                        "error": "No host registered on this server"
                                                    });
                                                    if let Some(p) = peers.get(&peer_id) {
                                                        let _ = p.tx.send(Message::Text(resp.to_string()));
                                                    }
                                                    continue;
                                                }
                                            }
                                        } else {
                                            to_val.replace(' ', "")
                                        };
                                        let password_val = json_val.get("password").and_then(|v| v.as_str()).unwrap_or("");
                                        
                                        if let Some(target_peer) = peers.get(&target_id) {
                                            if target_peer.password == password_val {
                                                // Password matches! Relay success to viewer
                                                let response = serde_json::json!({
                                                    "type": "connect-response",
                                                    "success": true,
                                                    "from": target_id
                                                });
                                                if let Some(sender_peer) = peers.get(&peer_id) {
                                                    let _ = sender_peer.tx.send(Message::Text(response.to_string()));
                                                }
                                                
                                                // Notify host of incoming session
                                                let incoming = serde_json::json!({
                                                    "type": "incoming-session",
                                                    "from": peer_id.clone()
                                                });
                                                let _ = target_peer.tx.send(Message::Text(incoming.to_string()));
                                            } else {
                                                // Incorrect password
                                                let response = serde_json::json!({
                                                    "type": "connect-response",
                                                    "success": false,
                                                    "error": "Incorrect password"
                                                });
                                                if let Some(sender_peer) = peers.get(&peer_id) {
                                                    let _ = sender_peer.tx.send(Message::Text(response.to_string()));
                                                }
                                            }
                                        } else {
                                            // Partner offline
                                            let response = serde_json::json!({
                                                "type": "connect-response",
                                                "success": false,
                                                "error": "Partner is offline or not found"
                                            });
                                            if let Some(sender_peer) = peers.get(&peer_id) {
                                                let _ = sender_peer.tx.send(Message::Text(response.to_string()));
                                            }
                                        }
                                    }
                                }
                                _ => {
                                    // Relay signaling messages (offer, answer, ice, etc.)
                                    if let Some(to_val) = json_val.get("to").and_then(|v| v.as_str()) {
                                        let target_id = to_val.replace(' ', ""); // strip spaces
                                        // Set/overwrite "from" to the sender's ID
                                        if let Some(obj) = json_val.as_object_mut() {
                                            obj.insert("from".to_string(), Value::String(peer_id.clone()));
                                        }

                                        // Lookup target peer and relay
                                        if let Some(target_peer) = peers.get(&target_id) {
                                            let _ = target_peer.tx.send(Message::Text(json_val.to_string()));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            peer_id
        }
    });

    // Wait for either send task or receive task to complete, then clean up
    tokio::select! {
        res = &mut ws_send_task => {
            if let Ok(id) = res {
                println!("[Server] ws_send_task finished for peer_id: {}. Removing from peers.", id);
                state.peers.remove(&id);
            }
        }
        res = &mut ws_recv_task => {
            if let Ok(id) = res {
                println!("[Server] ws_recv_task finished for peer_id: {}. Removing from peers.", id);
                state.peers.remove(&id);
            }
        }
    }
}
