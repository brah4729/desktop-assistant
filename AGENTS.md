# AGENTS.md

Context file for any AI coding agent (or future me) working on this project.
Read this first. Update it when decisions change.

Last full update: 2026-10-10. Updated 2026-10-11: camera framing, drag, zoom, push-to-talk.

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
| Voice input (push-to-talk): hold the mic button, or `Alt+Shift+Space` to start and stop | Works in the scripted test with a fake microphone; **not tried with a real voice yet** |
| Camera framing (whole avatar visible above the chat bar) | Works |
| Drag the avatar to move it | Works in the scripted test; not confirmed by hand |
| Mouse wheel on the avatar resizes only the avatar (chat bar stays fixed) | Works in the scripted test; not confirmed by hand |

Everything marked "Works" was run on the user's machine on 2026-10-10 (see "How to test").
Camera framing was changed and checked with screenshots on 2026-10-11. Drag and zoom were added and tested the same day (zoom was reworked once: it first resized the whole window and the chat bar with it).
Push-to-talk was added and tested on 2026-10-11.

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
- Display: 1920x1200 at 150% scaling. The window is 540x800 here (810x1200 real pixels); the avatar picture inside it is 400x640 at normal size.
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
| `main.js` | Electron main process: transparent / frameless / always-on-top window, click-through toggle, drag of the window, global quit shortcut, global talk shortcut, microphone permission, custom `app://` protocol, Ollama chat, VoiceStudio TTS and STT via IPC |
| `preload.js` | Safe bridge exposing `window.overlay` (`setIgnore`, `chat`, `tts`, `transcribe`, `onTalkToggle`, `dragStart`, `dragEnd`, `quit`) |
| `index.html` | Transparent page, chat bar (`#ui`) with text box, mic button and quit button, import map for `three` and `@pixiv/three-vrm` |
| `renderer.js` | three.js scene, VRM loading, blink / expressions / mouth, body pose and gestures, drag handlers, avatar size (wheel zoom), system prompt, chat flow (`sendMessage()`), `speak()` and audio playback, push-to-talk recording |
| `AGENTS.md` | This file |

Dependencies: `electron`, `three`, `@pixiv/three-vrm` (installed from `node_modules`, not a CDN).

## Flow of one message

0. Voice only: the user holds `#mic` (or presses `Alt+Shift+Space`). `startListening()` records the microphone with `MediaRecorder`.
   On release, `handleRecording()` calls `window.overlay.transcribe(bytes, mimeType)`; `ipcMain.handle("transcribe")` uploads the
   recording to VoiceStudio and returns the text. Then `sendMessage(text, true)` continues at step 2.
1. Typed: the user presses Enter in `#input` (`renderer.js`), which calls `sendMessage(text, false)`.
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
- **Camera framing** (`renderer.js`, "Three.js scene"): `camera.position.set(0, 0.68, 4.29)`, `lookAt(0, 0.68, 0)`, FOV 30.
  The camera looks straight ahead (same y for position and target). Measured in the 400x640 avatar picture (the stage, see "Window, stage and zoom"):
  hat top at 7 px, feet at 514 px, and a 3-line bubble starts at 524 px. So the feet are free for replies
  of up to 3 lines; a longer bubble (it grows upward, up to about 6 lines) covers the feet again.
  The avatar is about 21% smaller on screen than before (507 px tall, it was cut off at 640 px).
  A different model with another height needs new numbers.
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
  - Arms raised higher than about 0.8 rad above horizontal leave the 400 px wide avatar picture.
    (Measured with the old, closer camera. The current framing shows more space around the avatar; the limit was not measured again.)
  - The gesture starts when the voice starts, not when the text appears (a wave should match the spoken "hello").
- **Autoplay**: `main.js` sets the `autoplay-policy=no-user-gesture-required` switch, so TTS audio can play
  even when no key press came right before it (needed for push-to-talk with the global shortcut).
- **Window, stage and zoom**:
  - The **window** is invisible, click-through and has a fixed size: `WINDOW_WIDTH` 540 x `WINDOW_HEIGHT` 820 in `main.js`,
    height cut to the work area of the screen (800 here). It starts in the bottom right corner and never resizes.
    It only has to be big enough for the biggest avatar.
  - The **stage** is the canvas: the avatar is always rendered as a 400x640 picture (`STAGE_W`, `STAGE_H` in `renderer.js`).
    The camera and the canvas buffer never change. `UI_SPACE` (126) is the empty strip under the feet in that picture.
  - **Zoom** (`renderer.js`, section "Avatar size"): the `wheel` handler changes `zoom` and `layoutAvatar()` sets the CSS size
    of the canvas to `STAGE * zoom`, centered, with `bottom = UI_SPACE * (1 - zoom)`. That keeps the feet exactly
    `UI_SPACE` px above the bottom of the window at every zoom, so the avatar grows upward from its feet.
    No IPC, no window resize: it is only CSS, so nothing else moves.
  - The **chat bar** (`#ui`) has a fixed width (384 px), centered at the bottom. Zoom does not touch it.
  - Limits: `MIN_ZOOM` 0.5; the maximum is where the picture reaches the top or the sides of the window
    (`min(innerWidth / 400, (innerHeight - 126) / 514)`: 1.31 on this laptop, 1.35 on a taller screen).
    For a bigger maximum raise `WINDOW_WIDTH` / `WINDOW_HEIGHT`, but the window cannot be bigger than the screen.
  - A bigger avatar is the same 400x640 picture stretched: no extra rendering cost, a little softer.
  - **Grace time**: a shrinking avatar can slip away from under the mouse, and with click-through on the next wheel step
    would scroll the app behind. So after each wheel step the window stays clickable for `ZOOM_GRACE_MS` (400 ms),
    then `updateHover()` runs again with the last known mouse position.
  - `updateHover()` converts the mouse position into the canvas rectangle before the raycast, because the canvas
    no longer fills the window.
  - The wheel over the chat bar does nothing (the bubble needs it to scroll).
  - Earlier version (rejected by the user): resize the window and set `webContents.setZoomFactor()` to the same factor.
    It scaled and moved the chat bar together with the avatar.
- **Drag** (`main.js` section "Drag", `renderer.js` section "Drag to move"): the avatar never moves inside the page,
  the whole window moves (the chat bar comes along).
  - `pointerdown` on the avatar (left button, raycast hit) sends `drag-start`. The main process then reads
    `screen.getCursorScreenPoint()` every 16 ms and moves the window by the distance the mouse travelled.
    It does not use the mouse events of the page, because the page itself moves under the mouse.
    `pointerup`, `pointercancel`, window `blur`, or a `mousemove` with no button pressed sends `drag-end`.
  - While dragging, the `mousemove` handler skips the click-through toggle. Otherwise the mouse-up could go to the app behind.
  - Every `setBounds` call sends our own stored size (`windowSize`). Moving alone can change the window size on a
    display with 150% scaling, and `getBounds()` can report 1 px more than what was set.
  - `did-finish-load` sets the page zoom factor to 1, in case Chromium remembers a page zoom from an earlier run.
  - Position and avatar size are **not saved**: every start is the bottom right corner at zoom 1.
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

## Voice input (speech to text, push-to-talk)

Built on 2026-10-11. The text box stays as a second way to talk (no microphone, or VoiceStudio not running).

### How to use

- **Hold** the microphone button in the chat bar, speak, release.
- Or press **`Alt+Shift+Space`** from any app: once to start, once more to stop. The window does not need focus.
- The bubble shows `Listening...`, then `Transcribing...`, then `Heard: "..." Thinking...`, then the reply.
- The button is red while the microphone is on.

### How it works

- Engine: VoiceStudio batch endpoint `POST http://127.0.0.1:3900/v1/audio/transcriptions` (OpenAI-compatible, multipart form).
  Fields we send: `file` (the recording), `model`, `language`. The reply is `{ "text": "..." }`.
  Other fields it accepts: `prompt`, `response_format` (json, text, verbose_json, srt, vtt), `temperature`. `stream` is not supported.
- `model`: `"whisper-1"` means "the speech recognition engine that is active in VoiceStudio".
  On this machine that is **faster-whisper** with **`Systran/faster-whisper-base`** (148 MB, installed, CPU).
  `GET /engines/asr` shows the active engine and model, `GET /models` shows which models are installed.
- Recording (`renderer.js`, section "Push-to-talk"): `getUserMedia({ audio: true })` + `MediaRecorder`, default format
  `audio/webm;codecs=opus`. VoiceStudio accepts that file as it is (tested), so there is no conversion. About 15 KB per second.
- The microphone is **opened for each recording and closed after it** (`track.stop()`), so Windows shows
  "microphone in use" only while the user talks. Cost: a short delay before `Listening...` appears.
- `wantListening` is the one flag for "the user wants the microphone on". It handles a release that comes before
  the microphone is ready. Recordings shorter than `MIN_LISTEN_MS` (400 ms) are not sent.
- Starting to listen stops the avatar's voice (`speakId++`, `stopSpeaking()`), so the microphone does not record the avatar.
- `busy` is true while transcribing and while the LLM answers. During that time the button, the shortcut and Enter do nothing.
- The microphone switches off by itself after `MAX_LISTEN_SECONDS` (30), in case the shortcut was left on.
- The upload happens in the main process (`ipcMain.handle("transcribe")`), like Ollama and TTS, to avoid CORS.
- **Global shortcut is a toggle, not hold-to-talk**: Electron's `globalShortcut` reports only the key press, never the release.
  `TALK_SHORTCUT` in `main.js` is `Alt+Shift+Space`. `Ctrl+Shift+Space` and `Ctrl+Alt+T` were refused on this machine
  (another app holds them). If the registration fails, `main.js` prints a warning in the terminal.
  The hint text on the button in `index.html` names the shortcut too: change both.
- **Microphone permission**: `session.defaultSession.setPermissionRequestHandler` allows `media` without video and refuses
  every other permission. Windows must also allow it: Settings > Privacy & security > Microphone > "Let desktop apps access
  your microphone". On 2026-10-11 it was allowed, and the laptop has "Microphone Array (Realtek(R) Audio)".
- Do **not** use the browser `SpeechRecognition` API: it generally does not work in Electron (no Google speech keys) and is cloud-based.
- Settings in `main.js` (or env vars): `STT_MODEL`, `STT_LANGUAGE`, `STT_TIMEOUT_MS` (60 s), `TALK_SHORTCUT`.
  `STT_LANGUAGE` is `"en"` by default; `"auto"` lets the engine guess (less reliable on short recordings with the base model).

### Measured (faster-whisper base, CPU)

- 3.6 s for the first call (it loads the model), then 1.7 to 2.6 s for 4 to 6 s of speech.
- A clear synthetic voice was transcribed without mistakes. A real voice with room noise is not tested.

### Not done / ideas

- Live streaming: `ws://127.0.0.1:3900/v1/audio/transcriptions/stream` (binary WebM/Opus frames, or raw 16-bit mono PCM with
  `?pcm=1&sr=16000`; finish with `{"type":"input_audio.end"}`; replies `partial` and `final`). Not tested. Use it if the wait matters.
- A bigger model (`Systran/faster-whisper-small`, 0.5 GB) if base makes too many mistakes. Install it in VoiceStudio.
- Indonesian: `STT_LANGUAGE="id"`, together with `TTS_LANGUAGE="id"` and a system prompt that asks for Indonesian.
- Whisper models can invent a short sentence (for example "Thank you.") when the recording is silent. There is no filter for that.

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
   - `Runtime.consoleAPICalled` to collect warnings and errors;
   - `Input.dispatchMouseEvent` for mouse buttons and the wheel (`mouseMoved` onto the avatar first, so click-through is off).
   To read the real window bounds, also start with `--inspect=9334` (put it before the `.`), open the WebSocket from
   `http://127.0.0.1:9334/json` and evaluate `process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].getBounds()`.
   Drag needs the **real** cursor to move, because the main process reads it. PowerShell can move it without clicking:
   `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(x, y)` (same units as Electron on this machine).
   The user moving the mouse during such a test changes the result.
3. To test without VoiceStudio, start a small HTTP server that answers `POST /v1/audio/speech` with a WAV
   and set `VOICESTUDIO_URL` to it. The same trick works for the LLM: a fake server on `OLLAMA_URL` that answers
   `POST /api/chat` with `{"message":{"content":"[neutral][wave] Test."}}` triggers any gesture on demand.
   A silent WAV keeps the test quiet.
4. To test push-to-talk without a microphone and without talking, start the app with a fake microphone that plays a WAV in a loop:
   `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=C:\path\to\speech.wav`.
   Make the WAV with VoiceStudio TTS (`POST /v1/audio/speech`). Hold the button with `Input.dispatchMouseEvent`
   (`mousePressed` on `#mic`, wait, `mouseReleased`). The shortcut cannot be pressed from a script; send its message from the
   main-process inspector instead: `BrowserWindow.getAllWindows()[0].webContents.send("talk-toggle")`.
   A proxy that fakes `/api/chat` and `/v1/audio/speech` but forwards `/v1/audio/transcriptions` to port 3900 tests the real
   speech-to-text without loading the LLM and without sound.
5. Quit with `window.overlay.quit()`.

Things to know: module variables in `renderer.js` (`speak`, `vrm`, ...) are not reachable from `Runtime.evaluate`,
and a real test plays sound on the user's speakers.

## Known issues / unverified

- A bubble longer than 3 lines covers the avatar's feet (see "Camera framing"). Long error messages do this.
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
- Drag and zoom: the window can be dragged partly off the screen, and the avatar can only grow to 1.31 on this screen.
  The invisible window is 540x800 even when the avatar is small (it is click-through, so apps behind still work).
  Gestures are cut at the edge of the avatar picture, not at the edge of the window.
- Push-to-talk was tested with a fake microphone only. Not tested: a real voice, a refused microphone, no microphone at all.
  If the default recording device in Windows is not the real microphone (VB-Audio Virtual Cable is installed here), the recording is silent.
- Clicking the chat bar steals keyboard focus from the previously active app.
- Some fullscreen apps and games can still cover an always-on-top window.
- `speechSynthesis` voices (fallback only) vary by Windows install; Indonesian voice may be missing.

## Roadmap

Done: text chat, arms, VoiceStudio TTS with audio-driven lip sync, LLM-chosen body gestures, camera framing, drag and zoom, push-to-talk voice input.

1. Sentence-by-sentence streaming (speak sentence 1 while the LLM writes the rest).
2. Optional: live transcription over the WebSocket endpoint, Indonesian, remember position and size between starts, idle animations, tray icon,
   switch to Tauri to cut RAM.
