const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    isElectron: true,
    openAudioChat: (payload) => ipcRenderer.invoke("audio-chat:open", payload),
    getAudioChatSession: () => ipcRenderer.invoke("audio-chat:get-session"),
    checkpointAudioChat: (turns) => ipcRenderer.invoke("audio-chat:checkpoint", turns),
    completeAudioChat: (turns) => ipcRenderer.invoke("audio-chat:complete", turns),
    onAudioChatCompleted: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("audio-chat:completed", listener);
        return () => ipcRenderer.removeListener("audio-chat:completed", listener);
    },
    generateVoicePreset: (config) => ipcRenderer.invoke("audio-chat:generate-preset", config),
    getVoicePreset: (config) => ipcRenderer.invoke("audio-chat:get-preset", config),
    requestFishSpeech: (request) => ipcRenderer.invoke("audio-chat:tts", request),
    startXunfei: (credentials) => ipcRenderer.invoke("xunfei:start", credentials),
    sendXunfeiAudio: (samples) => ipcRenderer.send("xunfei:audio", Array.from(samples || [])),
    finishXunfei: () => ipcRenderer.invoke("xunfei:finish"),
    abortXunfei: () => ipcRenderer.invoke("xunfei:abort"),
    onXunfeiPartial: (callback) => {
        const listener = (_event, text) => callback(text);
        ipcRenderer.on("xunfei:partial", listener);
        return () => ipcRenderer.removeListener("xunfei:partial", listener);
    },
    onXunfeiFinal: (callback) => {
        const listener = (_event, text) => callback(text);
        ipcRenderer.on("xunfei:final", listener);
        return () => ipcRenderer.removeListener("xunfei:final", listener);
    },
    onXunfeiError: (callback) => {
        const listener = (_event, message) => callback(message);
        ipcRenderer.on("xunfei:error", listener);
        return () => ipcRenderer.removeListener("xunfei:error", listener);
    }
});
