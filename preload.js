const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    isElectron: true,
    openAudioChat: (payload) => ipcRenderer.invoke("audio-chat:open", payload),
    openDesktopWork: (payload) => ipcRenderer.invoke("desktop-work:open", payload),
    getAudioChatSession: () => ipcRenderer.invoke("audio-chat:get-session"),
    getDesktopWorkSession: () => ipcRenderer.invoke("desktop-work:get-session"),
    captureDesktopScreenshot: () => ipcRenderer.invoke("desktop-work:capture-screenshot"),
    getUpdateLog: () => ipcRenderer.invoke("app:get-update-log"),
    selectAgentWorkspace: (chatId) => ipcRenderer.invoke("agent:select-workspace", chatId),
    confirmAgentWorkspace: (chatId, workspacePath, selectionId) => ipcRenderer.invoke("agent:confirm-workspace", chatId, workspacePath, selectionId),
    getAgentWorkspace: (chatId) => ipcRenderer.invoke("agent:get-workspace", chatId),
    removeAgentWorkspace: (chatId) => ipcRenderer.invoke("agent:remove-workspace", chatId),
    getAgentCommandSettings: () => ipcRenderer.invoke("agent:get-command-settings"),
    saveAgentCommandAdditions: (commands) => ipcRenderer.invoke("agent:save-command-additions", commands),
    addAgentAllowedCommand: (prefix) => ipcRenderer.invoke("agent:add-allowed-command", prefix),
    checkAgentCommand: (command) => ipcRenderer.invoke("agent:check-command", command),
    executeAgentTool: (request) => ipcRenderer.invoke("agent:execute-tool", request),
    cancelAgentExecution: (executionId) => ipcRenderer.invoke("agent:cancel-execution", executionId),
    onAgentShellProgress: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("agent:shell-progress", listener);
        return () => ipcRenderer.removeListener("agent:shell-progress", listener);
    },
    checkpointAudioChat: (turns) => ipcRenderer.invoke("audio-chat:checkpoint", turns),
    completeAudioChat: (turns) => ipcRenderer.invoke("audio-chat:complete", turns),
    completeDesktopWork: (turns) => ipcRenderer.invoke("desktop-work:complete", turns),
    onAudioChatCompleted: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("audio-chat:completed", listener);
        return () => ipcRenderer.removeListener("audio-chat:completed", listener);
    },
    generateVoicePreset: (config) => ipcRenderer.invoke("audio-chat:generate-preset", config),
    getVoicePreset: (config) => ipcRenderer.invoke("audio-chat:get-preset", config),
    getDesktopVoicePreset: (config) => ipcRenderer.invoke("desktop-work:get-preset", config),
    requestFishSpeech: (request) => ipcRenderer.invoke("audio-chat:tts", request),
    requestDesktopFishSpeech: (request) => ipcRenderer.invoke("desktop-work:tts", request),
    setDesktopWorkInteractive: (interactive) => ipcRenderer.invoke("desktop-work:set-interactive", interactive),
    onDesktopScreenshotCaptured: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("desktop-work:screenshot-captured", listener);
        return () => ipcRenderer.removeListener("desktop-work:screenshot-captured", listener);
    },
    onDesktopScreenshotError: (callback) => {
        const listener = (_event, message) => callback(message);
        ipcRenderer.on("desktop-work:screenshot-error", listener);
        return () => ipcRenderer.removeListener("desktop-work:screenshot-error", listener);
    },
    signalRendererReady: () => ipcRenderer.send("renderer:ready"),
    updateAppState: (state) => ipcRenderer.send("app-state:update", state),
    onTrayAction: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("tray:action", listener);
        return () => ipcRenderer.removeListener("tray:action", listener);
    },
    onUpdateAvailable: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("app:update-available", listener);
        return () => ipcRenderer.removeListener("app:update-available", listener);
    },
    onUpdateNotAvailable: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on("app:update-not-available", listener);
        return () => ipcRenderer.removeListener("app:update-not-available", listener);
    },
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
