// preload.js - the safe bridge between the page and Electron
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  setIgnore: (ignore) => ipcRenderer.send("set-ignore", ignore),
  chat: (messages) => ipcRenderer.invoke("chat", messages),
  tts: (text) => ipcRenderer.invoke("tts", text),
  dragStart: () => ipcRenderer.send("drag-start"),
  dragEnd: () => ipcRenderer.send("drag-end"),
  zoom: (deltaY) => ipcRenderer.send("zoom", deltaY),
  quit: () => ipcRenderer.send("quit"),
});
