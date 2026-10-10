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
const TTS_VOICE = process.env.TTS_VOICE || "default"; // or a voice profile name / ID from VoiceStudio
const TTS_LANGUAGE = process.env.TTS_LANGUAGE || ""; // e.g. "en" or "id"; empty = let the engine decide
const TTS_TIMEOUT_MS = 120000; // CPU speech can be slow, and the first call also loads the model
const WINDOW_WIDTH = 400;
const WINDOW_HEIGHT = 640;
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
