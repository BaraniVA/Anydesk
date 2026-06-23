const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

// --- Window Dragging and Controls ---
const appWindow = getCurrentWindow();
document.getElementById("titlebar-minimize").addEventListener("click", () => appWindow.minimize());
document.getElementById("titlebar-maximize").addEventListener("click", () => appWindow.toggleMaximize());
document.getElementById("titlebar-close").addEventListener("click", () => appWindow.close());

document.getElementById("titlebar").addEventListener("mousedown", (e) => {
  if (!e.target.closest(".titlebar-btn")) {
    appWindow.startDragging();
  }
});

// --- State Variables ---
let ws = null;                  // Signaling WebSocket
let myId = null;                // 9-digit client ID
let peerId = null;              // Remote peer ID
let pc = null;                  // RTCPeerConnection
let streamChannel = null;       // DataChannel for screen frames
let controlChannel = null;      // DataChannel for input events
let chatChannel = null;         // DataChannel for chat
let fileChannel = null;         // DataChannel for file transfers

let isHost = false;             // True if host, False if viewer
let captureLoop = null;         // Interval ID for screen capture
let pingLoop = null;            // Interval ID for RTT pings
let unreadChatCount = 0;        // Unread chat messages count
let tempRequesterId = null;     // Temp requester ID on host side

// File Transfer States
let currentOutgoingTransfer = null;
let currentIncomingTransfer = null;

// --- DOM References ---
const screenHome = document.getElementById("screen-home");
const screenHostWaiting = document.getElementById("screen-host-waiting");
const screenActiveSession = document.getElementById("screen-active-session");

const btnStartHosting = document.getElementById("btn-start-hosting");
const btnConnectRemote = document.getElementById("btn-connect-remote");
const inputConnectAddress = document.getElementById("input-connect-address");
const displayHostAddress = document.getElementById("display-host-address");

const btnCopyAddress = document.getElementById("btn-copy-address");
const btnCopyTunnelCmd = document.getElementById("btn-copy-tunnel-cmd");
const btnStopHosting = document.getElementById("btn-stop-hosting");

const modalIncomingRequest = document.getElementById("modal-incoming-request");
const requestPeerIdDisp = document.getElementById("request-peer-id");
const btnRequestAccept = document.getElementById("btn-request-accept");
const btnRequestDeny = document.getElementById("btn-request-deny");

const screenImg = document.getElementById("screen-img");
const viewerContainer = document.getElementById("viewer-container");
const viewerToolbar = document.getElementById("viewer-toolbar");

const btnViewerDisconnect = document.getElementById("btn-viewer-disconnect");
const btnViewerFiles = document.getElementById("btn-viewer-files");
const btnViewerChat = document.getElementById("btn-viewer-chat");

const btnHostDisconnect = document.getElementById("btn-host-disconnect");
const btnHostChat = document.getElementById("btn-host-chat");
const hostPeerDisplay = document.getElementById("host-peer-display");

const sidebarChat = document.getElementById("sidebar-chat");
const sidebarFiles = document.getElementById("sidebar-files");

const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatContainer = document.getElementById("chat-messages-container");

const fileDropzone = document.getElementById("file-dropzone");
const fileInputRaw = document.getElementById("file-input-raw");
const transferList = document.getElementById("transfer-list");

// --- Screen Router ---
function showScreen(screenId) {
  document.querySelectorAll(".screen-view").forEach(s => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");

  document.body.className = "";
  if (screenId === "screen-active-session") {
    if (isHost) {
      document.body.classList.add("host-session");
    } else {
      document.body.classList.add("viewer-session");
    }
  }
}

// --- Toast System ---
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>◈</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("fade-out");
    toast.addEventListener("animationend", () => {
      toast.remove();
    });
  }, 4000);
}

// --- Copy Utilities ---
btnCopyAddress.addEventListener("click", async () => {
  const text = displayHostAddress.textContent;
  try {
    await invoke("plugin:clipboard-manager|write_text", { text });
    showToast("Address copied to clipboard", "success");
  } catch (err) {
    showToast("Failed to copy address", "error");
  }
});

btnCopyTunnelCmd.addEventListener("click", async () => {
  const text = "ssh -R 80:localhost:3000 serveo.net";
  try {
    await invoke("plugin:clipboard-manager|write_text", { text });
    showToast("Tunnel command copied to clipboard", "success");
  } catch (err) {
    showToast("Failed to copy command", "error");
  }
});

// --- Host Mode: Start Signaling ---
btnStartHosting.addEventListener("click", async () => {
  try {
    isHost = true;
    showToast("Initializing signaling server...", "info");
    const address = await invoke("start_server");
    displayHostAddress.textContent = address;
    showScreen("screen-host-waiting");

    // Extract the port from the returned address (e.g. "192.168.1.5:3000" -> 3000)
    const port = address.split(":").pop() || "3000";

    // Give the server a moment to be fully ready before connecting
    await new Promise(r => setTimeout(r, 300));

    // Connect signaling WebSocket locally using the actual bound port
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.onopen = () => {
      showToast("Signaling server ready. Awaiting viewer...", "success");
    };
    ws.onmessage = handleSignalingMessage;
    ws.onerror = (e) => {
      console.error("Host WS error:", e);
      showToast("Signaling server connection error", "error");
      stopHosting();
    };
    ws.onclose = (e) => {
      console.log("Host WS closed");
      if (!screenActiveSession.classList.contains("active")) {
        showToast("Signaling connection closed", "error");
        stopHosting();
      }
    };
  } catch (err) {
    console.error("start_server invoke error:", err);
    showToast(`Failed to start server: ${err}`, "error");
    isHost = false;
  }
});

btnStopHosting.addEventListener("click", stopHosting);
btnHostDisconnect.addEventListener("click", disconnectSession);

async function stopHosting() {
  cleanupSession();
  try {
    await invoke("stop_server");
  } catch (e) {}
  showScreen("screen-home");
  showToast("Hosting stopped", "info");
}

// --- Viewer Mode: Connect to Host ---
btnConnectRemote.addEventListener("click", () => {
  const rawAddr = inputConnectAddress.value.trim();
  if (!rawAddr) {
    showToast("Please enter a valid host address", "warn");
    return;
  }
  connectToHost(rawAddr);
});

btnViewerDisconnect.addEventListener("click", disconnectSession);

function connectToHost(address) {
  isHost = false;
  showToast("Connecting to signaling server...", "info");

  // Normalize the WebSocket URL
  let wsUrl = address.trim();
  // Strip any http/https prefix
  wsUrl = wsUrl.replace(/^https?:\/\//, "");
  // Strip trailing slash
  wsUrl = wsUrl.replace(/\/+$/, "");
  
  // If no port specified, default to 3000
  if (!wsUrl.includes(":") || wsUrl.split(":").pop().length > 5) {
    wsUrl = wsUrl + ":3000";
  }
  
  // Prepend ws:// if not already present
  if (!wsUrl.startsWith("ws://") && !wsUrl.startsWith("wss://")) {
    wsUrl = "ws://" + wsUrl;
  }

  console.log("Connecting to WS URL:", wsUrl);

  try {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      showToast("Signaling handshake active...", "info");
    };
    ws.onmessage = handleSignalingMessage;
    ws.onerror = (e) => {
      console.error("Viewer WS error:", e);
      showToast("Failed to connect to signaling server. Check the IP address and make sure both devices are on the same network.", "error");
      cleanupSession();
      showScreen("screen-home");
    };
    ws.onclose = (e) => {
      console.log("Viewer WS closed, code:", e.code, "reason:", e.reason);
      if (!screenActiveSession.classList.contains("active")) {
        showToast("Signaling connection closed", "error");
        cleanupSession();
        showScreen("screen-home");
      }
    };
  } catch (err) {
    console.error("WebSocket construction failed:", err);
    showToast(`Connection failed: ${err.message}`, "error");
  }
}

// --- Signaling Engine ---
function handleSignalingMessage(event) {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch (e) {
    return;
  }

  switch (data.type) {
    case "registered":
      myId = data.id;
      showToast(`Registered with signaling ID: ${myId}`, "success");
      if (!isHost) {
        // As viewer, immediately request connection from host
        // The address path does not specify peerId, so we handshake with the server's other connected peer.
        // Wait, signaling server knows who is connected. But we need to tell host we want connection.
        // What target ID should we send?
        // Since axum signaling server stores peers, and normally there are only two peers (host and viewer),
        // we can broadcast or send connection request to the peer. But how does viewer know host's ID?
        // The axum server's only other client is the host!
        // We can search the DashMap or the server can relay.
        // Wait! In the prompt, the viewer sends:
        // `{ type: "request-connection", to: "host_peer_id" }`
        // Wait, does the viewer know the host's peer ID?
        // Ah! The host's signaling server registers the host. But when viewer connects, the viewer receives its own ID.
        // How does the viewer know the host's ID to request connection?
        // Wait, in axum server code, the host connects to `ws://localhost:3000` and the viewer connects to the host's address.
        // If the viewer sends a request with target "to", how does it get the host's ID?
        // Actually, on the signaling server, the host was registered first, and the viewer is registered second.
        // But what if the viewer just sends a message with `to: "host"` or does the signaling server relay it?
        // Let's check: if there are only two peers in the signaling server's DashMap, the signaling server can relay to the other peer if `to` is not known, OR when the viewer registers, the signaling server knows the only other client is the host!
        // Wait, the prompt says:
        // `{ type: "request-connection", to: "987654321" }`
        // In our server.rs:
        // `if let Some(to_val) = json_val.get("to").and_then(|v| v.as_str()) { ... lookup target and relay ... }`
        // How can we obtain the target ID?
        // Wait! If the viewer doesn't know the host's ID, does the signaling server notify the viewer, or can we have the server relay any message with `to: "host"` or if `to` is empty?
        // Wait, the viewer can just request the host's ID, or since the host was registered, can the signaling server send the list of IDs?
        // Actually, there's an even simpler solution:
        // Since it's a 1-to-1 session, the signaling server has exactly two clients.
        // If the viewer connects, its ID is registered. The host is already registered.
        // We can have the viewer send `{ type: "request-connection", to: "host" }` and the server can relay to the ONLY other peer in the DashMap!
        // Let's check if our server.rs handles this:
        // In server.rs, we did:
        // `let target_id = to_val.to_string();`
        // if `target_id` is `"host"`, the server could find the peer that is NOT the sender and relay to them!
        // That is brilliant, robust, and requires zero state exchange!
        // Let's verify: if the target_id is `"host"` or if the target_id does not match any peer, we can relay to the other peer in the DashMap.
        // Let's look at the server code:
        // ```rust
        // match target_id.as_str() {
        //   _ => {
        //      // If it doesn't match any key, we can find the first key that is NOT peer_id and relay!
        //   }
        // }
        // ```
        // Let's implement this relay fallback on the server, or can we just find the other peer on the server?
        // Yes! Let's make the server find the other peer if the target ID is not found, or specifically if `to` is `"host"`!
        // Let's double check if we need to modify server.rs.
        // Yes, we can update server.rs to handle this fallback, making it extremely robust so the connection works even if the viewer doesn't know the host's random 9-digit ID!
        // Let's see:
        // In `server.rs`, we do:
        // ```rust
        // let mut target_sender = None;
        // if let Some(sender) = peers.get(&target_id) {
        //     target_sender = Some(sender.clone());
        // } else if target_id == "host" || !peers.contains_key(&target_id) {
        //     // Find the first peer that is NOT peer_id
        //     for r in peers.iter() {
        //         if r.key() != &peer_id {
        //             target_sender = Some(r.value().clone());
        //             break;
        //         }
        //     }
        // }
        // ```
        // This is incredibly robust! It handles the handshake flawlessly. Let's make sure the viewer sends `to: "host"` or similar.
        // Let's update `server.rs` to include this logic!
        ws.send(JSON.stringify({ type: "incoming-request", to: "host" }));
      }
      break;

    case "request-connection":
    case "incoming-request":
      tempRequesterId = data.from;
      requestPeerIdDisp.textContent = data.from;
      modalIncomingRequest.classList.add("active");
      break;

    case "connection-response":
      if (data.accepted) {
        peerId = data.from;
        showToast("Connection accepted by host. Creating WebRTC session...", "success");
        initiateWebRTC();
      } else {
        showToast("Host denied the connection request.", "error");
        disconnectSession();
      }
      break;

    case "offer":
      peerId = data.from;
      handleWebRTCOffer(data.sdp);
      break;

    case "answer":
      handleWebRTCAnswer(data.sdp);
      break;

    case "ice":
      if (pc) {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate))
          .catch(e => console.error("Error adding ice candidate", e));
      }
      break;
  }
}

// --- Host Request Actions ---
btnRequestAccept.addEventListener("click", () => {
  modalIncomingRequest.classList.remove("active");
  if (tempRequesterId) {
    peerId = tempRequesterId;
    tempRequesterId = null;
    acceptViewerConnection();
  }
});

btnRequestDeny.addEventListener("click", () => {
  modalIncomingRequest.classList.remove("active");
  if (tempRequesterId) {
    ws.send(JSON.stringify({
      type: "connection-response",
      to: tempRequesterId,
      accepted: false
    }));
    tempRequesterId = null;
  }
});

function acceptViewerConnection() {
  // Do NOT create the peer connection here – it will be created
  // in handleWebRTCOffer() when the viewer's SDP offer arrives.
  // Creating it here and again in handleWebRTCOffer() would overwrite
  // the first RTCPeerConnection and lose its ondatachannel handler.
  ws.send(JSON.stringify({
    type: "connection-response",
    to: peerId,
    accepted: true
  }));
}

// --- WebRTC Peer Setup ---
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

function setupWebRTCPeer(isInitiator) {
  pc = new RTCPeerConnection(rtcConfig);

  // ICE Exchange
  pc.onicecandidate = (event) => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "ice",
        to: peerId,
        candidate: event.candidate
      }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
      disconnectSession();
    }
  };

  if (isInitiator) {
    // Viewer creates channels
    streamChannel = pc.createDataChannel("stream", { ordered: false, maxRetransmits: 0 });
    controlChannel = pc.createDataChannel("control", { ordered: true });
    chatChannel = pc.createDataChannel("chat", { ordered: true });
    fileChannel = pc.createDataChannel("file", { ordered: true });

    bindChannelEvents(streamChannel, "stream");
    bindChannelEvents(controlChannel, "control");
    bindChannelEvents(chatChannel, "chat");
    bindChannelEvents(fileChannel, "file");
  } else {
    // Host receives channels
    pc.ondatachannel = (e) => {
      const channel = e.channel;
      bindChannelEvents(channel, channel.label);
    };
  }
}

function bindChannelEvents(channel, label) {
  if (label === "stream") streamChannel = channel;
  else if (label === "control") controlChannel = channel;
  else if (label === "chat") chatChannel = channel;
  else if (label === "file") fileChannel = channel;

  channel.onopen = () => {
    console.log(`DataChannel OPEN: ${label} (readyState=${channel.readyState})`);
    if (label === "control" || label === "stream") {
      checkAllChannelsReady();
    }
  };

  channel.onclose = () => {
    console.log(`DataChannel closed: ${label}`);
    disconnectSession();
  };

  channel.onerror = (err) => {
    console.error(`DataChannel error (${label}):`, err);
  };

  if (label === "stream") {
    channel.binaryType = "arraybuffer";
    channel.onmessage = handleStreamMessage;
  } else if (label === "control") {
    channel.onmessage = handleControlMessage;
  } else if (label === "chat") {
    channel.onmessage = handleChatMessage;
  } else if (label === "file") {
    channel.binaryType = "arraybuffer";
    channel.onmessage = handleFileMessage;
  }

  // CRITICAL: On the answerer (host), ondatachannel may fire with the
  // channel ALREADY in "open" state on fast LAN connections.  In that
  // case onopen will never fire.  Detect this and trigger the check now.
  if ((label === "control" || label === "stream") && channel.readyState === "open") {
    console.log(`DataChannel ${label} was ALREADY open when bound — triggering ready check`);
    checkAllChannelsReady();
  }
}

// --- Session Establisher ---
let sessionStarted = false;

function checkAllChannelsReady() {
  if (sessionStarted) return;
  const controlReady = controlChannel && controlChannel.readyState === "open";
  const streamReady = streamChannel && streamChannel.readyState === "open";
  console.log(`Channel readiness — control: ${controlReady}, stream: ${streamReady}`);
  if (controlReady && streamReady) {
    sessionStarted = true;
    onConnectionOpened();
  }
}

function onConnectionOpened() {
  showToast("Session connected directly over WebRTC DataChannel", "success");
  showScreen("screen-active-session");

  // Close signaling socket now that WebRTC is connected
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }

  if (isHost) {
    document.getElementById("host-peer-display").textContent = peerId;
    startCaptureLoop();
  } else {
    startPingLoop();
  }
}

function disconnectSession() {
  sessionStarted = false;
  cleanupSession();
  showScreen("screen-home");
  showToast("Session disconnected", "info");
}

function cleanupSession() {
  captureActive = false;
  if (captureLoop) {
    clearInterval(captureLoop);
    captureLoop = null;
  }
  if (pingLoop) {
    clearInterval(pingLoop);
    pingLoop = null;
  }

  if (streamChannel) {
    streamChannel.onclose = null;
    streamChannel.onerror = null;
    streamChannel.onmessage = null;
    streamChannel.close();
    streamChannel = null;
  }
  if (controlChannel) {
    controlChannel.onclose = null;
    controlChannel.onerror = null;
    controlChannel.onmessage = null;
    controlChannel.close();
    controlChannel = null;
  }
  if (chatChannel) {
    chatChannel.onclose = null;
    chatChannel.onerror = null;
    chatChannel.onmessage = null;
    chatChannel.close();
    chatChannel = null;
  }
  if (fileChannel) {
    fileChannel.onclose = null;
    fileChannel.onerror = null;
    fileChannel.onmessage = null;
    fileChannel.close();
    fileChannel = null;
  }

  if (pc) {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.ondatachannel = null;
    pc.close();
    pc = null;
  }

  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }

  screenImg.src = "";
  screenImg.style.display = "none";
  unreadChatCount = 0;
  updateChatBadge();
  
  // Clean sidebars and UI
  document.querySelectorAll(".sidebar").forEach(s => s.classList.remove("active"));
  chatContainer.innerHTML = "";
  transferList.innerHTML = "";
  currentOutgoingTransfer = null;
  currentIncomingTransfer = null;
}

// --- WebRTC Handshaking ---
async function initiateWebRTC() {
  setupWebRTCPeer(true); // Viewer initiates
  
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    ws.send(JSON.stringify({
      type: "offer",
      to: peerId,
      sdp: offer.sdp
    }));
  } catch (err) {
    showToast("Failed to create WebRTC offer", "error");
    disconnectSession();
  }
}

async function handleWebRTCOffer(sdp) {
  setupWebRTCPeer(false); // Host is target
  
  try {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    ws.send(JSON.stringify({
      type: "answer",
      to: peerId,
      sdp: answer.sdp
    }));
  } catch (err) {
    showToast("Failed to handle WebRTC offer", "error");
    disconnectSession();
  }
}

async function handleWebRTCAnswer(sdp) {
  try {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }));
  } catch (err) {
    showToast("Failed to handle WebRTC answer", "error");
    disconnectSession();
  }
}
// --- Screen Streaming ---
let frameCount = 0;
let captureActive = false;

function startCaptureLoop() {
  captureActive = true;
  frameCount = 0;
  console.log("Starting adaptive capture loop...");
  captureWorker();
}

async function captureWorker() {
  const targetFrameTime = 1000 / 30; // Target 30 FPS (33.3ms)
  
  while (captureActive) {
    if (!streamChannel || streamChannel.readyState !== "open") {
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    
    const startTime = Date.now();
    try {
      const b64Frame = await invoke("capture_frame");
      
      // Convert base64 JPEG to binary ArrayBuffer
      const binStr = atob(b64Frame);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      
      frameCount++;
      if (frameCount === 1) {
        console.log(`First frame captured: ${bytes.length} bytes (${(bytes.length / 1024).toFixed(1)} KB)`);
      }
      
      if (streamChannel.readyState === "open" && captureActive) {
        streamChannel.send(bytes.buffer);
      }
    } catch (err) {
      console.error("Frame capture/send failed:", err);
      if (frameCount === 0) {
        showToast("Screen capture failed — check permissions", "error");
        // Exit worker loop to avoid flooding
        break;
      }
    }
    
    // Calculate remaining sleep time to match target 30 FPS
    const elapsed = Date.now() - startTime;
    const sleepTime = Math.max(5, targetFrameTime - elapsed);
    await new Promise(r => setTimeout(r, sleepTime));
  }
}

function handleStreamMessage(event) {
  // Convert ArrayBuffer message to blob URL and update image src
  const blob = new Blob([event.data], { type: "image/jpeg" });
  const url = URL.createObjectURL(blob);
  
  screenImg.style.display = "block";
  const oldUrl = screenImg.src;
  screenImg.src = url;
  
  if (oldUrl.startsWith("blob:")) {
    URL.revokeObjectURL(oldUrl);
  }
}

// --- Input Injection & Relaying ---
function sendMouseEvent(e, eventType) {
  if (!controlChannel || controlChannel.readyState !== "open") return;

  const rect = screenImg.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;

  let button = "left";
  if (e.button === 1) button = "middle";
  if (e.button === 2) button = "right";

  let delta = 0;
  if (eventType === "scroll") {
    delta = Math.round(e.deltaY);
  }

  controlChannel.send(JSON.stringify({
    type: "mouse",
    event: eventType,
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    button,
    delta
  }));
}

screenImg.addEventListener("mousemove", (e) => sendMouseEvent(e, "move"));
screenImg.addEventListener("mousedown", (e) => sendMouseEvent(e, "down"));
screenImg.addEventListener("mouseup", (e) => sendMouseEvent(e, "up"));
screenImg.addEventListener("wheel", (e) => {
  e.preventDefault();
  sendMouseEvent(e, "scroll");
}, { passive: false });
screenImg.addEventListener("contextmenu", (e) => e.preventDefault());

// Keyboard Input Capturer
document.addEventListener("keydown", (e) => handleKeyEvent(e, true));
document.addEventListener("keyup", (e) => handleKeyEvent(e, false));

function handleKeyEvent(e, pressed) {
  if (isHost) return;
  if (!controlChannel || controlChannel.readyState !== "open") return;

  // Ignore if typing in a sidebar chat/file transfer input
  const actTag = document.activeElement ? document.activeElement.tagName : "";
  if (actTag === "INPUT" || actTag === "TEXTAREA") {
    return;
  }

  e.preventDefault();

  const modifiers = [];
  if (e.ctrlKey) modifiers.push("ctrl");
  if (e.altKey) modifiers.push("alt");
  if (e.shiftKey) modifiers.push("shift");
  if (e.metaKey) modifiers.push("meta");

  controlChannel.send(JSON.stringify({
    type: "key",
    code: e.code,
    modifiers,
    pressed
  }));
}


// --- Connection Quality / Latency ---
function startPingLoop() {
  if (pingLoop) clearInterval(pingLoop);
  pingLoop = setInterval(() => {
    if (controlChannel && controlChannel.readyState === "open") {
      controlChannel.send(JSON.stringify({ type: "ping", t: Date.now() }));
    }
  }, 2000);
}

function handleControlPong(ev) {
  const rtt = Date.now() - ev.t;
  const latencyVal = document.getElementById("latency-val");
  const qualityDot = document.getElementById("quality-dot");
  if (!latencyVal || !qualityDot) return;

  latencyVal.textContent = rtt;
  qualityDot.className = "quality-dot";

  if (rtt < 50) {
    qualityDot.classList.add("green");
  } else if (rtt >= 50 && rtt <= 150) {
    qualityDot.classList.add("yellow");
  } else {
    qualityDot.classList.add("red");
  }
}

// --- Chat Side panel ---
btnHostChat.addEventListener("click", () => toggleSidebar(sidebarChat, "host"));
btnViewerChat.addEventListener("click", () => toggleSidebar(sidebarChat, "viewer"));

function toggleSidebar(sidebar, type) {
  const isOpening = !sidebar.classList.contains("active");
  
  // Close other sidebars
  document.querySelectorAll(".sidebar").forEach(s => s.classList.remove("active"));
  
  if (isOpening) {
    sidebar.classList.add("active");
    if (sidebar === sidebarChat) {
      unreadChatCount = 0;
      updateChatBadge();
      chatInput.focus();
    } else if (sidebar === sidebarFiles) {
      // Clear file badge
      document.getElementById("viewer-files-badge").style.display = "none";
    }
  }
}

document.querySelectorAll(".btn-close-sidebar").forEach(btn => {
  btn.addEventListener("click", () => {
    btn.closest(".sidebar").classList.remove("active");
  });
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  if (chatChannel && chatChannel.readyState === "open") {
    const msg = {
      text,
      time: Date.now(),
      from: isHost ? "Host" : "Viewer"
    };
    chatChannel.send(JSON.stringify(msg));
    appendChatMessage(msg);
    chatInput.value = "";
  } else {
    showToast("Chat channel is not connected", "error");
  }
});

function handleChatMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch (e) {
    return;
  }
  appendChatMessage(msg);
}

function appendChatMessage(msg) {
  const isMe = msg.from === (isHost ? "Host" : "Viewer");
  const msgEl = document.createElement("div");
  msgEl.className = `chat-msg ${isMe ? "host-msg" : "viewer-msg"}`;

  const timeStr = new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const escapedText = msg.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  msgEl.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-msg-sender">${msg.from}</span>
      <span class="chat-msg-time">${timeStr}</span>
    </div>
    <div class="chat-msg-body">${escapedText}</div>
  `;

  chatContainer.appendChild(msgEl);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  if (!sidebarChat.classList.contains("active")) {
    unreadChatCount++;
    updateChatBadge();
  }
}

function updateChatBadge() {
  const hostBadge = document.getElementById("host-chat-badge");
  const viewerBadge = document.getElementById("viewer-chat-badge");

  if (unreadChatCount > 0) {
    if (isHost && hostBadge) {
      hostBadge.textContent = unreadChatCount;
      hostBadge.style.display = "inline-block";
    } else if (!isHost && viewerBadge) {
      viewerBadge.style.display = "inline-block";
    }
  } else {
    if (hostBadge) hostBadge.style.display = "none";
    if (viewerBadge) viewerBadge.style.display = "none";
  }
}

// --- File Transfer Logic ---
btnViewerFiles.addEventListener("click", () => toggleSidebar(sidebarFiles, "viewer"));

// Click dropzone to select file
fileDropzone.addEventListener("click", () => fileInputRaw.click());
fileInputRaw.addEventListener("change", (e) => {
  if (e.target.files.length > 0) {
    initiateFileSend(e.target.files[0]);
  }
});

// Drag & Drop event bindings
fileDropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  fileDropzone.classList.add("dragover");
});
fileDropzone.addEventListener("dragleave", () => {
  fileDropzone.classList.remove("dragover");
});
fileDropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  fileDropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length > 0) {
    initiateFileSend(e.dataTransfer.files[0]);
  }
});

function createTransferItem(id, name, statusText) {
  const item = document.createElement("div");
  item.className = "transfer-item";
  item.id = `transfer-${id}`;
  item.innerHTML = `
    <div class="transfer-item-meta">
      <span class="transfer-item-name" title="${name}">${name}</span>
      <span class="transfer-item-status" id="transfer-status-${id}">${statusText}</span>
    </div>
    <div class="progress-bar-container">
      <div class="progress-bar-fill" id="transfer-progress-${id}" style="width: 0%"></div>
    </div>
  `;
  transferList.appendChild(item);
  transferList.scrollTop = transferList.scrollHeight;
}

function updateTransferProgress(id, sentBytes, totalBytes) {
  const progressPercent = Math.min(100, Math.round((sentBytes / totalBytes) * 100));
  const progressFill = document.getElementById(`transfer-progress-${id}`);
  const statusLabel = document.getElementById(`transfer-status-${id}`);
  
  if (progressFill) progressFill.style.width = `${progressPercent}%`;
  if (statusLabel) statusLabel.textContent = `${progressPercent}%`;
}

function markTransferCompleted(id, customText = "Completed") {
  const item = document.getElementById(`transfer-${id}`);
  const statusLabel = document.getElementById(`transfer-status-${id}`);
  if (item) item.classList.add("completed");
  if (statusLabel) statusLabel.innerHTML = `<span style="color: var(--success)">✓ ${customText}</span>`;
}

function initiateFileSend(file) {
  if (!fileChannel || fileChannel.readyState !== "open") {
    showToast("File transfer channel is not connected", "error");
    return;
  }

  showToast(`Preparing to send: ${file.name}...`, "info");
  const reader = new FileReader();
  reader.onload = (e) => {
    const arrayBuffer = e.target.result;
    const CHUNK_SIZE = 256 * 1024; // 256KB chunks
    const totalChunks = Math.ceil(arrayBuffer.byteLength / CHUNK_SIZE);
    const transferId = `tx-${Date.now()}`;

    createTransferItem(transferId, file.name, "Waiting...");

    currentOutgoingTransfer = {
      id: transferId,
      name: file.name,
      size: file.size,
      chunks: totalChunks,
      data: arrayBuffer,
      offset: 0,
      chunkIndex: 0
    };

    // Send metadata header
    fileChannel.send(JSON.stringify({
      type: "file-start",
      transferId,
      name: file.name,
      size: file.size,
      chunks: totalChunks
    }));
  };
  reader.readAsArrayBuffer(file);
}

async function sendOutgoingChunks() {
  const tx = currentOutgoingTransfer;
  if (!tx) return;

  const CHUNK_SIZE = 256 * 1024;
  const statusLabel = document.getElementById(`transfer-status-${tx.id}`);
  if (statusLabel) statusLabel.textContent = "Sending...";

  while (tx.offset < tx.data.byteLength) {
    // Flow control: throttle chunk sending if data buffer starts backing up
    if (fileChannel.bufferedAmount > 1024 * 1024) { // 1MB
      await new Promise(r => setTimeout(r, 40));
      continue;
    }

    const chunk = tx.data.slice(tx.offset, tx.offset + CHUNK_SIZE);
    fileChannel.send(chunk);
    
    tx.offset += chunk.byteLength;
    tx.chunkIndex++;
    
    updateTransferProgress(tx.id, tx.offset, tx.data.byteLength);
  }

  // Finalize transfer
  fileChannel.send(JSON.stringify({
    type: "file-end",
    transferId: tx.id,
    name: tx.name
  }));

  markTransferCompleted(tx.id, "Sent");
  currentOutgoingTransfer = null;
}

function handleFileMessage(event) {
  // Handle control metadata vs binary chunks
  if (typeof event.data === "string") {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case "file-start":
        showToast(`Receiving file: ${msg.name}...`, "info");
        
        // Show file sidebar notification dot if closed
        if (!sidebarFiles.classList.contains("active") && !isHost) {
          document.getElementById("viewer-files-badge").style.display = "inline-block";
        }

        currentIncomingTransfer = {
          id: msg.transferId,
          name: msg.name,
          size: msg.size,
          chunks: msg.chunks,
          buffer: [],
          receivedBytes: 0
        };

        createTransferItem(msg.transferId, msg.name, "Receiving...");

        // Acknowledge host that viewer is ready to accept binary stream
        fileChannel.send(JSON.stringify({
          type: "file-ready",
          transferId: msg.transferId
        }));
        break;

      case "file-ready":
        if (currentOutgoingTransfer && currentOutgoingTransfer.id === msg.transferId) {
          sendOutgoingChunks();
        }
        break;

      case "file-end":
        if (currentIncomingTransfer && currentIncomingTransfer.id === msg.transferId) {
          const rx = currentIncomingTransfer;
          
          // Reconstruct file from collected chunks
          const blob = new Blob(rx.buffer);
          const url = URL.createObjectURL(blob);

          // Force auto-download to disk
          const link = document.createElement("a");
          link.href = url;
          link.download = rx.name;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);

          markTransferCompleted(rx.id, "Saved");
          showToast(`File download completed: ${rx.name}`, "success");
          currentIncomingTransfer = null;
        }
        break;
    }
  } else {
    // Process incoming binary chunk
    const rx = currentIncomingTransfer;
    if (rx) {
      rx.buffer.push(event.data);
      rx.receivedBytes += event.data.byteLength;
      updateTransferProgress(rx.id, rx.receivedBytes, rx.size);
    }
  }
}

// --- Toolbar Auto-Hiding ---
let toolbarTimeout = null;
viewerContainer.addEventListener("mousemove", (e) => {
  if (e.clientY < 48 || e.target.closest("#viewer-toolbar")) {
    viewerToolbar.classList.remove("hidden");
    resetToolbarTimeout();
  }
});

function resetToolbarTimeout() {
  if (toolbarTimeout) clearTimeout(toolbarTimeout);
  toolbarTimeout = setTimeout(() => {
    const isHovered = document.querySelector("#viewer-toolbar:hover");
    if (!isHovered) {
      viewerToolbar.classList.add("hidden");
    }
  }, 3000);
}

// --- Fallback Pong Processing ---
function handleControlMessage(event) {
  let ev;
  try {
    ev = JSON.parse(event.data);
  } catch (e) {
    return;
  }

  if (ev.type === "pong") {
    handleControlPong(ev);
    return;
  }

  if (ev.type === "ping") {
    if (controlChannel && controlChannel.readyState === "open") {
      controlChannel.send(JSON.stringify({ type: "pong", t: ev.t }));
    }
    return;
  }

  // Host Mode input simulation relaying
  if (isHost) {
    if (ev.type === "mouse") {
      invoke("inject_mouse", {
        x: ev.x,
        y: ev.y,
        event: ev.event,
        button: ev.button || "left",
        delta: ev.delta || 0
      }).catch(err => {
        console.error("inject_mouse failed:", err, "payload:", ev);
      });
    } else if (ev.type === "key") {
      invoke("inject_key", {
        key: ev.code,
        modifiers: ev.modifiers || [],
        pressed: ev.pressed
      }).catch(err => {
        console.error("inject_key failed:", err, "payload:", ev);
      });
    }
  }
}
