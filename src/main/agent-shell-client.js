const path = require("node:path");
const { utilityProcess } = require("electron");

class AgentShellClient {
    constructor() {
        this.process = null;
        this.pending = new Map();
        this.sequence = 0;
        this.closing = false;
    }

    getProcess() {
        if (this.process) return this.process;
        const child = utilityProcess.fork(path.join(__dirname, "agent-shell-process.js"), [], {
            serviceName: "Agent Shell"
        });
        this.process = child;
        child.on("message", ({ id, progress, result, error }) => {
            const request = this.pending.get(id);
            if (!request) return;
            if (progress) {
                request.onProgress?.(progress);
                return;
            }
            this.pending.delete(id);
            if (error) request.reject(new Error(error));
            else request.resolve(result);
        });
        // Electron reports V8 fatal errors here before emitting exit.
        child.on("error", (type, location) => console.error(`[Agent Shell] ${type}: ${location}`));
        child.once("exit", code => {
            this.process = null;
            const error = new Error(`Agent Shell process exited (${code})`);
            for (const request of this.pending.values()) request.reject(error);
            this.pending.clear();
        });
        return child;
    }

    async call(action, args = [], onProgress) {
        if (this.closing) throw new Error("Agent Shell is shutting down");
        // Only a request that can create a command needs to start the service.
        if (!this.process) {
            if (action === "list") return { success: true, processes: [] };
            if (action === "stopAll") return [];
            if (action === "cancel") return false;
            if (action === "read" || action === "stop") return { success: false, error: `unknown process id: ${args[0]}` };
        }
        const child = this.getProcess();
        return new Promise((resolve, reject) => {
            const id = ++this.sequence;
            this.pending.set(id, { resolve, reject, onProgress });
            try {
                child.postMessage({ id, action, args });
            } catch (error) {
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    shutdown() {
        this.closing = true;
        const child = this.process;
        if (!child) return;
        return new Promise(resolve => {
            const finish = () => {
                clearTimeout(timer);
                child.removeListener("exit", finish);
                resolve();
            };
            const timer = setTimeout(() => {
                child.kill();
                finish();
            }, 6000);
            child.once("exit", finish);
            try {
                child.postMessage({ action: "shutdown" });
            } catch {
                child.kill();
                finish();
            }
        });
    }
}

module.exports = { AgentShellClient };
