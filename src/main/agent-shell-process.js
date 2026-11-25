const { AgentShellRunner, AgentBackgroundShellManager } = require("./agent-tools");

const foreground = new AgentShellRunner();
const background = new AgentBackgroundShellManager();
const { parentPort } = process;
let closing = false;

const handlers = {
    run: ([options], onProgress) => foreground.run({ ...options, onProgress }),
    cancel: ([id]) => foreground.cancel(id),
    start: ([options]) => background.start(options),
    read: ([id, options]) => background.read(id, options),
    list: () => background.list(),
    stop: ([id]) => background.stopAndWait(id),
    stopAll: () => background.stopAllAndWait()
};

parentPort.on("message", async ({ data: { id, action, args } }) => {
    if (action === "shutdown") {
        if (closing) return;
        closing = true;
        await Promise.allSettled([foreground.cancelAllAndWait(), background.stopAllAndWait()]);
        process.exit(0);
    }
    try {
        if (closing) throw new Error("Agent Shell is shutting down");
        if (!Object.hasOwn(handlers, action)) throw new Error(`Unknown Agent Shell action: ${action}`);
        const result = await handlers[action](args, progress => parentPort.postMessage({ id, progress }));
        parentPort.postMessage({ id, result });
    } catch (error) {
        parentPort.postMessage({ id, error: error.message });
    }
});
