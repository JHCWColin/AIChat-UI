const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const DEFAULT_SHELL_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function normalizeCommandLine(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeCommandPrefix(value) {
    return normalizeCommandLine(value).toLocaleLowerCase("en-US");
}

function hasUnsafeCommandComposition(command) {
    const source = String(command || "");
    let quote = "";
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "`") {
            if (!quote) return true;
            escaped = true;
            continue;
        }
        if (quote) {
            if (quote === '"' && char === "$" && source[index + 1] === "(") return true;
            if (char === quote) quote = "";
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === "\r" || char === "\n" || char === ";" || char === "|" || char === "&" || char === ">" || char === "<") return true;
        if (char === "$" && source[index + 1] === "(") return true;
    }
    return false;
}

function commandMatchesPrefix(command, prefix) {
    if (hasUnsafeCommandComposition(command)) return false;
    const normalizedCommand = normalizeCommandPrefix(command);
    const normalizedPrefix = normalizeCommandPrefix(prefix);
    if (!normalizedCommand || !normalizedPrefix || !normalizedCommand.startsWith(normalizedPrefix)) return false;
    return normalizedCommand.length === normalizedPrefix.length || /\s/.test(normalizedCommand[normalizedPrefix.length]);
}

function findAllowedCommandPrefix(command, prefixes) {
    const candidates = (Array.isArray(prefixes) ? prefixes : [])
        .map(value => String(value || "").trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
    return candidates.find(prefix => commandMatchesPrefix(command, prefix)) || "";
}

function deriveAllowedCommandPrefix(command) {
    const normalized = normalizeCommandLine(command);
    const tokens = normalized.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (!tokens.length) return "";
    const executable = tokens[0].replace(/^['"]|['"]$/g, "").toLocaleLowerCase("en-US");
    if (["powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd", "cmd.exe", "bash", "sh"].includes(executable)) {
        return normalized;
    }
    return tokens.slice(0, 2).join(" ");
}

function parseCommandFile(content) {
    const seen = new Set();
    return String(content || "").split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("#"))
        .filter(line => {
            const key = normalizeCommandPrefix(line);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

async function readCommandFile(filePath) {
    try {
        return parseCommandFile(await fs.readFile(filePath, "utf8"));
    } catch (error) {
        if (error && error.code === "ENOENT") return [];
        throw error;
    }
}

async function loadAllowedCommands(defaultFile, userFile) {
    const [defaults, additions] = await Promise.all([
        readCommandFile(defaultFile),
        readCommandFile(userFile)
    ]);
    return { defaults, additions, all: parseCommandFile([...defaults, ...additions].join("\n")) };
}

async function saveUserAllowedCommands(userFile, commands) {
    const normalized = parseCommandFile(Array.isArray(commands) ? commands.join("\n") : commands);
    await fs.mkdir(path.dirname(userFile), { recursive: true });
    await fs.writeFile(userFile, normalized.length ? `${normalized.join("\n")}\n` : "", "utf8");
    return normalized;
}

function isPathInside(rootPath, targetPath) {
    const relative = path.relative(rootPath, targetPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rejectsParentTraversal(inputPath) {
    return String(inputPath || "").split(/[\\/]+/).includes("..");
}

async function nearestExistingAncestor(targetPath) {
    let current = targetPath;
    while (true) {
        try {
            await fs.lstat(current);
            return current;
        } catch (error) {
            if (!error || error.code !== "ENOENT") throw error;
        }
        const parent = path.dirname(current);
        if (parent === current) throw new Error("No existing parent directory");
        current = parent;
    }
}

async function resolveWorkspacePath(workspacePath, requestedPath, options = {}) {
    const input = String(requestedPath || "").trim();
    if (!input) throw new Error("path is required");
    if (input.includes("\0")) throw new Error("path contains invalid characters");
    if (rejectsParentTraversal(input)) throw new Error("parent traversal is not allowed");

    const workspaceReal = await fs.realpath(workspacePath);
    const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(workspaceReal, input);
    if (!isPathInside(workspaceReal, candidate)) throw new Error("path is outside the workspace");

    if (options.allowMissing) {
        const ancestor = await nearestExistingAncestor(candidate);
        const ancestorReal = await fs.realpath(ancestor);
        if (!isPathInside(workspaceReal, ancestorReal)) throw new Error("path escapes the workspace through a link");
        try {
            const targetReal = await fs.realpath(candidate);
            if (!isPathInside(workspaceReal, targetReal)) throw new Error("path escapes the workspace through a link");
        } catch (error) {
            if (!error || error.code !== "ENOENT") throw error;
        }
        return { workspaceReal, targetPath: candidate };
    }

    const targetReal = await fs.realpath(candidate);
    if (!isPathInside(workspaceReal, targetReal)) throw new Error("path escapes the workspace through a link");
    return { workspaceReal, targetPath: targetReal };
}

function splitTextLines(content) {
    const text = String(content || "");
    if (!text) return [];
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
}

async function readFileRange(workspacePath, args = {}) {
    const startLine = Number(args.start_line);
    const endLine = Number(args.end_line);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < 1) {
        return { success: false, error: "start_line and end_line must be positive integers" };
    }
    if (startLine > endLine) return { success: false, error: "start_line must not exceed end_line" };
    try {
        const { targetPath, workspaceReal } = await resolveWorkspacePath(workspacePath, args.path);
        const content = await fs.readFile(targetPath, "utf8");
        const lines = splitTextLines(content);
        const totalLines = lines.length;
        if (startLine > totalLines) {
            return {
                success: true,
                path: path.relative(workspaceReal, targetPath) || path.basename(targetPath),
                requestedStartLine: startLine,
                requestedEndLine: endLine,
                actualStartLine: null,
                actualEndLine: null,
                returnedLines: 0,
                totalLines,
                content: "",
                note: `start_line exceeds the file length (${totalLines} lines)`
            };
        }
        const actualEndLine = Math.min(endLine, totalLines);
        return {
            success: true,
            path: path.relative(workspaceReal, targetPath) || path.basename(targetPath),
            requestedStartLine: startLine,
            requestedEndLine: endLine,
            actualStartLine: startLine,
            actualEndLine,
            returnedLines: actualEndLine - startLine + 1,
            totalLines,
            content: lines.slice(startLine - 1, actualEndLine).join("\n")
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function writeFile(workspacePath, args = {}) {
    if (typeof args.content !== "string") return { success: false, error: "content must be a string" };
    try {
        const { targetPath, workspaceReal } = await resolveWorkspacePath(workspacePath, args.path, { allowMissing: true });
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, args.content, "utf8");
        return {
            success: true,
            path: path.relative(workspaceReal, targetPath) || path.basename(targetPath),
            charactersWritten: args.content.length,
            bytesWritten: Buffer.byteLength(args.content, "utf8")
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function countOccurrences(content, oldText) {
    let count = 0;
    let cursor = 0;
    while (cursor <= content.length - oldText.length) {
        const index = content.indexOf(oldText, cursor);
        if (index < 0) break;
        count += 1;
        cursor = index + oldText.length;
    }
    return count;
}

async function editFile(workspacePath, args = {}) {
    if (typeof args.old_text !== "string" || !args.old_text) return { success: false, error: "old_text must be a non-empty string" };
    if (typeof args.new_text !== "string") return { success: false, error: "new_text must be a string" };
    try {
        const { targetPath, workspaceReal } = await resolveWorkspacePath(workspacePath, args.path);
        const content = await fs.readFile(targetPath, "utf8");
        const occurrences = countOccurrences(content, args.old_text);
        if (occurrences === 0) return { success: false, error: "old_text not found" };
        if (occurrences > 1) return { success: false, error: "old_text is ambiguous", occurrences };
        const nextContent = content.replace(args.old_text, args.new_text);
        await fs.writeFile(targetPath, nextContent, "utf8");
        return {
            success: true,
            path: path.relative(workspaceReal, targetPath) || path.basename(targetPath),
            occurrences: 1,
            charactersBefore: content.length,
            charactersAfter: nextContent.length
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

class AgentWorkspaceStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.bindings = null;
    }

    async load() {
        if (this.bindings) return this.bindings;
        try {
            const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
            this.bindings = parsed && typeof parsed === "object" ? parsed : {};
        } catch (error) {
            if (!error || error.code !== "ENOENT") console.warn(`[Agent] Failed to load workspace bindings: ${error.message}`);
            this.bindings = {};
        }
        return this.bindings;
    }

    async save() {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(this.filePath, `${JSON.stringify(this.bindings, null, 2)}\n`, "utf8");
    }

    async bind(chatId, workspacePath) {
        const id = String(chatId || "").trim();
        if (!id) throw new Error("chatId is required");
        await this.load();
        if (this.bindings[id]) return this.get(id);
        const real = await fs.realpath(workspacePath);
        const stats = await fs.stat(real);
        if (!stats.isDirectory()) throw new Error("workspace must be a directory");
        this.bindings[id] = real;
        await this.save();
        return this.get(id);
    }

    async get(chatId) {
        const id = String(chatId || "").trim();
        await this.load();
        const workspacePath = this.bindings[id] || "";
        if (!workspacePath) return { bound: false, exists: false, path: "" };
        try {
            const real = await fs.realpath(workspacePath);
            const stats = await fs.stat(real);
            return { bound: true, exists: stats.isDirectory(), path: workspacePath, realPath: real };
        } catch {
            return { bound: true, exists: false, path: workspacePath };
        }
    }

    async remove(chatId) {
        const id = String(chatId || "").trim();
        await this.load();
        if (!this.bindings[id]) return false;
        delete this.bindings[id];
        await this.save();
        return true;
    }
}

function killProcessTree(child) {
    if (!child || child.killed) return;
    if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        killer.unref();
    } else {
        try {
            child.kill("SIGKILL");
        } catch {}
    }
}

class AgentShellRunner {
    constructor() {
        this.running = new Map();
    }

    cancel(executionId) {
        const state = this.running.get(String(executionId || ""));
        if (!state) return false;
        state.cancelled = true;
        killProcessTree(state.child);
        return true;
    }

    async run(options = {}) {
        const executionId = String(options.executionId || "").trim();
        const command = String(options.command || "");
        if (!executionId) throw new Error("executionId is required");
        if (!command.trim()) return { stdout: "", stderr: "command is required", exitCode: 1 };
        const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_SHELL_TIMEOUT_MS;
        const maxOutputBytes = Number(options.maxOutputBytes) > 0 ? Number(options.maxOutputBytes) : DEFAULT_MAX_OUTPUT_BYTES;
        const shellCommand = process.platform === "win32" ? "powershell.exe" : (process.env.SHELL || "/bin/sh");
        const shellArgs = process.platform === "win32"
            ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
            : ["-lc", command];

        return new Promise((resolve, reject) => {
            const child = spawn(shellCommand, shellArgs, {
                cwd: options.cwd,
                windowsHide: true,
                env: process.env
            });
            const state = { child, cancelled: false, timedOut: false };
            this.running.set(executionId, state);
            const stdout = [];
            const stderr = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let stdoutTruncated = false;
            let stderrTruncated = false;
            const startedAt = Date.now();
            let timer = null;

            const appendChunk = (target, chunk, streamName) => {
                const buffer = Buffer.from(chunk);
                if (streamName === "stdout") stdoutBytes += buffer.length;
                else stderrBytes += buffer.length;
                const currentBytes = target.reduce((sum, item) => sum + item.length, 0);
                if (currentBytes < maxOutputBytes) target.push(buffer.subarray(0, maxOutputBytes - currentBytes));
                if (currentBytes + buffer.length > maxOutputBytes) {
                    if (streamName === "stdout") stdoutTruncated = true;
                    else stderrTruncated = true;
                }
                if (typeof options.onProgress === "function") {
                    options.onProgress({ executionId, stdoutBytes, stderrBytes, elapsedMs: Date.now() - startedAt });
                }
            };

            child.stdout.on("data", chunk => appendChunk(stdout, chunk, "stdout"));
            child.stderr.on("data", chunk => appendChunk(stderr, chunk, "stderr"));
            child.on("error", error => {
                this.running.delete(executionId);
                clearTimeout(timer);
                reject(error);
            });
            timer = setTimeout(() => {
                state.timedOut = true;
                killProcessTree(child);
            }, timeoutMs);
            child.on("close", code => {
                clearTimeout(timer);
                this.running.delete(executionId);
                resolve({
                    stdout: Buffer.concat(stdout).toString("utf8"),
                    stderr: Buffer.concat(stderr).toString("utf8"),
                    exitCode: Number.isInteger(code) ? code : (state.cancelled || state.timedOut ? 1 : -1),
                    stdoutBytes,
                    stderrBytes,
                    stdoutTruncated,
                    stderrTruncated,
                    cancelled: state.cancelled,
                    timedOut: state.timedOut,
                    durationMs: Date.now() - startedAt
                });
            });
        });
    }
}

function getEnvironmentDescription(workspacePath) {
    const platformNames = { win32: "Windows", darwin: "macOS", linux: "Linux" };
    return [
        `OS: ${platformNames[process.platform] || process.platform} ${os.release()}`,
        `Shell: ${process.platform === "win32" ? "PowerShell" : (process.env.SHELL || "/bin/sh")}`,
        `Workspace: ${workspacePath}`,
        `Node: ${process.version}`
    ].join("\n");
}

module.exports = {
    DEFAULT_SHELL_TIMEOUT_MS,
    DEFAULT_MAX_OUTPUT_BYTES,
    normalizeCommandLine,
    normalizeCommandPrefix,
    hasUnsafeCommandComposition,
    commandMatchesPrefix,
    findAllowedCommandPrefix,
    deriveAllowedCommandPrefix,
    parseCommandFile,
    loadAllowedCommands,
    saveUserAllowedCommands,
    isPathInside,
    resolveWorkspacePath,
    readFileRange,
    writeFile,
    editFile,
    AgentWorkspaceStore,
    AgentShellRunner,
    getEnvironmentDescription
};
