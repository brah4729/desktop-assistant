// main.js - Electron main process
// Creates a transparent, frameless, always-on-top window and talks to Ollama.

const { app, BrowserWindow, screen, ipcMain, protocol, net, globalShortcut } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

// ---------- Settings you can change ----------
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3.5:4b"; // run `ollama list` to see yours
const VOICESTUDIO_URL = process.env.VOICESTUDIO_URL || "http://127.0.0.1:3900";
const TTS_MODEL = process.env.TTS_MODEL || "tts-1"; // "tts-1" = the engine that is active in VoiceStudio
const TTS_VOICE = process.env.TTS_VOICE || "d0510de3"; // voice profile ID from VoiceStudio ; "default" = the engine's own voice
const TTS_LANGUAGE = process.env.TTS_LANGUAGE || ""; // e.g. "en" or "id"; empty = let the engine decide
const TTS_TIMEOUT_MS = 120000; // CPU speech can be slow, and the first call also loads the model
const WINDOW_WIDTH = 400;
const WINDOW_HEIGHT = 640;
const MIN_ZOOM = 0.5; // smallest size when you scroll (1 = the window size above). Smaller makes the text unreadable
const ZOOM_SPEED = 0.001; // how much one step of the mouse wheel resizes the avatar
// ---------------------------------------------

// Let the page play the TTS audio even when no key or click came right before it
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Serve our own files through a custom "app://" protocol.
// This avoids problems with loading modules and the .vrm file from file://
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: width - WINDOW_WIDTH,
    y: height - WINDOW_HEIGHT,
    transparent: true, // see-through background
    frame: false, // no title bar or border
    alwaysOnTop: true, // float above other windows
    skipTaskbar: true, // no taskbar button
    hasShadow: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // "screen-saver" level keeps it above most other windows
  win.setAlwaysOnTop(true, "screen-saver");

  // Start click-through; the page turns this off while the mouse is over the avatar or the UI
  win.setIgnoreMouseEvents(true, { forward: true });

  // Chromium can remember the page zoom of an earlier run, so set ours again on every load
  win.webContents.on("did-finish-load", () => win.webContents.setZoomFactor(zoom));

  win.loadURL("app://local/index.html");
}

app.whenReady().then(() => {
  // Map app://local/<path> to files inside this project folder
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const requested = decodeURIComponent(url.pathname);
    const filePath = path.normalize(path.join(__dirname, requested));

    // Safety: never serve anything outside the project folder
    if (!filePath.startsWith(__dirname)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  createWindow();

  // Emergency exit, because this window has no title bar:  Ctrl + Shift + Q
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());

// The renderer asks us to toggle click-through
ipcMain.on("set-ignore", (event, ignore) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on("quit", () => app.quit());

// ---------- Drag and zoom ----------
// The avatar never moves inside the page. To move or resize it, we move or resize the whole window.
let zoom = 1; // 1 = WINDOW_WIDTH x WINDOW_HEIGHT
let dragTimer = null;

function windowSize() {
  return { width: Math.round(WINDOW_WIDTH * zoom), height: Math.round(WINDOW_HEIGHT * zoom) };
}

function stopDrag() {
  clearInterval(dragTimer);
  dragTimer = null;
}

// While the mouse button is held down on the avatar, the window follows the mouse.
// We ask the system where the mouse is, instead of using the mouse events of the page,
// because the page itself moves under the mouse.
ipcMain.on("drag-start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || dragTimer) return;
  const mouseStart = screen.getCursorScreenPoint();
  const winStart = win.getBounds();

  dragTimer = setInterval(() => {
    if (win.isDestroyed()) return stopDrag();
    const mouse = screen.getCursorScreenPoint();
    const size = windowSize();
    // setBounds with the size every time: moving alone can slowly change the size on a scaled display
    win.setBounds({
      x: winStart.x + mouse.x - mouseStart.x,
      y: winStart.y + mouse.y - mouseStart.y,
      width: size.width,
      height: size.height,
    });
  }, 16); // about 60 times per second
});

ipcMain.on("drag-end", stopDrag);

// Mouse wheel over the avatar: make the whole window bigger or smaller.
// The page is zoomed by the same factor, so the avatar, the bubble and the text scale together
// and the page still sees itself as WINDOW_WIDTH x WINDOW_HEIGHT.
ipcMain.on("zoom", (event, deltaY) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || dragTimer) return;
  const mouse = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(mouse).workArea;
  const maxZoom = Math.min(area.width / WINDOW_WIDTH, area.height / WINDOW_HEIGHT); // never bigger than the screen
  const old = win.getBounds();

  // Scrolling up gives a negative deltaY, and that makes the avatar bigger
  zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, zoom * Math.exp(-(Number(deltaY) || 0) * ZOOM_SPEED)));
  const size = windowSize();

  // Keep the point under the mouse in place, so the mouse stays on the avatar while you scroll
  const fx = Math.min(1, Math.max(0, (mouse.x - old.x) / old.width));
  const fy = Math.min(1, Math.max(0, (mouse.y - old.y) / old.height));
  win.setBounds({
    x: Math.round(mouse.x - fx * size.width),
    y: Math.round(mouse.y - fy * size.height),
    width: size.width,
    height: size.height,
  });
  win.webContents.setZoomFactor(zoom);
});

// Chat with Ollama from the main process (this avoids browser CORS problems)
async function callOllama(messages, withThinkFlag) {
  const body = {
    model: OLLAMA_MODEL,
    messages,
    stream: false,
    keep_alive: "30m", // keep the model in RAM between messages
    options: { num_ctx: 2048 }, // small context = less RAM, faster on CPU
  };
  if (withThinkFlag) body.think = false; // skip "thinking" mode for speed

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.message.content;
}

ipcMain.handle("chat", async (_event, messages) => {
  try {
    try {
      return { ok: true, text: await callOllama(messages, true) };
    } catch (err) {
      // Some models reject the "think" option, so retry without it
      if (String(err.message).toLowerCase().includes("think")) {
        return { ok: true, text: await callOllama(messages, false) };
      }
      throw err;
    }
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach Ollama (${OLLAMA_URL}, model "${OLLAMA_MODEL}"). ${err.message}`,
    };
  }
});

// Text to speech with VoiceStudio (OpenAI-compatible endpoint), also from the main process.
// We ask for WAV because VoiceStudio can make it without ffmpeg and the page can decode it.
ipcMain.handle("tts", async (_event, text) => {
  try {
    const body = { model: TTS_MODEL, input: text, voice: TTS_VOICE, response_format: "wav" };
    if (TTS_LANGUAGE) body.language = TTS_LANGUAGE;

    const res = await fetch(`${VOICESTUDIO_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`VoiceStudio error ${res.status}: ${await res.text()}`);
    }
    return { ok: true, audio: await res.arrayBuffer() };
  } catch (err) {
    return { ok: false, error: `VoiceStudio TTS failed (${VOICESTUDIO_URL}). ${err.message}` };
  }
});
