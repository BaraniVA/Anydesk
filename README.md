# RemoteLink

RemoteLink is a high-performance, lightweight, single-binary remote desktop application built using **Tauri v2** and **Rust**. The application functions as both host (sharing screen) and viewer (viewing and controlling the remote screen) from the same executable. It utilizes a WebRTC connection for direct P2P streaming, input relaying, chat, and file transfers, meaning signaling is only used for the initial handshake and no media data goes through external servers.

---

## Features
- **One Binary, Two Roles:** The same executable runs as either host or viewer.
- **Embedded Signaling Server:** Runs locally inside the host app on port `3000` via Axum.
- **Pure WebRTC P2P:** All screen frames, mouse/keyboard inputs, text messages, and file transfers travel directly between devices.
- **Optimized Video Stream:** JPEG frames encoded at quality 65 are sent as binary arrays and rendered using local object URLs.
- **Technical UI:** Engineered styling featuring a responsive dark mode interface, unread chat notifications, real-time latency indicators, and file upload progress tracking.
- **Frameless Window:** Modern, titlebarless window with custom close, minimize, maximize, and drag interactions.

---

## Directory Structure
```text
remote-desk/
├── src-tauri/
│   ├── Cargo.toml          # Rust dependencies
│   ├── tauri.conf.json     # Tauri app configurations
│   ├── capabilities/       # Tauri v2 permission files
│   └── src/
│       ├── main.rs         # Application entry point
│       ├── server.rs       # Axum WebSocket signaling server
│       ├── capture.rs      # Cross-platform screen capture
│       ├── input.rs        # Mouse/keyboard input injection
│       └── commands.rs     # Tauri IPC commands
├── src/
│   ├── index.html          # SPA markup
│   ├── main.js             # WebRTC client & DOM controllers
│   └── style.css           # Custom technical dark stylesheet
├── package.json            # Node configuration scripts
└── README.md               # Setup and usage instructions
```

---

## Getting Started

### Prerequisites

#### Windows
- Install [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
- Install [Rust](https://www.rust-lang.org/tools/install).
- Install [Node.js](https://nodejs.org/).

#### macOS
- Install Xcode Command Line Tools: `xcode-select --install`.
- Install Rust and Node.js.

#### Linux
- Install development libraries for X11 & input simulation:
  ```bash
  sudo apt install libxtst-dev libxdo-dev
  ```
- *Note:* Wayland is **not** supported by Enigo/Screenshots crates out of the box. Ensure you are running under an **X11** desktop session.

---

## Development

1. **Install Frontend Dependencies:**
   ```bash
   npm install
   ```

2. **Run Dev Environment:**
   This starts the Vite dev server and links it with the Tauri development loop.
   ```bash
   npm run tauri dev
   ```

---

## Building the Installer

Compile the final production release using the following command:
```bash
npm run tauri build
```

This compiles optimized binaries and packages them into platform-specific installers:
- **Windows:** `src-tauri/target/release/bundle/msi/RemoteLink_0.1.0_x64.msi`
- **macOS:** `src-tauri/target/release/bundle/dmg/RemoteLink_0.1.0_x64.dmg`
- **Linux:** `src-tauri/target/release/bundle/deb/remote-link_0.1.0_amd64.deb`

---

## Usage Instructions

### Connecting over Local LAN
1. **On Host Laptop:** Open the app and click **Start Hosting**.
2. **On Viewer Laptop:** Type the host's address shown (e.g. `192.168.1.5:3000`) and click **Connect**.
3. **On Host Laptop:** Click **Accept** on the confirmation dialog to establish the connection.

### Connecting over Internet (Different Networks)
If the two laptops are not on the same network, follow this method to route the signaling server without paid tools:
1. **On Host Laptop:** Click **Start Hosting** to spin up the local server.
2. **On Host Laptop:** Run this command in a terminal to start an SSH tunnel:
   ```bash
   ssh -R 80:localhost:3000 serveo.net
   ```
3. **Copy URL:** Serveo will print a public URL in your terminal (e.g. `abcxyz.serveo.net`).
4. **On Viewer Laptop:** Type the public URL into the connection bar and click **Connect**.
5. **On Host Laptop:** Approve the incoming request. All screen data and controls will flow directly peer-to-peer over the WebRTC datachannels.

---

## Platform-Specific Troubleshooting

### macOS Permissions
Tauri will prompt for screen recording and accessibility permissions.
1. Add `NSScreenCaptureUsageDescription` and `NSAppleEventsUsageDescription` to your `Info.plist` if compiling manually on Mac.
2. Enable permissions under **System Settings** -> **Privacy & Security** -> **Screen Recording** & **Accessibility**.

### Linux Sessions
- Verify your `$XDG_SESSION_TYPE` is `x11`. If running on Wayland, log out and select "Ubuntu on Xorg" or the X11 equivalent from your display manager login screen.