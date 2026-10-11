// renderer.js - runs inside the window: 3D avatar, lip sync, chat, speech

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

// ---------- Settings you can change ----------
const MODEL_FILE = "./1973449770481441636.vrm"; // your model in this folder
const TARGET_FPS = 30; // lower = less CPU for the LLM and TTS
const MOUTH_GAIN = 5; // raise if the mouth barely opens with VoiceStudio audio, lower if it stays wide open
const GESTURE_BLEND = 0.35; // seconds to move into a gesture and back out of it
const MIN_ZOOM = 0.5; // smallest avatar when you scroll (1 = normal size). The biggest size is set by the window, see main.js
const ZOOM_SPEED = 0.001; // how much one step of the mouse wheel resizes the avatar
const MAX_LISTEN_SECONDS = 30; // the microphone switches off by itself after this time
// The prompt tells the model it has a body, and which tags move it.
// If you add a gesture to GESTURES below, describe it here too or the model will never use it.
const SYSTEM_PROMPT =
  "You are a friendly desktop assistant avatar with a 3D body: a head, a spine, two arms and two hands that you can move. " +
  "Reply in 1 or 2 short sentences. " +
  "Start every reply with exactly one emotion tag: [happy], [sad], [angry], [surprised] or [neutral]. " +
  "Right after it you can add one gesture tag to move your body: " +
  "[wave] to greet or say goodbye, [nod] to say yes or agree, [shake] to say no or disagree, " +
  "[think] when you are unsure, [bow] to thank or apologize, [cheer] to celebrate. " +
  "Use a gesture only when it fits; most replies need none. " +
  "Example: [happy][wave] Hello! Nice to see you.";
// ---------------------------------------------

const canvas = document.getElementById("scene");
const bubble = document.getElementById("bubble");
const input = document.getElementById("input");
const micBtn = document.getElementById("mic");
const quitBtn = document.getElementById("quit");

// ---------- Three.js scene ----------
// The avatar is drawn as a picture of STAGE_W x STAGE_H pixels. Zooming stretches or shrinks that picture
// on the page (see "Avatar size"); the picture itself and the camera never change.
const STAGE_W = 400;
const STAGE_H = 640;
const UI_SPACE = 126; // empty strip under the feet in that picture: the chat bar and a 3-line bubble go there

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(1); // keep it cheap on the CPU/iGPU
renderer.setClearColor(0x000000, 0); // fully transparent background
renderer.setSize(STAGE_W, STAGE_H, false); // false = do not touch the size on the page, layoutAvatar() sets it

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(30, STAGE_W / STAGE_H, 0.1, 20);
// Framed so the feet stand just above a 3-line bubble and the hat stays inside the top edge.
// To reframe: z = closer (smaller) / farther (bigger), y = move the view up / down.
// Keep the y of lookAt equal to the y of the position, so the camera looks straight ahead.
camera.position.set(0, 0.68, 4.29);
camera.lookAt(0, 0.68, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(1, 2, 2);
scene.add(sun);

// ---------- Load the VRM ----------
let vrm = null;

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

loader.load(
  MODEL_FILE,
  (gltf) => {
    vrm = gltf.userData.vrm;
    VRMUtils.rotateVRM0(vrm); // makes old VRM 0.x models face the camera (does nothing for 1.0)
    scene.add(vrm.scene);
    showBubble("Hi! Type something below.");
  },
  undefined,
  (err) => showBubble("Could not load the VRM: " + err)
);

// ---------- Body pose and gestures ----------
// A pose is a list of bones with a rotation [x, y, z] in radians.
// The numbers are written for VRM 0.x models; updateBody() flips x and z for VRM 1.0.
// For the right arm: z = up (+) / down (-), x = twist, and y on the lower arm = bend the elbow.

// How the avatar stands when it does nothing. VRM models load in a T-pose, so the arms are lowered here.
const REST_POSE = {
  spine: [0, 0, 0],
  head: [0, 0, 0],
  leftUpperArm: [0, 0, 1.2],
  leftLowerArm: [0, 0, 0],
  rightUpperArm: [0, 0, -1.2],
  rightLowerArm: [0, 0, 0],
};

// Each gesture lasts some seconds and returns the pose for the time t (seconds since it started).
// Bones that a gesture does not mention stay in the rest pose.
const GESTURES = {
  wave: {
    seconds: 2.6,
    pose: (t) => ({
      rightUpperArm: [1.57, 0, -0.1], // arm out to the side, twisted so the forearm points up
      rightLowerArm: [0, 1.6 + 0.4 * Math.sin(t * 10), 0], // the elbow swings the hand left and right
    }),
  },
  nod: {
    seconds: 1.4,
    pose: (t) => ({ head: [-0.3 * Math.abs(Math.sin(t * 5)), 0, 0] }),
  },
  shake: {
    seconds: 1.4,
    pose: (t) => ({ head: [0, 0.4 * Math.sin(t * 9), 0] }),
  },
  think: {
    seconds: 2.5,
    pose: () => ({ head: [0.12, 0.2, 0.2] }), // look up a little with the head tilted
  },
  bow: {
    seconds: 2.0,
    pose: () => ({ spine: [-0.5, 0, 0], head: [-0.2, 0, 0] }),
  },
  cheer: {
    seconds: 2.2,
    pose: (t) => ({
      leftUpperArm: [0, 0, -0.8 + 0.12 * Math.sin(t * 12)], // not higher, or the hands leave the window
      rightUpperArm: [0, 0, 0.8 - 0.12 * Math.sin(t * 12)],
    }),
  },
};

let gesture = null;
let gestureStart = 0;

function playGesture(name) {
  if (!GESTURES[name]) return;
  gesture = GESTURES[name];
  gestureStart = performance.now();
}

// Runs every frame: blends from the rest pose into the gesture and back.
function updateBody() {
  if (!vrm) return;

  let pose = null;
  let weight = 0; // 0 = rest pose, 1 = full gesture
  if (gesture) {
    const t = (performance.now() - gestureStart) / 1000;
    if (t >= gesture.seconds) {
      gesture = null;
    } else {
      pose = gesture.pose(t);
      const k = Math.min(1, t / GESTURE_BLEND, (gesture.seconds - t) / GESTURE_BLEND);
      weight = k * k * (3 - 2 * k); // ease in and out
    }
  }

  const flip = vrm.meta.metaVersion === "0" ? 1 : -1; // VRM 1.0 models face the other way
  for (const name in REST_POSE) {
    const node = vrm.humanoid.getNormalizedBoneNode(name);
    if (!node) continue;
    const rest = REST_POSE[name];
    const to = (pose && pose[name]) || rest;
    node.rotation.set(
      (rest[0] + (to[0] - rest[0]) * weight) * flip,
      rest[1] + (to[1] - rest[1]) * weight,
      (rest[2] + (to[2] - rest[2]) * weight) * flip,
      "ZYX" // twist first, then lift: keeps the arm poses easy to write
    );
  }
}

// ---------- Click-through only where it is empty ----------
// The window ignores clicks by default. When the mouse is over the avatar
// or the chat bar, we turn click-through off so you can interact.
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let lastIgnore = true;
let overAvatar = false;
let dragging = false;
let mouseX = -1; // where the mouse was last seen on the page
let mouseY = -1;
let zoomUntil = 0; // the window stays clickable until this time (see the wheel handler)

window.addEventListener("mousemove", (e) => {
  if (dragging) {
    // Keep the window clickable for the whole drag, or the mouse-up would go to the app behind us.
    if (e.buttons === 0) endDrag(); // the button was released somewhere we did not see it
    return;
  }
  mouseX = e.clientX;
  mouseY = e.clientY;
  updateHover();
});

// Looks at what is under the mouse and turns click-through on or off.
function updateHover() {
  const under = document.elementFromPoint(mouseX, mouseY);
  const overUI = !!(under && under.closest("#ui"));
  overAvatar = false;

  if (vrm && !overUI) {
    // Mouse position inside the avatar picture, from -1 to 1. The picture does not fill the window.
    const box = canvas.getBoundingClientRect();
    mouse.x = ((mouseX - box.left) / box.width) * 2 - 1;
    mouse.y = -((mouseY - box.top) / box.height) * 2 + 1;
    if (Math.abs(mouse.x) <= 1 && Math.abs(mouse.y) <= 1) {
      raycaster.setFromCamera(mouse, camera);
      overAvatar = raycaster.intersectObject(vrm.scene, true).length > 0;
    }
  }

  const ignore = !(overUI || overAvatar || performance.now() < zoomUntil);
  if (ignore !== lastIgnore) {
    lastIgnore = ignore;
    window.overlay.setIgnore(ignore);
  }
}

// ---------- Drag to move ----------
// The page only reports what the mouse does on the avatar. The main process moves the window.
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !overAvatar) return; // left button on the avatar only
  dragging = true;
  canvas.setPointerCapture(e.pointerId); // we still get the mouse-up when the mouse is faster than the window
  canvas.style.cursor = "grabbing";
  window.overlay.dragStart();
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  canvas.style.cursor = "";
  window.overlay.dragEnd();
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
window.addEventListener("blur", endDrag);

// ---------- Avatar size (mouse wheel) ----------
// Only the avatar picture changes size. The window and the chat bar stay as they are,
// and the feet stay on the same line, right above the chat bar.
const ZOOM_GRACE_MS = 400;
let zoom = 1;
let zoomTimer = 0;

function layoutAvatar() {
  const width = STAGE_W * zoom;
  canvas.style.width = width + "px";
  canvas.style.height = STAGE_H * zoom + "px";
  canvas.style.left = "calc(50% - " + width / 2 + "px)"; // centered in the window
  // The empty strip under the feet scales with the picture, but the chat bar always needs UI_SPACE pixels.
  // Move the picture down (or up) by the difference, so the feet stay UI_SPACE above the bottom of the window.
  canvas.style.bottom = UI_SPACE * (1 - zoom) + "px";
}
layoutAvatar();

window.addEventListener(
  "wheel",
  (e) => {
    if (dragging || e.target.closest("#ui")) return; // over the chat bar the wheel scrolls the bubble
    if (!overAvatar && performance.now() >= zoomUntil) return;
    e.preventDefault(); // stop the browser's own Ctrl + wheel zoom

    // The avatar can grow until it reaches the top or the sides of the window
    const maxZoom = Math.min(window.innerWidth / STAGE_W, (window.innerHeight - UI_SPACE) / (STAGE_H - UI_SPACE));
    zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, zoom * Math.exp(-e.deltaY * ZOOM_SPEED))); // wheel up = bigger
    layoutAvatar();

    // A smaller avatar can slip away from under the mouse. Keep the window clickable for a moment,
    // so the next wheel step still arrives here and does not scroll the app behind us.
    zoomUntil = performance.now() + ZOOM_GRACE_MS;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(updateHover, ZOOM_GRACE_MS + 20);
    updateHover();
  },
  { passive: false }
);

quitBtn.addEventListener("click", () => window.overlay.quit());

// ---------- Expressions, blinking and mouth ----------
let currentExpression = null;
let expressionUntil = 0;
let speaking = false;
let mouthValue = 0;
let nextBlink = 2;
let blinkEnd = 0;

function setExpression(name) {
  if (!vrm) return;
  if (currentExpression) vrm.expressionManager.setValue(currentExpression, 0);
  currentExpression = null;
  if (name && name !== "neutral") {
    vrm.expressionManager.setValue(name, 1);
    currentExpression = name;
    expressionUntil = performance.now() + 6000; // go back to neutral after 6 s
  }
}

function updateFace(t) {
  if (!vrm) return;
  const em = vrm.expressionManager;

  if (currentExpression && performance.now() > expressionUntil) setExpression(null);

  // Blink every few seconds
  if (t > nextBlink) {
    blinkEnd = t + 0.15;
    nextBlink = t + 2 + Math.random() * 4;
  }
  em.setValue("blink", t < blinkEnd ? 1 : 0);

  let target = 0;
  if (speaking && currentSource) {
    // Real lip sync: measure how loud the VoiceStudio audio is right now
    analyser.getByteTimeDomainData(levelData);
    let sum = 0;
    for (let i = 0; i < levelData.length; i++) {
      const v = (levelData[i] - 128) / 128; // -1 .. 1
      sum += v * v;
    }
    target = Math.min(1, Math.sqrt(sum / levelData.length) * MOUTH_GAIN);
  } else if (speaking) {
    // Fake lip sync: the browser's speechSynthesis cannot be analysed as audio,
    // so we move the mouth in a talking rhythm while it speaks.
    target = 0.25 + 0.5 * Math.abs(Math.sin(t * 13)) * (0.6 + 0.4 * Math.sin(t * 5.3));
  }
  mouthValue += (target - mouthValue) * 0.35; // smooth it
  em.setValue("aa", mouthValue);
}

// ---------- Text to speech ----------
// First choice: VoiceStudio. The main process fetches the audio, we play it here
// through an AnalyserNode so the mouth can follow the real volume.
// Fallback: the browser's built-in voice, used when VoiceStudio is not running.
let audioCtx = null;
let analyser = null;
let levelData = null;
let currentSource = null; // the VoiceStudio audio that is playing now (null = none)
let speakId = 0;

function stopSpeaking() {
  window.speechSynthesis.cancel();
  if (currentSource) {
    currentSource.onended = null;
    currentSource.stop();
    currentSource = null;
  }
  speaking = false;
}

// onStart runs at the moment the voice begins, so a gesture can start together with it.
async function speak(text, onStart) {
  const id = ++speakId;
  stopSpeaking();

  const result = await window.overlay.tts(text);
  if (id !== speakId) return; // a newer reply started while we waited

  if (result.ok) {
    try {
      await playAudio(result.audio, id, onStart);
      return;
    } catch (err) {
      console.warn("Could not play the VoiceStudio audio:", err);
    }
  } else {
    console.warn(result.error);
  }
  if (id === speakId) speakWithBrowserVoice(text, onStart);
}

async function playAudio(arrayBuffer, id, onStart) {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.connect(audioCtx.destination);
    levelData = new Uint8Array(analyser.fftSize);
  }
  await audioCtx.resume();
  const buffer = await audioCtx.decodeAudioData(arrayBuffer);
  if (id !== speakId) return;

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(analyser);
  source.onended = () => {
    if (currentSource === source) {
      currentSource = null;
      speaking = false;
    }
  };
  currentSource = source;
  speaking = true;
  source.start();
  if (onStart) onStart();
}

function speakWithBrowserVoice(text, onStart) {
  const u = new SpeechSynthesisUtterance(text);
  u.onstart = () => {
    speaking = true;
    if (onStart) onStart();
  };
  u.onend = () => (speaking = false);
  u.onerror = () => (speaking = false);
  window.speechSynthesis.speak(u);
}

// ---------- Chat with Ollama ----------
const EMOTIONS = ["happy", "sad", "angry", "surprised", "neutral"];
const history = [{ role: "system", content: SYSTEM_PROMPT }];
let busy = false;

function showBubble(text) {
  bubble.style.display = "block";
  bubble.textContent = text;
}

input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || busy) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  sendMessage(text, false);
});

// Sends one message to the LLM, then shows and speaks the answer.
// heard = true when the text came from the microphone: we show it, so you can see what was understood.
async function sendMessage(text, heard) {
  if (busy) return;
  busy = true;
  showBubble(heard ? `Heard: "${text}" Thinking...` : "Thinking...");
  history.push({ role: "user", content: text });

  const result = await window.overlay.chat(history);
  busy = false;

  if (!result.ok) {
    history.pop(); // forget the failed message
    showBubble(result.error);
    return;
  }

  // Reads the tags like [happy] and [wave], and removes them from the text.
  // Small models sometimes put a tag at the end, so we look everywhere, not only at the start.
  let emotion = "neutral";
  let gestureName = null;
  let foundEmotion = false;
  const reply = result.text
    .replace(/\[(\w+)\]\s*/g, (_all, word) => {
      const tag = word.toLowerCase();
      if (EMOTIONS.includes(tag) && !foundEmotion) {
        emotion = tag;
        foundEmotion = true;
      } else if (GESTURES[tag] && !gestureName) {
        gestureName = tag;
      }
      return "";
    })
    .trim();

  history.push({ role: "assistant", content: result.text });
  if (history.length > 13) history.splice(1, 2); // keep the last few turns only (saves RAM and time)

  setExpression(emotion);
  showBubble(reply);
  speak(reply, () => playGesture(gestureName));
}

// ---------- Push-to-talk (speech to text) ----------
// Hold the microphone button, speak, release. Or press the talk shortcut once to start and once to stop.
// The recording goes to VoiceStudio through the main process and comes back as text.
// From there it takes the same path as typed text: sendMessage().
const MIN_LISTEN_MS = 400; // shorter than this is a slip of the finger, not speech
let wantListening = false; // true while the button is held down (or the shortcut switched it on)
let recorder = null; // the MediaRecorder while it records
let listenTimer = 0;

async function startListening() {
  if (wantListening || busy) return;
  wantListening = true;
  micBtn.classList.add("listening");
  speakId++; // drop a voice that is still being made
  stopSpeaking(); // and stop talking, or the microphone hears the avatar

  // The microphone is opened for each recording and closed after it,
  // so Windows shows "microphone in use" only while you talk.
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    wantListening = false;
    micBtn.classList.remove("listening");
    showBubble(
      `Could not use the microphone (${err.name}). Check that one is connected and that Windows lets desktop apps use it: ` +
        "Settings > Privacy & security > Microphone."
    );
    return;
  }
  if (!wantListening) {
    // Released before the microphone was ready
    stream.getTracks().forEach((track) => track.stop());
    showBubble("Hold the microphone button while you speak.");
    return;
  }

  const chunks = [];
  const started = performance.now();
  const rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => {
    stream.getTracks().forEach((track) => track.stop()); // close the microphone
    recorder = null;
    handleRecording(new Blob(chunks, { type: rec.mimeType }), performance.now() - started);
  };
  recorder = rec;
  rec.start();
  listenTimer = setTimeout(stopListening, MAX_LISTEN_SECONDS * 1000);
  showBubble("Listening...");
}

function stopListening() {
  if (!wantListening) return;
  wantListening = false;
  micBtn.classList.remove("listening");
  clearTimeout(listenTimer);
  if (recorder) recorder.stop(); // this runs rec.onstop above
}

async function handleRecording(blob, milliseconds) {
  if (milliseconds < MIN_LISTEN_MS) {
    showBubble("Hold the microphone button while you speak.");
    return;
  }

  busy = true;
  showBubble("Transcribing...");
  const result = await window.overlay.transcribe(await blob.arrayBuffer(), blob.type);
  busy = false;

  if (!result.ok) {
    showBubble(result.error);
    return;
  }
  const text = result.text.trim();
  if (!text) {
    showBubble("I did not hear anything. Try again, a little closer to the microphone.");
    return;
  }
  sendMessage(text, true);
}

micBtn.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  micBtn.setPointerCapture(e.pointerId); // we still get the release when the mouse slips off the button
  startListening();
});
micBtn.addEventListener("pointerup", stopListening);
micBtn.addEventListener("pointercancel", stopListening);

// The talk shortcut (see main.js) switches the microphone on and off
window.overlay.onTalkToggle(() => (wantListening ? stopListening() : startListening()));

// ---------- Render loop (capped FPS) ----------
const clock = new THREE.Clock();
let acc = 0;
const frameTime = 1 / TARGET_FPS;

function animate() {
  requestAnimationFrame(animate);
  acc += clock.getDelta();
  if (acc < frameTime) return;

  updateFace(clock.elapsedTime);
  updateBody();
  if (vrm) vrm.update(acc);
  renderer.render(scene, camera);
  acc = 0;
}
animate();
