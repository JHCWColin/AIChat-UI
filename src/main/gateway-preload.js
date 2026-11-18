"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gatewayConsoleAPI", {
    getAppearance: () => ipcRenderer.invoke('appearance:get'),
    onAppearance: callback => {
        const listener = (_event, value) => callback(value);
        ipcRenderer.on('appearance:changed', listener);
        return () => ipcRenderer.removeListener('appearance:changed', listener);
    },
    getStatus: () => ipcRenderer.invoke("agent-gateway:get-status"),
    configure: patch => ipcRenderer.invoke("agent-gateway:configure", patch),
    start: () => ipcRenderer.invoke("agent-gateway:start"),
    stop: () => ipcRenderer.invoke("agent-gateway:stop"),
    kickDevice: id => ipcRenderer.invoke("agent-gateway:kick-device", id),
    setDeviceRole: (id, role) => ipcRenderer.invoke("agent-gateway:set-device-role", id, role),
    unblockDevice: id => ipcRenderer.invoke("agent-gateway:unblock-device", id),
    rotateCredentials: () => ipcRenderer.invoke("agent-gateway:rotate-credentials"),
    onStatus: callback => {
        const listener = (_event, status) => callback(status);
        ipcRenderer.on("agent-gateway:status", listener);
        return () => ipcRenderer.removeListener("agent-gateway:status", listener);
    }
});
