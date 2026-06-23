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

pub type PeerMap = Arc<DashMap<String, mpsc::UnboundedSender<Message>>>;

#[derive(Clone)]
pub struct AppState {
    pub peers: PeerMap,
}

pub async fn start_signaling_server(cancel_token: CancellationToken) -> Result<String, String> {
    let state = AppState {
        peers: Arc::new(DashMap::new()),
    };

    let app = Router::new()
        .route("/", get(ws_handler))
        .with_state(state);

    // Try binding to port 3000, fallback to 3001-3010 if occupied
    let mut listener = None;
    let mut bound_port = 0u16;
    
    for port in 3000..=3010 {
        let addr = format!("0.0.0.0:{}", port);
        match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => {
                listener = Some(l);
                bound_port = port;
                break;
            }
            Err(_) => continue,
        }
    }
    
    let listener = listener.ok_or_else(|| "Failed to bind to any port in range 3000-3010".to_string())?;

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

    // Retrieve local LAN IP to display to the user
    let ip = match local_ip_address::local_ip() {
        Ok(ip_addr) => ip_addr.to_string(),
        Err(_) => "127.0.0.1".to_string(),
    };

    Ok(format!("{}:{}", ip, bound_port))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Generate unique 9-digit peer ID
    let num = Uuid::new_v4().as_u128() % 900_000_000 + 100_000_000;
    let peer_id = format!("{}", num);

    // Create a channel for sending messages to this peer
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Store sender handle in DashMap
    state.peers.insert(peer_id.clone(), tx);

    // Send the registered notification to the client
    let reg_msg = serde_json::json!({
        "type": "registered",
        "id": peer_id
    });
    if let Ok(reg_str) = serde_json::to_string(&reg_msg) {
        let _ = ws_sender.send(Message::Text(reg_str)).await;
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
        async move {
            while let Some(Ok(msg)) = ws_receiver.next().await {
                if let Message::Text(text) = msg {
                    if let Ok(mut json_val) = serde_json::from_str::<Value>(&text) {
                        if let Some(msg_type) = json_val.get("type").and_then(|v| v.as_str()) {
                            match msg_type {
                                "ping" => {
                                    // Send pong directly back
                                    let pong = serde_json::json!({ "type": "pong" });
                                    if let Some(sender) = peers.get(&peer_id) {
                                        let _ = sender.send(Message::Text(pong.to_string()));
                                    }
                                }
                                _ => {
                                    // Relay signaling messages (offer, answer, ice, request-connection, connection-response)
                                    if let Some(to_val) = json_val.get("to").and_then(|v| v.as_str()) {
                                        let target_id = to_val.to_string();
                                        // Set/overwrite "from" to the sender's ID
                                        if let Some(obj) = json_val.as_object_mut() {
                                            obj.insert("from".to_string(), Value::String(peer_id.clone()));
                                        }

                                        // Lookup target peer and relay. Fallback to the other peer in 1-to-1 if not matched.
                                        if let Some(target_sender) = peers.get(&target_id) {
                                            let _ = target_sender.send(Message::Text(json_val.to_string()));
                                        } else {
                                            for entry in peers.iter() {
                                                if entry.key() != &peer_id {
                                                    let _ = entry.value().send(Message::Text(json_val.to_string()));
                                                    break;
                                                }
                                            }
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
                state.peers.remove(&id);
            }
        }
        res = &mut ws_recv_task => {
            if let Ok(id) = res {
                state.peers.remove(&id);
            }
        }
    }
}
