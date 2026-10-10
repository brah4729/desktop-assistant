# AGENTS.md

Context file for any AI coding agent (or future me) working on this project.
Read this first. Update it when decisions change.

## What this project is

**desktop-assistant**: an always-on-top, transparent desktop "pet" app for Windows 11.
It shows a 3D **VRM avatar** floating over other apps. You talk to it, a **local LLM**
(Ollama) answers, and the avatar speaks with lip movement and facial expressions.

Goal: everything runs **locally** (no cloud), on a normal laptop with no dedicated GPU.

## About the user (how to help)

- Student in software engineering, **beginner**. Explain *why*, not just *what*. Keep steps small.
- Wants answers in **English**.
- Web developer background (Next.js, Laravel, Tailwind). JavaScript is comfortable; Rust/Python less so.
- Prefers that code is written directly into this folder, then told how to run it.
- Be honest about what is untested. The agent usually cannot run the app on the user's machine.

## Environment

- OS: Windows 11. Laptop: Asus Zenbook, **16 GB RAM**, probably **no NVIDIA GPU** (not confirmed).
  Assume CPU-only. Do not assume CUDA.
- Project path: `C:\Users\Asus\Desktop\projects\desktop-assistant`
- Package manager used so far: **Bun** (`bun.lock` exists). npm also works.
  Bun skips install scripts by default, so `package.json` needs
  `"trustedDependencies": ["electron"]` or Electron's binary won't download.
- Model file: `1973449770481441636.vrm` (in this folder, user's own avatar).

## Files

| File | Role |
|---|---|
| `package.json` | Project config. `npm start` runs `electron .` |
| `main.js` | Electron main process: transparent / frameless / always-on-top window, click-through toggle, global quit shortcut, custom `app://` protocol, Ollama chat and VoiceStudio TTS via IPC |
| `preload.js` | Safe bridge exposing `window.overlay` (`setIgnore`, `chat`, `tts`, `quit`) |
| `index.html` | Transparent page, chat bar (`#ui`), import map for `three` and `@pixiv/three-vrm` |
| `renderer.js` | three.js scene, VRM loading, blink / expressions / mouth, chat flow, `speak()` |
| `AGENTS.md` | This file |

Dependencies: `electron`, `three`, `@pixiv/three-vrm` (installed from `node_modules`, not a CDN).

## How it works (design decisions)

- **Window**: `transparent`, `frame: false`, `alwaysOnTop` at `"screen-saver"` level, `skipTaskbar`.
  Not `focusable: false`, because the chat input needs keyboard focus.
- **Click-through**: window starts with `setIgnoreMouseEvents(true, { forward: true })`.
  `renderer.js` raycasts on `mousemove`; click-through is turned **off** only when the mouse is over
  the avatar or `#ui`, and back **on** otherwise.
- **Custom `app://local/` protocol** (in `main.js`) serves project files. Reason: ES module imports and
  loading the `.vrm` via `fetch` are unreliable from `file://`. Path traversal outside the project folder is blocked.
- **Ollama is called from the main process** (`ipcMain.handle("chat")`), not from the page, to avoid CORS.
  Defaults: `OLLAMA_URL=http://localhost:11434`, `OLLAMA_MODEL=qwen3.5:4b` (override with env vars or edit `main.js`).
  Request uses `stream:false`, `keep_alive:"30m"`, `num_ctx:2048`, `think:false` (retried without `think` if the model rejects it).
- **LLM output format**: system prompt makes the model start with one tag
  `[happy] [sad] [angry] [surprised] [neutral]`, then 1-2 short sentences.
  `renderer.js` strips the tag and maps it to a VRM expression (resets after ~6 s).
- **Performance on CPU**: render capped at 30 FPS, `setPixelRatio(1)`, chat history trimmed to the last few turns.
- **Arms**: VRM loads in T-pose, so `setArmsDown()` rotates the upper arms (`left +1.2`, `right -1.2` on z).
  Checked with a screenshot of the current model, which is **VRM 0.x**. A VRM 1.0 model needs the opposite signs.
- **Emergency quit**: `Ctrl+Shift+Q` (global shortcut) and the red X button, because the window has no title bar.

## Voice output (TTS)

- Engine: **VoiceStudio** (github.com/debpalash/VoiceStudio), because it supports CPU-only use.
  **IndexTTS was rejected** for now: it needs an NVIDIA GPU with CUDA 12.8+ (and its language list did not include Indonesian).
- Endpoint (read from VoiceStudio's `backend/api/routers/openai_compat.py`, release 0.5.7):
  `POST http://127.0.0.1:3900/v1/audio/speech`, OpenAI-compatible, JSON body
  `{ model, input, voice, response_format }`. Loopback needs no credentials.
  - `model`: `"tts-1"` means "the engine that is active in VoiceStudio". An engine ID also works (`kittentts`, `omnivoice`, ...).
  - `voice`: `"default"`, or a voice profile name / ID. `GET /v1/audio/voices` lists them.
  - `response_format`: we use `"wav"`. The compressed formats (mp3, opus, aac, flac) need ffmpeg on the VoiceStudio side.
  - Optional `language` (ISO 639-1) and `speed`. `input` is limited to 4096 characters.
- Flow: `speak(text)` in `renderer.js` calls `window.overlay.tts(text)`. The main process (`ipcMain.handle("tts")`)
  does the POST (no CORS problems, same idea as Ollama) and returns the WAV bytes. The renderer decodes them with an
  `AudioContext` and plays them through an `AnalyserNode`.
- **Lip sync is real for VoiceStudio audio**: `updateFace()` reads the volume (RMS) from the analyser and drives the
  `aa` expression. Tune with `MOUTH_GAIN` in `renderer.js`.
- **Fallback**: if VoiceStudio is not running or returns an error, `speak()` uses the browser `speechSynthesis`
  with the old sine-wave mouth. The reason is logged with `console.warn`.
- Settings in `main.js` (or env vars): `VOICESTUDIO_URL`, `TTS_MODEL`, `TTS_VOICE`, `TTS_LANGUAGE`, `TTS_TIMEOUT_MS`.
- `speak()` is still the single place to swap the TTS engine.
- On CPU, pick a light engine in VoiceStudio's Model Catalogue (KittenTTS, Supertonic-3, PocketTTS). OmniVoice covers
  far more languages (Indonesian included) but is slower on CPU.
- **Tested on the user's machine (2026-10-10)** with VoiceStudio 0.5.6, "Fast" model pack, OmniVoice engine, CPU only:
  the whole path works (chat, IPC, WAV decode, playback, mouth movement). The audio is 24 kHz 16-bit mono WAV.
  Measured: about 4 to 6 s to make 5 to 6 s of speech, so the voice starts about 4 s after the text appears.
  The LLM reply took about 12 s when Ollama had to load the model first.
- VoiceStudio install: the `irm https://voicestudio.sh/install | iex` script returned 404 on that date.
  Use the `.exe` from GitHub Releases instead. The desktop app must be open for port 3900 to answer.
- Voices on this install: `default` and one profile, `demo0001` ("VoiceStudio Demo Voice").
- License: VoiceStudio is AGPL-3.0, models have their own licenses. We only call its HTTP API.

## Voice input (speech to text): PLANNED, not built yet

Goal: replace the text box with push-to-talk (hold a key or button, speak, release).

Findings that shape the design:

- Do **not** use the browser `SpeechRecognition` API. It generally does not work in Electron (no Google speech keys),
  and it is cloud-based anyway.
- VoiceStudio's local speech service (verified in `docs/speech-platform.md`):
  - Batch, OpenAI-compatible: `POST http://127.0.0.1:3900/v1/audio/transcriptions` (send an audio file, multipart).
  - Live streaming: `ws://127.0.0.1:3900/v1/audio/transcriptions/stream`
    - sends binary WebM/Opus frames by default; raw 16-bit mono PCM with `?pcm=1&sr=16000`;
    - finish with `{"type":"input_audio.end"}`;
    - replies with `{"type":"partial","text":...}` and `{"type":"final","text":...}`.
  - Loopback (`127.0.0.1`) needs no credentials.
  - Discovery: `GET http://127.0.0.1:3900/.well-known/voicestudio-speech`.
  - Requires the VoiceStudio desktop app (or its backend) to be running.
- Planned approach (simplest first): in the renderer, record the mic with `MediaRecorder` while the key is held,
  send the audio to the main process over IPC, and POST it to `/v1/audio/transcriptions` from the main process
  (avoids CORS, like Ollama). Put the transcript through the same chat flow as typed text.
  Upgrade to the WebSocket streaming endpoint later if latency matters.
- Needs mic permission handling in Electron (`session.setPermissionRequestHandler`).
- Keep the text box as a fallback (useful when no mic or when VoiceStudio is not running).
- Show clear status in the bubble: "Listening...", "Transcribing...", and a helpful error if VoiceStudio is not reachable.

## Resource budget (16 GB RAM, estimates)

Windows ~4-5 GB, Electron overlay ~0.5 GB, 4B LLM ~3-4 GB, 8B LLM ~6-7 GB, plus the TTS/STT models.
Recommended LLM: Qwen3.5 4B or Gemma 4 E4B. Qwen3 8B is possible but tight. Avoid 12B+ on CPU.
Keep replies short (1-2 sentences): the biggest speed win, since LLM and TTS both run on the same CPU.

## Run

```bash
bun install            # or: npm install electron three @pixiv/three-vrm
ollama pull qwen3.5:4b # or change OLLAMA_MODEL in main.js
npm start              # or: bunx electron .
```

Quit with `Ctrl+Shift+Q`.

## Known issues / unverified

- The app starts, the VRM loads, the Ollama chat works and VoiceStudio TTS speaks on the user's machine (checked 2026-10-10).
- The model has no `surprised` expression (VRM 0.x has Joy, Angry, Sorrow, Fun only), so the `[surprised]` tag shows a neutral face.
- The chat bar covers the avatar's feet. Camera framing (`camera.position` / `lookAt` in `renderer.js`) may need adjusting.
- Clicking the chat bar steals keyboard focus from the previously active app.
- Some fullscreen apps and games can still cover an always-on-top window.
- `speechSynthesis` voices vary by Windows install; Indonesian voice may be missing.

## Roadmap

1. Fix camera framing (text version runs, arms are fixed).
2. Add push-to-talk voice input via VoiceStudio STT (see above).
3. Done: VoiceStudio TTS with audio-driven lip sync. Possible follow-up: lighter engine (KittenTTS) or a custom voice profile.
4. Sentence-by-sentence streaming (speak sentence 1 while the LLM writes the rest).
5. Optional: drag to move the window, idle animations, tray icon, switch to Tauri to cut RAM.
