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

// Simple HTTP health check and troubleshooting endpoints
const httpServer = http.createServer((req, res) => {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify({ status: "ok", peers: peers.size }));
  } else if (req.url === "/api/troubleshoot" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json");

      try {
        const payload = JSON.parse(body);
        const { diagnostics, messages, image } = payload;

        const groqApiKey = process.env.GROQ_API_KEY;
        if (!groqApiKey) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Groq API Key is not configured on the server." }));
          return;
        }

        const systemPrompt = `You are RemoteLink AI, a helpful, intelligent, and general-purpose AI assistant integrated directly into RemoteLink (a secure desktop remote control application built with Tauri, Rust, and WebRTC).

Capabilities & Instructions:
1. You can answer general-purpose questions, explain concepts, write code, or just chat.
2. You can troubleshoot remote control, networking, WebRTC, signaling, or connection issues if the user is facing them. Here is the current system and application diagnostics telemetry:
${JSON.stringify(diagnostics, null, 2)}
3. If the user attaches a screenshot (an image of their screen), analyze the screenshot to answer their questions about what is on their screen. Be specific, point out elements they ask about, perform OCR, explain UI components, or troubleshoot visual bugs.
4. Keep your answers concise, clear, and actionable. Be professional, friendly, and direct.`;

        const apiMessages = [
          { role: "system", content: systemPrompt },
          ...messages
        ];

        const hasImage = !!image;
        if (hasImage) {
          const lastUserMsgIndex = apiMessages.map(m => m.role).lastIndexOf("user");
          if (lastUserMsgIndex !== -1) {
            const textContent = apiMessages[lastUserMsgIndex].content;
            apiMessages[lastUserMsgIndex].content = [
              { type: "text", text: textContent },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${image}`
                }
              }
            ];
          }
        }

        const modelToUse = hasImage ? "meta-llama/llama-4-scout-17b-16e-instruct" : "llama-3.1-8b-instant";

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${groqApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: modelToUse,
            messages: apiMessages,
            temperature: 0.5,
            max_tokens: 1024
          })
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Groq API returned ${response.status}: ${errText}`);
        }

        const data = await response.json();
        res.writeHead(200);
        res.end(JSON.stringify({ response: data.choices[0].message.content }));
      } catch (err) {
        console.error("Troubleshooting endpoint error:", err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Failed to process troubleshooting request: " + err.message }));
      }
    });
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
