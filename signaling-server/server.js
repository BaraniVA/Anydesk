/**
 * RemoteLink Signaling Relay Server
 * 
 * Lightweight WebSocket relay for cross-network peer discovery and
 * WebRTC signaling (SDP/ICE exchange). Deploy free on Render.com.
 * 
 * Protocol: Same as the embedded Rust signaling server.
 * Each client gets a 9-digit Partner ID and 5-digit password on connect.
 */

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

// In-memory peer registry: Map<peerId, { ws, password }>
const peers = new Map();

// Generate a random N-digit numeric string
function randomDigits(n) {
  const min = Math.pow(10, n - 1);
  const max = Math.pow(10, n) - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

// Generate a unique 9-digit peer ID
function generatePeerId() {
  let id;
  do {
    id = randomDigits(9);
  } while (peers.has(id));
  return id;
}

// Simple HTTP health check endpoint (required by Render)
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", peers: peers.size }));
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("RemoteLink Signaling Server");
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  let peerId = null;

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) { return; }

    const msgType = data.type;
    if (!msgType) return;

    if (msgType === "resume") {
      const { id, password } = data;
      const peer = peers.get(id);
      if (peer && peer.password === password) {
        peerId = id;
        peer.ws = ws;
        ws.send(JSON.stringify({ type: "resume-ack", success: true }));
        return;
      }
      ws.send(JSON.stringify({ type: "resume-ack", success: false }));
      return;
    }

    if (!peerId) {
      peerId = generatePeerId();
      const password = randomDigits(5);
      peers.set(peerId, { ws, password });
      ws.send(JSON.stringify({ type: "init", id: peerId, password }));
    }

    switch (msgType) {
      case "ping": {
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      }
      case "update-password": {
        const newPwd = data.password;
        if (newPwd && peers.has(peerId)) {
          peers.get(peerId).password = newPwd;
          ws.send(JSON.stringify({ type: "update-password-ack", success: true, password: newPwd }));
        }
        break;
      }
      case "connect-request": {
        const targetId = (data.to || "").replace(/\s+/g, "");
        const targetPeer = peers.get(targetId);
        if (!targetPeer || targetPeer.password !== data.password) {
          ws.send(JSON.stringify({ type: "connect-response", success: false, error: "Invalid ID or password" }));
          return;
        }
        ws.send(JSON.stringify({ type: "connect-response", success: true, from: targetId }));
        targetPeer.ws.send(JSON.stringify({ type: "incoming-session", from: peerId }));
        break;
      }
      default: {
        const targetId = (data.to || "").replace(/\s+/g, "");
        const targetPeer = peers.get(targetId);
        if (targetPeer) {
          data.from = peerId;
          targetPeer.ws.send(JSON.stringify(data));
        }
      }
    }
  });

  ws.on("close", () => {
    if (peerId && peers.get(peerId)?.ws === ws) {
      // Don't delete immediately to allow for short resume windows
    }
  });
});

// Periodic cleanup of dead connections (every 30s)
setInterval(() => {
  for (const [id, peer] of peers) {
    if (peer.ws.readyState !== 1) { // Not OPEN
      peers.delete(id);
    }
  }
}, 30000);

httpServer.listen(PORT, () => {
  console.log(`RemoteLink Signaling Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});
