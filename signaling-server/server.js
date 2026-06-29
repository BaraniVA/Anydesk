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
  const peerId = generatePeerId();
  const password = randomDigits(5);

  peers.set(peerId, { ws, password });
  console.log(`[+] Peer connected: ${peerId} (total: ${peers.size})`);

  // Send init message with assigned ID and password
  ws.send(JSON.stringify({
    type: "init",
    id: peerId,
    password: password
  }));

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    const msgType = data.type;
    if (!msgType) return;

    switch (msgType) {
      case "ping": {
        const peer = peers.get(peerId);
        if (peer) peer.ws.send(JSON.stringify({ type: "pong" }));
        break;
      }

      case "update-password": {
        const newPwd = data.password;
        if (newPwd && peers.has(peerId)) {
          peers.get(peerId).password = newPwd;
          ws.send(JSON.stringify({
            type: "update-password-ack",
            success: true,
            password: newPwd
          }));
        }
        break;
      }

      case "connect-request": {
        const targetId = (data.to || "").replace(/\s+/g, "");
        const submittedPwd = data.password || "";

        const targetPeer = peers.get(targetId);
        if (!targetPeer) {
          ws.send(JSON.stringify({
            type: "connect-response",
            success: false,
            error: "Partner is offline or not found"
          }));
          return;
        }

        if (targetPeer.password !== submittedPwd) {
          ws.send(JSON.stringify({
            type: "connect-response",
            success: false,
            error: "Incorrect password"
          }));
          return;
        }

        // Authentication passed — notify both sides
        ws.send(JSON.stringify({
          type: "connect-response",
          success: true,
          from: targetId
        }));

        targetPeer.ws.send(JSON.stringify({
          type: "incoming-session",
          from: peerId
        }));
        break;
      }

      default: {
        // Relay signaling messages (offer, answer, ice) to the target peer
        const targetId = (data.to || "").replace(/\s+/g, "");
        if (!targetId) return;

        const targetPeer = peers.get(targetId);
        if (targetPeer) {
          data.from = peerId;
          targetPeer.ws.send(JSON.stringify(data));
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    peers.delete(peerId);
    console.log(`[-] Peer disconnected: ${peerId} (total: ${peers.size})`);
  });

  ws.on("error", () => {
    peers.delete(peerId);
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
