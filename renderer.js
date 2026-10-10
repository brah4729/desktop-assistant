// renderer.js - runs inside the window: 3D avatar, lip sync, chat, speech

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

// ---------- Settings you can change ----------
const MODEL_FILE = "./1973449770481441636.vrm"; // your model in this folder
const TARGET_FPS = 30; // lower = less CPU for the LLM and TTS
const MOUTH_GAIN = 5; // raise if the mouth barely opens with VoiceStudio audio, lower if it stays wide open
const SYSTEM_PROMPT =
  "You are a friendly desktop assistant avatar. " +
  "Reply in 1 or 2 short sentences. " +
  "Start every reply with exactly one tag: [happy], [sad], [angry], [surprised] or [neutral].";
// ---------------------------------------------

const canvas = document.getElementById("scene");
const bubble = document.getElementById("bubble");
const input = document.getElementById("input");
const quitBtn = document.getElementById("quit");

// ---------- Three.js scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(1); // keep it cheap on the CPU/iGPU
renderer.setClearColor(0x000000, 0); // fully transparent background
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 20);
camera.position.set(0, 1.0, 3.4); // move up/down (y) or closer/farther (z) to reframe
camera.lookAt(0, 0.9, 0);

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
    setArmsDown();
    showBubble("Hi! Type something below.");
  },
  undefined,
  (err) => showBubble("Could not load the VRM: " + err)
);

// VRM models start in a T-pose. Lower the arms so it looks relaxed.
// If the arms go UP instead of down on your model, flip the signs of the two numbers.
function setArmsDown() {
  const left = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
  const right = vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
  if (left) left.rotation.z = 1.2;
  if (right) right.rotation.z = -1.2;
}

// ---------- Click-through only where it is empty ----------
// The window ignores clicks by default. When the mouse is over the avatar
// or the chat bar, we turn click-through off so you can interact.
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let lastIgnore = true;

window.addEventListener("mousemove", (e) => {
  const overUI = !!e.target.closest("#ui");
  let overAvatar = false;

  if (vrm && !overUI) {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    overAvatar = raycaster.intersectObject(vrm.scene, true).length > 0;
  }

  const ignore = !(overUI || overAvatar);
  if (ignore !== lastIgnore) {
    lastIgnore = ignore;
    window.overlay.setIgnore(ignore);
  }
});

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

async function speak(text) {
  const id = ++speakId;
  stopSpeaking();

  const result = await window.overlay.tts(text);
  if (id !== speakId) return; // a newer reply started while we waited

  if (result.ok) {
    try {
      await playAudio(result.audio, id);
      return;
    } catch (err) {
      console.warn("Could not play the VoiceStudio audio:", err);
    }
  } else {
    console.warn(result.error);
  }
  if (id === speakId) speakWithBrowserVoice(text);
}

async function playAudio(arrayBuffer, id) {
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
}

function speakWithBrowserVoice(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.onstart = () => (speaking = true);
  u.onend = () => (speaking = false);
  u.onerror = () => (speaking = false);
  window.speechSynthesis.speak(u);
}

// ---------- Chat with Ollama ----------
const history = [{ role: "system", content: SYSTEM_PROMPT }];
let busy = false;

function showBubble(text) {
  bubble.style.display = "block";
  bubble.textContent = text;
}

input.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || busy) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  busy = true;
  showBubble("Thinking...");
  history.push({ role: "user", content: text });

  const result = await window.overlay.chat(history);
  busy = false;

  if (!result.ok) {
    history.pop(); // forget the failed message
    showBubble(result.error);
    return;
  }

  // Reads the leading tag like [happy] and removes it from the text
  let reply = result.text.trim();
  let emotion = "neutral";
  const match = reply.match(/^\[(happy|sad|angry|surprised|neutral)\]\s*/i);
  if (match) {
    emotion = match[1].toLowerCase();
    reply = reply.slice(match[0].length);
  }

  history.push({ role: "assistant", content: result.text });
  if (history.length > 13) history.splice(1, 2); // keep the last few turns only (saves RAM and time)

  setExpression(emotion);
  showBubble(reply);
  speak(reply);
});

// ---------- Render loop (capped FPS) ----------
const clock = new THREE.Clock();
let acc = 0;
const frameTime = 1 / TARGET_FPS;

function animate() {
  requestAnimationFrame(animate);
  acc += clock.getDelta();
  if (acc < frameTime) return;

  updateFace(clock.elapsedTime);
  if (vrm) vrm.update(acc);
  renderer.render(scene, camera);
  acc = 0;
}
animate();
