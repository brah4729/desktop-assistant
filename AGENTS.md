# AGENTS.md

Context file for any AI coding agent (or future me) working on this project.
Read this first. Update it when decisions change.

Last full update: 2026-10-10.

## What this project is

**desktop-assistant**: an always-on-top, transparent desktop "pet" app for Windows 11.
It shows a 3D **VRM avatar** floating over other apps. You talk to it, a **local LLM**
(Ollama) answers, and the avatar speaks with lip movement and facial expressions.

Goal: everything runs **locally** (no cloud), on a normal laptop with no dedicated GPU.

## Current status

| Part | Status |
|---|---|
| Transparent overlay window, click-through | Works |
| VRM avatar, blink, expressions, arms down | Works |
| Text chat with Ollama | Works |
| Voice output: VoiceStudio TTS with real lip sync | Works |
| Voice output fallback: Windows `speechSynthesis` | Works (used only when VoiceStudio is not reachable) |
| Body gestures chosen by the LLM (`[wave]`, `[nod]`, ...) | Works |
| Voice input (push-to-talk) | Not built yet |
| Camera framing | Needs adjusting (chat bar covers the feet) |

Everything marked "Works" was run on the user's machine on 2026-10-10 (see "How to test").

## About the user (how to help)

- Student in software engineering, **beginner**. Explain *why*, not just *what*. Keep steps small.
- Wants answers in **English**.
- Web developer background (Next.js, Laravel, Tailwind). JavaScript is comfortable; Rust/Python less so.
- Prefers that code is written directly into this folder, then told how to run it.
- Be honest about what is untested. An agent with shell access **can** run the app here (see "How to test"),
  so test before claiming something works.

## Environment

- OS: Windows 11 Home. Laptop: Asus Zenbook 14 (UM3406HA).
- CPU: AMD Ryzen 7 8840HS (8 cores / 16 threads). GPU: AMD Radeon 780M, **integrated only, no NVIDIA**.
  So everything AI runs on the **CPU**. Do not assume CUDA.
- RAM: **16 GB** (15.3 GiB usable). It was 94% full during development, so memory is the tight resource.
- Display: 1920x1200 at 150% scaling. The 400x640 window is 600x960 real pixels.
- Project path: `C:\Users\Asus\Desktop\projects\desktop-assistant`
- Installed: Node 25, Bun, Ollama (with `qwen3.5:4b`), VoiceStudio 0.5.6 desktop app. `gh` is not installed.
- Package manager used so far: **Bun** (`bun.lock` exists). npm also works.
  Bun skips install scripts by default, so `package.json` needs
  `"trustedDependencies": ["electron"]` or Electron's binary won't download.
  **This line is not in `package.json` yet.** The binary is present now, but a fresh `bun install` would skip it.
- Model file: `1973449770481441636.vrm` (in this folder, user's own avatar). It is a **VRM 0.x** model.

## Files

| File | Role |
|---|---|
| `package.json` | Project config. `npm start` runs `electron .` |
| `main.js` | Electron main process: transparent / frameless / always-on-top window, click-through toggle, global quit shortcut, custom `app://` protocol, Ollama chat and VoiceStudio TTS via IPC |
| `preload.js` | Safe bridge exposing `window.overlay` (`setIgnore`, `chat`, `tts`, `quit`) |
| `index.html` | Transparent page, chat bar (`#ui`), import map for `three` and `@pixiv/three-vrm` |
| `renderer.js` | three.js scene, VRM loading, blink / expressions / mouth, body pose and gestures, system prompt, chat flow, `speak()` and audio playback |
| `AGENTS.md` | This file |

Dependencies: `electron`, `three`, `@pixiv/three-vrm` (installed from `node_modules`, not a CDN).

## Flow of one message

1. The user presses Enter in `#input` (`renderer.js`).
2. `window.overlay.chat(history)` goes through `preload.js` to `ipcMain.handle("chat")` in `main.js`, which calls Ollama.
3. The reply looks like `[happy][wave] Hello there!`. The renderer strips the tags, sets the face expression and shows the text in the bubble.
4. `speak(reply, onStart)` calls `window.overlay.tts(reply)`. `ipcMain.handle("tts")` asks VoiceStudio for a WAV and returns the bytes.
5. The renderer plays the WAV through an `AnalyserNode`. `updateFace()` reads the volume and opens the mouth.
6. At the moment the voice starts, `onStart` calls `playGesture("wave")`, so the body moves together with the voice.

## How it works (design decisions)

- **Window**: `transparent`, `frame: false`, `alwaysOnTop` at `"screen-saver"` level, `skipTaskbar`.
  Not `focusable: false`, because the chat input needs keyboard focus.
- **Click-through**: window starts with `setIgnoreMouseEvents(true, { forward: true })`.
  `renderer.js` raycasts on `mousemove`; click-through is turned **off** only when the mouse is over
  the avatar or `#ui`, and back **on** otherwise.
- **Custom `app://local/` protocol** (in `main.js`) serves project files. Reason: ES module imports and
  loading the `.vrm` via `fetch` are unreliable from `file://`. Path traversal outside the project folder is blocked.
- **Network calls happen in the main process**, not in the page, to avoid CORS. This is true for Ollama and for VoiceStudio.
- **Ollama** (`ipcMain.handle("chat")`):
  defaults `OLLAMA_URL=http://localhost:11434`, `OLLAMA_MODEL=qwen3.5:4b` (override with env vars or edit `main.js`).
  Request uses `stream:false`, `keep_alive:"30m"`, `num_ctx:2048`, `think:false` (retried without `think` if the model rejects it).
- **LLM output format**: the system prompt tells the model it has a 3D body (head, spine, arms, hands).
  It must start with one emotion tag `[happy] [sad] [angry] [surprised] [neutral]`, may add one gesture tag
  `[wave] [nod] [shake] [think] [bow] [cheer]`, then 1-2 short sentences. Example: `[happy][wave] Hello!`.
  `renderer.js` removes **every** `[word]` tag from the text (small models sometimes put a tag at the end),
  uses the first emotion and the first known gesture, and ignores unknown tags.
  The emotion maps to a VRM expression (resets after ~6 s).
- **Expressions on this model**: VRM 0.x has Joy, Angry, Sorrow, Fun. The library renames them to
  `happy`, `angry`, `sad`, `relaxed`. There is **no `surprised`**, so that tag shows a neutral face.
- **Performance on CPU**: render capped at 30 FPS, `setPixelRatio(1)`, chat history trimmed to the last few turns.
- **Body pose and gestures** (`renderer.js`, section "Body pose and gestures"):
  - `REST_POSE` is how the avatar stands. VRM loads in T-pose, so it lowers the upper arms (`left +1.2`, `right -1.2` on z).
  - `GESTURES` holds one entry per gesture: `seconds` and a `pose(t)` function that returns bone rotations `[x, y, z]`
    in radians for the time `t`. Bones a gesture does not mention stay in the rest pose.
  - `updateBody()` runs every frame, before `vrm.update()`. It blends rest pose -> gesture -> rest pose
    (`GESTURE_BLEND` seconds each way) and writes the rotations to the **normalized** humanoid bones.
  - Rotation order is `"ZYX"` (twist first, then lift), which keeps arm poses easy to write.
  - All numbers are written for **VRM 0.x**. `updateBody()` flips x and z when `vrm.meta.metaVersion` is not `"0"`.
    The VRM 0.x path was checked with screenshots; the **VRM 1.0 flip is not tested** (no such model here).
  - To add a gesture: add it to `GESTURES`, then describe its tag in `SYSTEM_PROMPT`, or the model never uses it.
  - Arms raised higher than about 0.8 rad above horizontal leave the 400 px wide window.
  - The gesture starts when the voice starts, not when the text appears (a wave should match the spoken "hello").
- **Autoplay**: `main.js` sets the `autoplay-policy=no-user-gesture-required` switch, so TTS audio can play
  even when no key press came right before it (needed later for push-to-talk with a global shortcut).
- **Emergency quit**: `Ctrl+Shift+Q` (global shortcut) and the red X button, because the window has no title bar.

## Voice output (TTS)

- Engine: **VoiceStudio** (github.com/debpalash/VoiceStudio), because it supports CPU-only use.
  **IndexTTS was rejected** for now: it needs an NVIDIA GPU with CUDA 12.8+ (and its language list did not include Indonesian).
- Endpoint (found in VoiceStudio's `backend/api/routers/openai_compat.py`, confirmed against the running 0.5.6 app):
  `POST http://127.0.0.1:3900/v1/audio/speech`, OpenAI-compatible, JSON body
  `{ model, input, voice, response_format }`. Loopback needs no credentials.
  - `model`: `"tts-1"` means "the engine that is active in VoiceStudio". An engine ID also works (`omnivoice`, `kittentts`).
    `GET /v1/models` lists them.
  - `voice`: `"default"`, or a voice profile name / ID. `GET /v1/audio/voices` lists them.
  - `response_format`: we use `"wav"`. The compressed formats (mp3, opus, aac, flac) need ffmpeg on the VoiceStudio side.
  - Optional `language` (ISO 639-1), `speed` and `num_step`. `input` is limited to 4096 characters.
  - The reply is a 24 kHz, 16-bit, mono WAV.
- Code: `speak(text)` in `renderer.js` calls `window.overlay.tts(text)`. The main process (`ipcMain.handle("tts")`)
  does the POST and returns the WAV bytes as an `ArrayBuffer`. `playAudio()` decodes them with an `AudioContext`
  and plays them through an `AnalyserNode`.
- **Lip sync is real for VoiceStudio audio**: `updateFace()` reads the volume (RMS) from the analyser and drives the
  `aa` expression. Tune with `MOUTH_GAIN` in `renderer.js`.
- **Fallback**: if VoiceStudio is not running or returns an error, `speak()` uses the browser `speechSynthesis`
  with a sine-wave mouth (that audio cannot be analysed). The reason is logged with `console.warn`.
- A new reply stops the audio that is still playing (`stopSpeaking()`), and `speakId` drops audio that arrives too late.
- Settings in `main.js` (or env vars): `VOICESTUDIO_URL`, `TTS_MODEL`, `TTS_VOICE`, `TTS_LANGUAGE`, `TTS_TIMEOUT_MS` (120 s).
- `speak()` is still the single place to swap the TTS engine.

### VoiceStudio setup on this machine

- Version 0.5.6, installed from the `.exe` on GitHub Releases. The documented script
  `irm https://voicestudio.sh/install | iex` returned 404 on 2026-10-10.
- The **desktop app must be open** for port 3900 to answer.
- Model pack: **Fast**. All four packs (Fast / Balanced / Quality / Max) use the same TTS model, OmniVoice.
  The tier only sets the work per sentence (8 / 16 / 32 / 64 steps), so Fast is the right one for CPU.
- Voices: `default` and two profiles: `d0510de3` (the user's cloned voice, **used by the app**)
  and `demo0001` ("VoiceStudio Demo Voice"). `TTS_VOICE` in `main.js` selects one.
- Measured speed (OmniVoice, CPU): 4.7 to 6.2 s to make 5 to 6 s of speech.
  In the app the voice starts about 4 s after the reply text appears.
- Ideas not tried yet: KittenTTS (lighter, English only, `TTS_MODEL="kittentts"`), a custom voice profile,
  Indonesian (`TTS_LANGUAGE="id"`, OmniVoice supports it; the system prompt must also ask for Indonesian).
- License: VoiceStudio is AGPL-3.0, models have their own licenses. We only call its HTTP API.

## Voice input (speech to text): PLANNED, not built yet

Goal: replace the text box with push-to-talk (hold a key or button, speak, release).

Findings that shape the design:

- Do **not** use the browser `SpeechRecognition` API. It generally does not work in Electron (no Google speech keys),
  and it is cloud-based anyway.
- VoiceStudio's local speech service (from `docs/speech-platform.md`; the discovery URL answered on this machine,
  the transcription endpoints are **not tested yet**):
  - Batch, OpenAI-compatible: `POST http://127.0.0.1:3900/v1/audio/transcriptions` (send an audio file, multipart).
  - Live streaming: `ws://127.0.0.1:3900/v1/audio/transcriptions/stream`
    - sends binary WebM/Opus frames by default; raw 16-bit mono PCM with `?pcm=1&sr=16000`;
    - finish with `{"type":"input_audio.end"}`;
    - replies with `{"type":"partial","text":...}` and `{"type":"final","text":...}`.
  - Loopback (`127.0.0.1`) needs no credentials.
  - Discovery: `GET http://127.0.0.1:3900/.well-known/voicestudio-speech`.
  - Requires the VoiceStudio desktop app to be running. It needs an ASR model; check that the Fast pack installed one.
- Planned approach (simplest first): in the renderer, record the mic with `MediaRecorder` while the key is held,
  send the audio to the main process over IPC, and POST it to `/v1/audio/transcriptions` from the main process
  (avoids CORS, like Ollama). Put the transcript through the same chat flow as typed text.
  Upgrade to the WebSocket streaming endpoint later if latency matters.
- Needs mic permission handling in Electron (`session.setPermissionRequestHandler`).
- Keep the text box as a fallback (useful when no mic or when VoiceStudio is not running).
- Show clear status in the bubble: "Listening...", "Transcribing...", and a helpful error if VoiceStudio is not reachable.

## Resource budget (16 GB RAM)

Estimates: Windows ~4-5 GB, Electron overlay ~0.5 GB, 4B LLM ~3-4 GB, 8B LLM ~6-7 GB.

Measured on 2026-10-10: `qwen3.5:4b` takes 3.1 GB in Ollama. VoiceStudio took about 1 GB while idle
(desktop app ~0.6 GB, Python backend ~0.4 GB); it likely uses more while it generates speech.

Recommended LLM: Qwen3.5 4B or Gemma 4 E4B. Qwen3 8B is possible but tight. Avoid 12B+ on CPU.
Keep replies short (1-2 sentences): the biggest speed win, since LLM and TTS both run on the same CPU.

Measured timing for one short reply: LLM about 12 s when Ollama must load the model first (faster after that,
the model stays loaded for 30 minutes), then about 4 s for the voice.

## Run

```bash
bun install            # or: npm install electron three @pixiv/three-vrm
ollama pull qwen3.5:4b # or change OLLAMA_MODEL in main.js
# open the VoiceStudio desktop app (optional: without it the Windows voice is used)
npm start              # or: bunx electron .
```

Quit with `Ctrl+Shift+Q`.

## How to test (for agents)

The app can be started and driven from a script, without the user:

1. Start it with a DevTools port: `node_modules/electron/dist/electron.exe . --remote-debugging-port=9333`.
2. Read `http://127.0.0.1:9333/json`, open the page's `webSocketDebuggerUrl`, and use the Chrome DevTools Protocol:
   - `Runtime.evaluate` to set `#input` and dispatch an Enter `keydown` (this runs the real chat flow);
   - `Page.captureScreenshot` to look at the avatar (arms, mouth, expression);
   - `WebAudio.enable` and the `WebAudio.audioNodeCreated` event (`AudioBufferSource`) to see when TTS playback starts;
   - `Runtime.consoleAPICalled` to collect warnings and errors.
3. To test without VoiceStudio, start a small HTTP server that answers `POST /v1/audio/speech` with a WAV
   and set `VOICESTUDIO_URL` to it. The same trick works for the LLM: a fake server on `OLLAMA_URL` that answers
   `POST /api/chat` with `{"message":{"content":"[neutral][wave] Test."}}` triggers any gesture on demand.
   A silent WAV keeps the test quiet.
4. Quit with `window.overlay.quit()`.

Things to know: module variables in `renderer.js` (`speak`, `vrm`, ...) are not reachable from `Runtime.evaluate`,
and a real test plays sound on the user's speakers.

## Known issues / unverified

- The chat bar covers the avatar's feet. Camera framing (`camera.position` / `lookAt` in `renderer.js`) needs adjusting.
- The `[surprised]` tag shows a neutral face (see "Expressions on this model"). Option: use `relaxed` instead.
- `qwen3.5:4b` follows the tag format well, but sometimes adds a gesture that does not fit
  (for example `[wave]` on a normal answer). Tune the wording in `SYSTEM_PROMPT` if that gets annoying.
- Gestures are simple hand-written rotations: no finger movement, no idle animation, and a new gesture replaces the running one.
- The voice starts a few seconds after the text. Sentence-by-sentence streaming (roadmap) would shorten the wait.
- The first TTS call after starting VoiceStudio can be slower (model load). After 120 s the Windows voice is used.
- `THREE.Clock` is deprecated since three r183 (console warning only). Replace with `THREE.Timer` some day.
- Electron prints a Content-Security-Policy warning in the console. Harmless during development.
- The folder check in the `app://` handler uses `startsWith(__dirname)`, which would also accept a sibling folder
  whose name starts with `desktop-assistant`. Low risk for a local app.
- `package.json` has no `"trustedDependencies": ["electron"]` (see "Environment").
- Clicking the chat bar steals keyboard focus from the previously active app.
- Some fullscreen apps and games can still cover an always-on-top window.
- `speechSynthesis` voices (fallback only) vary by Windows install; Indonesian voice may be missing.

## Roadmap

Done: text chat, arms, VoiceStudio TTS with audio-driven lip sync, LLM-chosen body gestures.

1. Fix camera framing.
2. Add push-to-talk voice input via VoiceStudio STT (see "Voice input").
3. Sentence-by-sentence streaming (speak sentence 1 while the LLM writes the rest).
4. Optional: custom voice profile, Indonesian, drag to move the window, idle animations, tray icon,
   switch to Tauri to cut RAM.
