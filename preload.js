// preload.js - the safe bridge between the page and Electron
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  setIgnore: (ignore) => ipcRenderer.send("set-ignore", ignore),
  chat: (messages) => ipcRenderer.invoke("chat", messages),
  tts: (text) => ipcRenderer.invoke("tts", text),
  transcribe: (audio, mimeType) => ipcRenderer.invoke("transcribe", audio, mimeType),
  onTalkToggle: (callback) => ipcRenderer.on("talk-toggle", () => callback()),
  dragStart: () => ipcRenderer.send("drag-start"),
  dragEnd: () => ipcRenderer.send("drag-end"),
  quit: () => ipcRenderer.send("quit"),
});
