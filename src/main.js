// Safe wrappers for Tauri APIs to prevent script crashes when run in standard browsers or before injection
const hasTauri = typeof window !== "undefined" && window.__TAURI__ !== undefined;
const invoke = hasTauri ? window.__TAURI__.core.invoke : async (cmd, args) => {
  console.warn(`[Browser Mock] invoke called for: ${cmd}`, args);
  return null;
};
const getCurrentWindow = hasTauri ? window.__TAURI__.window.getCurrentWindow : () => ({
  minimize: async () => { },
  toggleMaximize: async () => { },
  close: async () => { },
  startDragging: async () => { },
});

// --- Window Dragging and Controls ---
const appWindow = getCurrentWindow();
const btnMin = document.getElementById("titlebar-minimize");
const btnMax = document.getElementById("titlebar-maximize");
const btnClose = document.getElementById("titlebar-close");
const titleBar = document.getElementById("titlebar");

if (btnMin) btnMin.addEventListener("click", () => appWindow.minimize());
if (btnMax) btnMax.addEventListener("click", () => appWindow.toggleMaximize());
if (btnClose) btnClose.addEventListener("click", () => appWindow.close());
if (titleBar) {
  titleBar.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".titlebar-btn")) {
      appWindow.startDragging();
    }
  });
}


// --- State Variables ---
let ws = null;                  // Signaling WebSocket
let myId = null;                // 9-digit client ID
let myPassword = null;          // Client session password
let tunnelSubdomain = null;     // Subdomain of the active cloud tunnel
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

// --- Central Signaling Connection ---
// ─── SIGNALING SERVER URL ───────────────────────────────────────────
// After deploying signaling-server/ to Render.com, paste your URL below:
//   Example: "wss://remotelink-signaling.onrender.com"
// Leave empty to use the local embedded server (same-network only).
const REMOTE_SIGNALING_URL = "wss://remotelink-muwt.onrender.com";
const LOCAL_SIGNALING_URL = "ws://127.0.0.1:3000";
const SIGNALING_URL = REMOTE_SIGNALING_URL || LOCAL_SIGNALING_URL;

// For local server, try multiple ports in case 3000 is in use
const LOCAL_PORTS = [3000, 3001, 3002, 3003, 3004];
let currentPortIndex = 0;
let signalingConnected = false;

function updateConnectionStatus(state, message) {
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  const idEl = document.getElementById("display-my-id");
  const pwdEl = document.getElementById("display-my-password");
  if (!dot || !text) return;

  dot.className = "status-dot " + state;
  text.textContent = message;

  if (state === "connecting") {
    idEl.textContent = "Connecting...";
    pwdEl.textContent = "Connecting...";
    idEl.classList.add("loading-placeholder");
    pwdEl.classList.add("loading-placeholder");
  } else if (state === "error") {
    idEl.textContent = "Not available";
    pwdEl.textContent = "Not available";
    idEl.classList.add("loading-placeholder");
    pwdEl.classList.add("loading-placeholder");
  }
  // "connected" state is handled by the init message handler
}

function getSignalingUrl() {
  if (REMOTE_SIGNALING_URL) return REMOTE_SIGNALING_URL;
  return `ws://127.0.0.1:${LOCAL_PORTS[currentPortIndex]}`;
}

function connectSignaling() {
  const url = getSignalingUrl();
  console.log("Connecting to signaling server:", url);
  updateConnectionStatus("connecting", `Connecting to server...`);

  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log("Connected to signaling server at", url);
    signalingConnected = true;
    currentPortIndex = 0; // reset for next time
    updateConnectionStatus("connected", "Connected to server");
  };

  ws.onmessage = (event) => {
    handleSignalingMessage(event);
  };

  ws.onerror = (e) => {
    console.error("Signaling server connection error:", e);
  };

  ws.onclose = (e) => {
    console.log("Signaling connection closed.");
    const wasConnected = signalingConnected;
    signalingConnected = false;

    // If using local server and never connected, try next port
    if (!REMOTE_SIGNALING_URL && !wasConnected) {
      currentPortIndex++;
      if (currentPortIndex < LOCAL_PORTS.length) {
        console.log(`Port ${LOCAL_PORTS[currentPortIndex - 1]} failed, trying port ${LOCAL_PORTS[currentPortIndex]}...`);
        updateConnectionStatus("connecting", `Trying port ${LOCAL_PORTS[currentPortIndex]}...`);
        setTimeout(connectSignaling, 500);
        return;
      }
      // All ports exhausted — reset and retry from port 3000
      currentPortIndex = 0;
      updateConnectionStatus("error", "Server not reachable — retrying...");
      setTimeout(connectSignaling, 5000);
    } else {
      // Was connected but lost connection, or using remote server
      updateConnectionStatus("connecting", "Reconnecting...");
      setTimeout(connectSignaling, 3000);
    }
  };
}

// Call on startup
connectSignaling();

// --- Cloudflare Tunnel Support ---
let tunnelActive = false;

async function checkTunnelInfo() {
  try {
    const info = await invoke("get_tunnel_info");
    if (!info) return;

    const statusText = document.getElementById("status-text");
    const statusDot = document.getElementById("status-dot");
    const idEl = document.getElementById("display-my-id");

    if (info.status === "connected" && info.subdomain) {
      if (!tunnelActive) {
        tunnelActive = true;
        showToast("Secure cloud tunnel established!", "success");
      }
      tunnelSubdomain = info.subdomain;
      idEl.textContent = info.subdomain;
      idEl.classList.remove("loading-placeholder");

      if (statusText && statusDot) {
        statusText.textContent = "Zero-config cloud tunnel ready";
        statusDot.className = "status-dot connected";
      }
    } else {
      if (tunnelActive) {
        tunnelActive = false;
        tunnelSubdomain = null;
        if (myId) {
          idEl.textContent = myId.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
        } else {
          idEl.textContent = "Connecting...";
          idEl.classList.add("loading-placeholder");
        }
      }
      if (info.status === "downloading_cloudflared") {
        if (statusText && statusDot) {
          statusText.textContent = "Zero-config: downloading cloudflared...";
          statusDot.className = "status-dot connecting";
        }
      } else if (info.status === "starting_tunnel") {
        if (statusText && statusDot) {
          statusText.textContent = "Zero-config: starting tunnel...";
          statusDot.className = "status-dot connecting";
        }
      } else if (info.status.startsWith("download_failed")) {
        if (statusText && statusDot) {
          statusText.textContent = "Download failed. Please check internet connection.";
          statusDot.className = "status-dot error";
        }
      } else if (info.status.startsWith("spawn_failed")) {
        if (statusText && statusDot) {
          statusText.textContent = "Failed to start tunnel daemon.";
          statusDot.className = "status-dot error";
        }
      }
    }
  } catch (e) {
    console.error("Failed to query tunnel info:", e);
  }
}

// Check tunnel info every 1.5 seconds
setInterval(checkTunnelInfo, 1500);


// --- Copy & Refresh Handlers ---
const btnCopyMyId = document.getElementById("btn-copy-my-id");
const btnRefreshPassword = document.getElementById("btn-refresh-password");
const btnConnectPartner = document.getElementById("btn-connect-partner");
const inputPartnerId = document.getElementById("input-partner-id");
const inputPartnerPassword = document.getElementById("input-partner-password");

btnCopyMyId.addEventListener("click", async () => {
  const text = document.getElementById("display-my-id").textContent;
  if (!text || text === "--- --- ---" || text.includes("Connecting") || text.includes("available")) return;
  try {
    await invoke("plugin:clipboard-manager|write_text", { text });
    showToast("Your Partner ID copied to clipboard", "success");
  } catch (err) {
    showToast("Failed to copy ID", "error");
  }
});

btnRefreshPassword.addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Not connected to signaling server", "error");
    return;
  }
  // Generate a random 5-digit password locally and register it
  const newPwd = Math.floor(10000 + Math.random() * 90000).toString();
  ws.send(JSON.stringify({
    type: "update-password",
    password: newPwd
  }));
});

btnConnectPartner.addEventListener("click", () => {
  const rawId = inputPartnerId.value.trim();
  const pwd = inputPartnerPassword.value.trim();

  if (!rawId) {
    showToast("Please enter your partner's ID", "warn");
    return;
  }
  if (!pwd) {
    showToast("Please enter your partner's password", "warn");
    return;
  }

  // Format target ID by stripping spaces
  let targetId = rawId.replace(/\s+/g, "").toLowerCase();
  targetId = targetId.replace(/^(https?:\/\/|wss?:\/\/)/, "");
  targetId = targetId.split('/')[0];

  const isTunnel = targetId.includes("trycloudflare.com") || !/^\d+$/.test(targetId);

  if (isTunnel) {
    let tunnelHost = targetId;
    if (!tunnelHost.includes(".")) {
      tunnelHost = `${tunnelHost}.trycloudflare.com`;
    }
    const tunnelWsUrl = `wss://${tunnelHost}`;

    showToast(`Connecting via secure tunnel: ${tunnelHost}...`, "info");
    btnConnectPartner.disabled = true;

    // Close current ws if open
    if (ws) {
      ws.onclose = null; // prevent auto-reconnect trigger
      ws.close();
    }

    ws = new WebSocket(tunnelWsUrl);

    ws.onopen = () => {
      console.log("Connected to partner's tunnel signaling server at", tunnelWsUrl);
      isHost = false; // Viewer mode
      ws.send(JSON.stringify({
        type: "connect-request",
        to: "host",
        password: pwd
      }));
    };

    ws.onmessage = (event) => {
      handleSignalingMessage(event);
    };

    ws.onerror = (e) => {
      console.error("Tunnel signaling connection error:", e);
      showToast("Tunnel connection failed or offline", "error");
      btnConnectPartner.disabled = false;
      connectSignaling(); // fallback/reconnect to local/default
    };

    ws.onclose = (e) => {
      console.log("Tunnel connection closed.");
      btnConnectPartner.disabled = false;
      connectSignaling(); // fallback/reconnect
    };
  } else {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showToast("Not connected to signaling server", "error");
      return;
    }

    showToast("Authenticating connection with partner...", "info");
    btnConnectPartner.disabled = true;

    isHost = false; // Viewer mode
    ws.send(JSON.stringify({
      type: "connect-request",
      to: targetId,
      password: pwd
    }));
  }
});

btnViewerDisconnect.addEventListener("click", disconnectSession);
btnHostDisconnect.addEventListener("click", disconnectSession);

// --- Signaling Engine ---
function handleSignalingMessage(event) {
  console.log("handleSignalingMessage got data:", event.data);
  let data;
  try {
    data = JSON.parse(event.data);
  } catch (e) {
    console.error("JSON parse error:", e);
    return;
  }

  switch (data.type) {
    case "init":
      myId = data.id;
      myPassword = data.password;
      // Format as "XXX XXX XXX"
      const formatted = data.id.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
      const idEl = document.getElementById("display-my-id");
      const pwdEl = document.getElementById("display-my-password");

      // If tunnel is active and we have the subdomain, show it instead of local ID
      if (tunnelActive && tunnelSubdomain) {
        idEl.textContent = tunnelSubdomain;
      } else {
        idEl.textContent = formatted;
      }
      idEl.classList.remove("loading-placeholder");

      pwdEl.textContent = data.password;
      pwdEl.classList.remove("loading-placeholder");
      updateConnectionStatus("connected", "Connected — credentials ready");
      showToast("Registered with signaling server", "success");
      break;

    case "update-password-ack":
      if (data.success) {
        myPassword = data.password;
        document.getElementById("display-my-password").textContent = data.password;
        showToast("Password updated successfully", "success");
      }
      break;

    case "incoming-session":
      // Host receives this when a viewer successfully authenticated
      peerId = data.from;
      isHost = true;
      showToast("Partner successfully authenticated. Starting control session...", "success");
      // Switch screen and prepare connection
      showScreen("screen-active-session");
      document.getElementById("host-peer-display").textContent = peerId.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
      startCaptureLoop();
      break;

    case "connect-response":
      btnConnectPartner.disabled = false;
      if (data.success) {
        peerId = data.from;
        showToast("Authentication successful! Initiating WebRTC...", "success");
        initiateWebRTC();
      } else {
        showToast(`Connection failed: ${data.error}`, "error");
        cleanupSession();
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


// --- WebRTC Peer Setup ---
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
    { urls: "stun:stun.stunprotocol.org:3478" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
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

  if (isHost) {
    document.getElementById("host-peer-display").textContent = peerId.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
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

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectSignaling();
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
