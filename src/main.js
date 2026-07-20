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
  setSkipTaskbar: async (skip) => { },
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

// --- Theme Toggling and Persistence ---
const btnThemeToggle = document.getElementById("titlebar-theme-toggle");
const themeIconSvg = document.getElementById("theme-icon-svg");

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("remotelink_theme", theme);
  if (!themeIconSvg) return;
  if (theme === "light") {
    // Moon Icon path (to switch to dark mode)
    themeIconSvg.innerHTML = `<path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/>`;
    btnThemeToggle.title = "Switch to Dark Mode";
  } else {
    // Sun Icon path (to switch to light mode)
    themeIconSvg.innerHTML = `<path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41l-1.06-1.06zm1.06-12.37c-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06c.39-.39.39-1.03 0-1.41zm-12.37 12.37c-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06c.39-.39.39-1.03 0-1.41z"/>`;
    btnThemeToggle.title = "Switch to Light Mode";
  }
}

if (btnThemeToggle) {
  btnThemeToggle.addEventListener("click", () => {
    const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
    setTheme(currentTheme === "light" ? "dark" : "light");
  });
}

// Initial theme load
setTheme(localStorage.getItem("remotelink_theme") || "dark");


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
const btnViewerAi = document.getElementById("btn-viewer-ai");

const btnHostDisconnect = document.getElementById("btn-host-disconnect");
const btnHostChat = document.getElementById("btn-host-chat");
const btnHostAi = document.getElementById("btn-host-ai");
const hostPeerDisplay = document.getElementById("host-peer-display");

const sidebarChat = document.getElementById("sidebar-chat");
const sidebarFiles = document.getElementById("sidebar-files");

const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatContainer = document.getElementById("chat-messages-container");

const fileDropzone = document.getElementById("file-dropzone");
const fileInputRaw = document.getElementById("file-input-raw");
const transferList = document.getElementById("transfer-list");

// --- AI Troubleshooter DOM & State ---
const btnTroubleshootAi = document.getElementById("btn-troubleshoot-ai");
const sidebarAi = document.getElementById("sidebar-ai");
const btnCloseAi = document.getElementById("btn-close-ai");
const aiChatMessages = document.getElementById("ai-chat-messages");
const aiChatForm = document.getElementById("ai-chat-form");
const aiChatInput = document.getElementById("ai-chat-input");
const btnFloatingAi = document.getElementById("btn-floating-ai");
const btnNewAiChat = document.getElementById("btn-new-ai-chat");
const btnAiChatHistory = document.getElementById("btn-ai-chat-history");
const aiChatHistoryContainer = document.getElementById("ai-chat-history-container");

let aiMessages = [];
let aiChats = [];
let currentChatId = null;


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
  const aiBtn = document.getElementById("btn-troubleshoot-ai");
  if (!dot || !text) return;

  dot.className = "status-dot " + state;
  text.textContent = message;

  if (state === "connecting") {
    idEl.textContent = "Connecting...";
    pwdEl.textContent = "Connecting...";
    idEl.classList.add("loading-placeholder");
    pwdEl.classList.add("loading-placeholder");
    if (aiBtn) aiBtn.style.display = "none";
  } else if (state === "error") {
    idEl.textContent = "Not available";
    pwdEl.textContent = "Not available";
    idEl.classList.add("loading-placeholder");
    pwdEl.classList.add("loading-placeholder");
    if (aiBtn) aiBtn.style.display = "inline-flex";
  } else if (state === "connected") {
    if (aiBtn) aiBtn.style.display = "none";
  }
  // "connected" state is handled by the init message handler
}

let useLocalFallback = false;

function getSignalingUrl() {
  if (REMOTE_SIGNALING_URL && !useLocalFallback) return REMOTE_SIGNALING_URL;
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
    const isRemote = REMOTE_SIGNALING_URL && !useLocalFallback;
    updateConnectionStatus("connected", isRemote ? "Connected to remote server" : "Connected to server");
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

    // If using remote server and never connected, fall back to local ports
    if (REMOTE_SIGNALING_URL && !useLocalFallback && !wasConnected) {
      console.log("Failed to connect to remote signaling server, falling back to local/tunnel...");
      useLocalFallback = true;
      currentPortIndex = 0;
      updateConnectionStatus("connecting", "Remote down, trying local...");
      setTimeout(connectSignaling, 500);
      return;
    }

    // If using local/fallback server and never connected, try next port
    if ((!REMOTE_SIGNALING_URL || useLocalFallback) && !wasConnected) {
      currentPortIndex++;
      if (currentPortIndex < LOCAL_PORTS.length) {
        console.log(`Port ${LOCAL_PORTS[currentPortIndex - 1]} failed, trying port ${LOCAL_PORTS[currentPortIndex]}...`);
        updateConnectionStatus("connecting", `Trying port ${LOCAL_PORTS[currentPortIndex]}...`);
        setTimeout(connectSignaling, 500);
        return;
      }
      // All local ports exhausted — try remote again if configured
      if (REMOTE_SIGNALING_URL) {
        console.log("All local ports failed, retrying remote signaling server...");
        useLocalFallback = false;
        currentPortIndex = 0;
        updateConnectionStatus("connecting", "Retrying remote server...");
        setTimeout(connectSignaling, 5000);
        return;
      }
      currentPortIndex = 0;
      updateConnectionStatus("error", "Server not reachable — retrying...");
      setTimeout(connectSignaling, 5000);
    } else {
      // Was connected but lost connection
      updateConnectionStatus("connecting", "Reconnecting...");
      // Try to reconnect in the same mode (if remote was working, try remote again)
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

    const isUsingRemote = REMOTE_SIGNALING_URL && !useLocalFallback && signalingConnected;

    if (info.status === "connected" && info.subdomain) {
      if (!tunnelActive) {
        tunnelActive = true;
        showToast("Secure cloud tunnel established!", "success");
      }
      tunnelSubdomain = info.subdomain;
      
      if (isUsingRemote && myId) {
        idEl.textContent = myId.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
      } else {
        idEl.textContent = info.subdomain;
      }
      idEl.classList.remove("loading-placeholder");

      if (!isUsingRemote && statusText && statusDot) {
        statusText.textContent = "Zero-config cloud tunnel ready";
        statusDot.className = "status-dot connected";
      }
    } else {
      if (tunnelActive) {
        tunnelActive = false;
        tunnelSubdomain = null;
      }
      
      if (!isUsingRemote) {
        if (myId) {
          idEl.textContent = myId.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
        } else {
          idEl.textContent = "Connecting...";
          idEl.classList.add("loading-placeholder");
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

      // If tunnel is active, we have the subdomain, and we are NOT using the remote server, show it
      const isUsingRemote = REMOTE_SIGNALING_URL && !useLocalFallback;
      if (tunnelActive && tunnelSubdomain && !isUsingRemote) {
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
        const aiBtn = document.getElementById("btn-troubleshoot-ai");
        if (aiBtn) aiBtn.style.display = "inline-flex";
        startAiDiagnostic(`Partner connection failed: ${data.error}`);
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
    if (hasTauri) {
      appWindow.setSkipTaskbar(true).catch(err => console.error("Failed to set skipTaskbar for host:", err));
    }
  } else {
    startPingLoop();
    if (hasTauri) {
      appWindow.setSkipTaskbar(false).catch(err => console.error("Failed to set skipTaskbar for viewer:", err));
    }
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

  if (hasTauri) {
    appWindow.setSkipTaskbar(true).catch(err => console.error("Failed to reset taskbar icon on cleanup:", err));
  }
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

// --- Sidebars Management ---
function closeAllSidebars() {
  document.querySelectorAll(".sidebar").forEach(s => s.classList.remove("active"));
  document.body.classList.remove("sidebar-open");
}

btnHostChat.addEventListener("click", () => toggleSidebar(sidebarChat, "host"));
btnViewerChat.addEventListener("click", () => toggleSidebar(sidebarChat, "viewer"));

function toggleSidebar(sidebar, type) {
  const isOpening = !sidebar.classList.contains("active");

  closeAllSidebars();

  if (isOpening) {
    sidebar.classList.add("active");
    document.body.classList.add("sidebar-open");
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
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllSidebars();
  });
});

document.querySelectorAll(".btn-sidebar-ai-switch").forEach(btn => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAiSidebar("Header AI quick-switch click");
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

// --- AI Troubleshooting & Assistance Logic ---
async function captureCurrentScreen() {
  // If we are in an active session as a viewer, capture the remote screen image
  if (screenActiveSession.classList.contains("active") && !isHost && screenImg && screenImg.src) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = screenImg.naturalWidth || screenImg.width || 1280;
      canvas.height = screenImg.naturalHeight || screenImg.height || 720;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(screenImg, 0, 0);
      return canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
    } catch (e) {
      console.error("Failed to capture screenImg via canvas:", e);
    }
  }
  // Otherwise, if Tauri is available, capture the local primary screen
  if (hasTauri) {
    try {
      return await invoke("capture_frame");
    } catch (e) {
      console.error("capture_frame failed:", e);
    }
  }
  return null;
}

// --- AI Chat History and Session Management ---
function loadAiChatsFromStorage() {
  try {
    const stored = localStorage.getItem("remotelink_ai_chats");
    if (stored) {
      aiChats = JSON.parse(stored);
    } else {
      aiChats = [];
    }
  } catch (e) {
    console.error("Failed to load AI chats:", e);
    aiChats = [];
  }
}

function saveAiChatsToStorage() {
  try {
    localStorage.setItem("remotelink_ai_chats", JSON.stringify(aiChats));
  } catch (e) {
    console.error("Failed to save AI chats:", e);
  }
}

function startNewAiChat(customTitle = "New Chat") {
  currentChatId = "chat_" + Date.now();
  
  const welcomeText = "Hello! I am RemoteLink AI, your general AI assistant. Ask me anything, or check 'Attach current screen' to analyze what's currently on your display.";
  const messages = [];
  
  if (customTitle === "New Chat") {
    messages.push({ role: "assistant", content: welcomeText });
  }
  
  aiMessages = [...messages];
  
  const newChat = {
    id: currentChatId,
    title: customTitle,
    messages: [...messages],
    created: Date.now()
  };
  
  aiChats.unshift(newChat);
  saveAiChatsToStorage();
  
  loadAiChat(currentChatId);
}

function loadAiChat(chatId) {
  const chat = aiChats.find(c => c.id === chatId);
  if (!chat) return;
  
  currentChatId = chatId;
  aiMessages = [...chat.messages];
  aiChatMessages.innerHTML = "";
  
  if (aiMessages.length === 0) {
    appendAiMessage("AI Assistant", "Hello! This is a fresh chat. Ask me anything.", "ai-msg");
  } else {
    aiMessages.forEach(msg => {
      const isUser = msg.role === "user";
      const sender = isUser ? "You" : "AI Assistant";
      const className = isUser ? "user-msg" : "ai-msg";
      appendAiMessage(sender, msg.content, className);
    });
  }
  
  showAiActiveChatView();
}

function deleteAiChat(chatId) {
  aiChats = aiChats.filter(c => c.id !== chatId);
  saveAiChatsToStorage();
  
  renderAiChatHistory();
  
  if (currentChatId === chatId) {
    if (aiChats.length > 0) {
      loadAiChat(aiChats[0].id);
    } else {
      startNewAiChat();
    }
  }
}

function renameAiChat(chatId, newTitle) {
  const chat = aiChats.find(c => c.id === chatId);
  if (chat && newTitle.trim()) {
    chat.title = newTitle.trim();
    saveAiChatsToStorage();
    renderAiChatHistory();
  }
}

function showAiActiveChatView() {
  document.getElementById("ai-chat-messages").style.display = "flex";
  document.querySelector("#sidebar-ai .sidebar-footer").style.display = "block";
  document.getElementById("ai-chat-history-container").style.display = "none";
  if (btnAiChatHistory) btnAiChatHistory.classList.remove("active");
}

function showAiHistoryView() {
  document.getElementById("ai-chat-messages").style.display = "none";
  document.querySelector("#sidebar-ai .sidebar-footer").style.display = "none";
  document.getElementById("ai-chat-history-container").style.display = "flex";
  if (btnAiChatHistory) btnAiChatHistory.classList.add("active");
  renderAiChatHistory();
}

function renderAiChatHistory() {
  const container = document.getElementById("ai-chat-history-container");
  container.innerHTML = "";
  
  if (aiChats.length === 0) {
    container.innerHTML = `
      <div style="color: var(--muted); text-align: center; margin-top: 40px; font-size: 13px;">
        <p>No chat history yet</p>
        <p style="font-size: 11px; margin-top: 8px;">Start a new chat using the + button above.</p>
      </div>
    `;
    return;
  }
  
  aiChats.forEach(chat => {
    const item = document.createElement("div");
    item.className = "history-chat-item";
    if (chat.id === currentChatId) {
      item.classList.add("active");
    }
    
    item.innerHTML = `
      <div class="history-chat-title-wrapper" style="flex-grow: 1; overflow: hidden; display: flex; align-items: center;">
        <span class="history-chat-title" id="title-text-${chat.id}" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; font-weight: 500; font-size: 12px; max-width: 170px;">${chat.title}</span>
      </div>
      <div class="history-chat-actions">
        <button class="btn-icon-small btn-rename-chat" data-id="${chat.id}" title="Rename" style="padding: 2px;">
          <svg viewBox="0 0 24 24" style="width: 12px; height: 12px; fill: currentColor;"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <button class="btn-icon-small btn-delete-chat" data-id="${chat.id}" title="Delete" style="padding: 2px;">
          <svg viewBox="0 0 24 24" style="width: 12px; height: 12px; fill: var(--danger);"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
    `;
    
    item.addEventListener("click", () => {
      loadAiChat(chat.id);
    });
    
    const renameBtn = item.querySelector(".btn-rename-chat");
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startRenameChat(chat.id);
    });
    
    const deleteBtn = item.querySelector(".btn-delete-chat");
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteAiChat(chat.id);
    });
    
    container.appendChild(item);
  });
}

function startRenameChat(chatId) {
  const chat = aiChats.find(c => c.id === chatId);
  if (!chat) return;
  
  const titleTextEl = document.getElementById(`title-text-${chatId}`);
  const titleWrapper = titleTextEl.parentElement;
  const currentTitle = chat.title;
  
  titleWrapper.innerHTML = `
    <input type="text" id="rename-input-${chatId}" value="${currentTitle}" 
      style="width: 100%; font-size: 12px; padding: 2px 4px; height: 22px; border-radius: 2px; border: 1px solid var(--accent); background: var(--surface2); color: var(--text); outline: none; font-family: var(--font-sans);" />
  `;
  
  const input = document.getElementById(`rename-input-${chatId}`);
  input.focus();
  input.select();
  
  input.addEventListener("click", (e) => e.stopPropagation());
  
  const finishRename = () => {
    const val = input.value.trim();
    if (val && val !== currentTitle) {
      renameAiChat(chatId, val);
    } else {
      renderAiChatHistory();
    }
  };
  
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      finishRename();
    } else if (e.key === "Escape") {
      renderAiChatHistory();
    }
  });
  
  input.addEventListener("blur", finishRename);
}

function saveCurrentChatState(userText = null) {
  if (!currentChatId) return;
  const chat = aiChats.find(c => c.id === currentChatId);
  if (chat) {
    chat.messages = [...aiMessages];
    if (userText && (chat.title === "New Chat" || chat.title === "Diagnostic Scan")) {
      chat.title = userText.length > 25 ? userText.substring(0, 25) + "..." : userText;
    }
    saveAiChatsToStorage();
  }
}

function toggleAiSidebar(reason = "User initiated manual troubleshooting") {
  const isOpening = !sidebarAi.classList.contains("active");
  closeAllSidebars();
  if (isOpening) {
    sidebarAi.classList.add("active");
    document.body.classList.add("sidebar-open");
    
    if (reason.includes("Status panel") || reason.includes("failure")) {
      startNewAiChat("Diagnostic Scan");
      startAiDiagnostic(reason);
    } else {
      if (!currentChatId) {
        if (aiChats.length > 0) {
          loadAiChat(aiChats[0].id);
        } else {
          startNewAiChat();
        }
      }
      showAiActiveChatView();
    }
  }
}

if (btnTroubleshootAi) {
  btnTroubleshootAi.addEventListener("click", () => toggleAiSidebar("Status panel troubleshoot click"));
}

if (btnFloatingAi) {
  btnFloatingAi.addEventListener("click", () => toggleAiSidebar("Floating AI button click"));
}

if (btnViewerAi) {
  btnViewerAi.addEventListener("click", () => toggleAiSidebar("Viewer toolbar AI button click"));
}

if (btnHostAi) {
  btnHostAi.addEventListener("click", () => toggleAiSidebar("Host toolbar AI button click"));
}

// Global click-outside listener to close active sidebar
document.addEventListener("click", (e) => {
  const activeSidebar = document.querySelector(".sidebar.active");
  if (!activeSidebar) return;

  const isInsideSidebar = e.target.closest(".sidebar");
  const isToggleButton = e.target.closest("#btn-host-chat, #btn-viewer-chat, #btn-viewer-files, #btn-viewer-ai, #btn-host-ai, #btn-floating-ai, #btn-troubleshoot-ai, .btn-sidebar-ai-switch");

  if (!isInsideSidebar && !isToggleButton) {
    closeAllSidebars();
  }
});

// Escape key listener to close sidebars
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeAllSidebars();
  }
});

if (btnNewAiChat) {
  btnNewAiChat.addEventListener("click", () => startNewAiChat());
}

if (btnAiChatHistory) {
  btnAiChatHistory.addEventListener("click", () => {
    const isHistoryVisible = aiChatHistoryContainer.style.display === "flex";
    if (isHistoryVisible) {
      showAiActiveChatView();
    } else {
      showAiHistoryView();
    }
  });
}

if (aiChatForm) {
  aiChatForm.addEventListener("submit", sendAiChatMessage);
}

// Initial storage load and binding
loadAiChatsFromStorage();
if (aiChats.length > 0) {
  loadAiChat(aiChats[0].id);
} else {
  startNewAiChat();
}

async function startAiDiagnostic(failureReason) {
  aiMessages = [];
  aiChatMessages.innerHTML = "";
  
  appendAiMessage("System", "Starting diagnostic scan...", "ai-msg typing-msg");
  
  await new Promise(r => setTimeout(r, 800));

  const diagnostics = await gatherDiagnostics(failureReason);
  
  aiChatMessages.innerHTML = "";
  appendAiMessage("System", "Diagnostic scan completed. Analyzing network/system telemetry...", "ai-msg typing-msg");
  
  try {
    const responseText = await callTroubleshootApi(diagnostics, [], null);
    
    aiChatMessages.innerHTML = "";
    appendAiMessage("AI Assistant", responseText, "ai-msg");
    aiMessages.push({ role: "assistant", content: responseText });
    saveCurrentChatState();
  } catch (err) {
    aiChatMessages.innerHTML = "";
    appendAiMessage("AI Assistant", `Diagnostic analysis failed: ${err.message}. Please check if the signaling server is running.`, "ai-msg");
  }
}

async function sendAiChatMessage(e) {
  e.preventDefault();
  const userText = aiChatInput.value.trim();
  if (!userText) return;
  
  aiChatInput.value = "";
  
  const includeScreenCheckbox = document.getElementById("ai-include-screen");
  const shouldAttachScreen = includeScreenCheckbox && includeScreenCheckbox.checked;
  
  let screenshotBase64 = null;
  if (shouldAttachScreen) {
    screenshotBase64 = await captureCurrentScreen();
    if (includeScreenCheckbox) includeScreenCheckbox.checked = false;
  }
  
  const imgUrl = screenshotBase64 ? `data:image/jpeg;base64,${screenshotBase64}` : null;
  appendAiMessage("You", userText, "user-msg", imgUrl);
  aiMessages.push({ role: "user", content: userText });
  saveCurrentChatState(userText);
  
  const typingEl = appendAiMessage("AI Assistant", "Thinking...", "ai-msg typing-msg");
  
  try {
    const diagnostics = await gatherDiagnostics("Ongoing chat troubleshooting");
    const responseText = await callTroubleshootApi(diagnostics, aiMessages, screenshotBase64);
    
    typingEl.remove();
    appendAiMessage("AI Assistant", responseText, "ai-msg");
    aiMessages.push({ role: "assistant", content: responseText });
    saveCurrentChatState();
  } catch (err) {
    typingEl.remove();
    appendAiMessage("AI Assistant", `Failed to get response: ${err.message}`, "ai-msg");
  }
}

function appendAiMessage(sender, text, className, imageUrl = null) {
  const msgEl = document.createElement("div");
  msgEl.className = `chat-msg ${className}`;
  
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const escapedText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  
  let imgHtml = "";
  if (imageUrl) {
    imgHtml = `<div class="chat-screenshot-preview" style="margin-top: 8px;"><img src="${imageUrl}" style="max-width: 100%; border-radius: 4px; border: 1px solid var(--border);" /></div>`;
  }
  
  msgEl.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-msg-sender">${sender}</span>
      <span class="chat-msg-time">${timeStr}</span>
    </div>
    <div class="chat-msg-body">
      <div>${escapedText}</div>
      ${imgHtml}
    </div>
  `;
  
  aiChatMessages.appendChild(msgEl);
  aiChatMessages.scrollTop = aiChatMessages.scrollHeight;
  return msgEl;
}

async function gatherDiagnostics(failureReason) {
  let localIp = "unknown";
  if (hasTauri) {
    try {
      localIp = await invoke("get_local_ip") || "unknown";
    } catch (e) {
      console.warn("get_local_ip failed:", e);
    }
  }
  
  return {
    failureReason,
    userAgent: navigator.userAgent,
    isOnline: navigator.onLine,
    signalingUrl: SIGNALING_URL,
    signalingConnected,
    tunnelActive,
    tunnelSubdomain,
    localIp,
    webrtcState: pc ? pc.connectionState : "not_initialized",
    iceState: pc ? pc.iceConnectionState : "not_initialized",
    timestamp: new Date().toISOString()
  };
}

async function callTroubleshootApi(diagnostics, messages, image = null) {
  const httpBaseUrl = SIGNALING_URL.replace(/^ws/, "http");
  
  const response = await fetch(`${httpBaseUrl}/api/troubleshoot`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ diagnostics, messages, image })
  });
  
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || `HTTP error ${response.status}`);
  }
  
  const data = await response.json();
  return data.response;
}

