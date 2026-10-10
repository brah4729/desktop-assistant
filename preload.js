// preload.js - the safe bridge between the page and Electron
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  setIgnore: (ignore) => ipcRenderer.send("set-ignore", ignore),
  chat: (messages) => ipcRenderer.invoke("chat", messages),
  tts: (text) => ipcRenderer.invoke("tts", text),
  quit: () => ipcRenderer.send("quit"),
});
