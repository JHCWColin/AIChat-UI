const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const DEFAULT_SHELL_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_READ_LINE_COUNT = 2000;
const MAX_READ_CHARACTERS = 1000000;
const DEFAULT_GLOB_LIMIT = 100;
const MAX_GLOB_LIMIT = 1000;
const BACKGROUND_SHELL_BUFFER_BYTES = 512 * 1024;
const BACKGROUND_SHELL_MAX_LIFETIME_MS = 30 * 60 * 1000;
const DEFAULT_SEARCH_ENGINES = ["bing", "duckduckgo"];
const WORKSPACE_SCAN_EXCLUDED_DIRECTORIES = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage"
]);

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

function buildLineDiff(beforeContent, afterContent) {
    const before = splitTextLines(beforeContent);
    const after = splitTextLines(afterContent);
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (
        suffix < before.length - prefix
        && suffix < after.length - prefix
        && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) suffix += 1;
    const removed = before.slice(prefix, before.length - suffix);
    const added = after.slice(prefix, after.length - suffix);
    return {
        removedLines: removed.length,
        addedLines: added.length,
        lines: [
            ...removed.map(text => ({ type: "delete", text })),
            ...added.map(text => ({ type: "add", text }))
        ]
    };
}

async function readFileRange(workspacePath, args = {}) {
    const hasStart = args.start_line !== undefined && args.start_line !== null && args.start_line !== "";
    const hasEnd = args.end_line !== undefined && args.end_line !== null && args.end_line !== "";
    const startLine = hasStart ? Number(args.start_line) : 1;
    const explicitEnd = hasEnd ? Number(args.end_line) : null;
    if (hasStart && (!Number.isInteger(startLine) || startLine < 1)) {
        return { success: false, error: "start_line must be a positive integer" };
    }
    if (hasEnd && (!Number.isInteger(explicitEnd) || explicitEnd < 1)) {
        return { success: false, error: "end_line must be a positive integer" };
    }
    if (explicitEnd !== null && startLine > explicitEnd) return { success: false, error: "start_line must not exceed end_line" };
    // Without an explicit end_line the caller wants an open-ended read; cap the
    // span so a single call can never return an unbounded amount of text.
    const endLine = explicitEnd !== null ? explicitEnd : startLine + DEFAULT_READ_LINE_COUNT - 1;
    try {
        const { targetPath, workspaceReal } = await resolveWorkspacePath(workspacePath, args.path);
        const content = await fs.readFile(targetPath, "utf8");
        const lines = splitTextLines(content);
        const totalLines = lines.length;
        const relativePath = path.relative(workspaceReal, targetPath) || path.basename(targetPath);
        const selection = lines.slice(startLine - 1, endLine);
        const selectedText = selection.join("\n");
        let text = selectedText;
        let truncatedByLength = false;
        if (selectedText.length > MAX_READ_CHARACTERS) {
            // Cut on a line boundary so the reported next start_line never lands
            // in the middle of a line the caller only partially received.
            const boundary = selectedText.lastIndexOf("\n", MAX_READ_CHARACTERS);
            text = boundary > 0 ? selectedText.slice(0, boundary) : selectedText.slice(0, MAX_READ_CHARACTERS);
            truncatedByLength = true;
        }
        // A successful read always reports the range it actually delivered, so the
        // model can page forward with start_line instead of re-reading from line 1.
        const deliveredLines = text ? splitTextLines(text).length : 0;
        const hasMore = truncatedByLength || startLine - 1 + deliveredLines < totalLines;
        const result = {
            success: true,
            path: relativePath,
            requestedStartLine: startLine,
            requestedEndLine: explicitEnd,
            actualStartLine: deliveredLines ? startLine : null,
            actualEndLine: deliveredLines ? startLine + deliveredLines - 1 : null,
            returnedLines: deliveredLines,
            totalLines,
            hasMore,
            truncated: truncatedByLength,
            content: text
        };
        if (!deliveredLines) {
            result.note = startLine > totalLines
                ? `start_line exceeds the file length (${totalLines} lines)`
                : "the requested range contains no text";
        } else if (hasMore) {
            result.note = `file continues beyond returned lines; continue with start_line=${startLine + deliveredLines}`;
        }
        return result;
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function writeFile(workspacePath, args = {}) {
    if (typeof args.content !== "string") return { success: false, error: "content must be a string" };
    try {
        const { targetPath, workspaceReal } = await resolveWorkspacePath(workspacePath, args.path, { allowMissing: true });
        let previousContent = "";
        let existed = true;
        try {
            previousContent = await fs.readFile(targetPath, "utf8");
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
            existed = false;
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, args.content, "utf8");
        return {
            success: true,
            path: path.relative(workspaceReal, targetPath) || path.basename(targetPath),
            charactersWritten: args.content.length,
            bytesWritten: Buffer.byteLength(args.content, "utf8"),
            created: !existed,
            displayDiff: buildLineDiff(previousContent, args.content)
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
        if (occurrences === 0) {
            return {
                success: false,
                error: "old_text not found",
                hint: "Re-read the file and copy old_text verbatim, including whitespace and indentation. Do not include line-number prefixes.",
                totalLines: splitTextLines(content).length
            };
        }
        if (occurrences > 1) {
            return {
                success: false,
                error: "old_text is ambiguous",
                occurrences,
                hint: `old_text matches ${occurrences} locations. Include more surrounding context so it matches exactly once, or use multi_edit_file to replace several occurrences deliberately.`
            };
        }
        const nextContent = content.replace(args.old_text, args.new_text);
        await fs.writeFile(targetPath, nextContent, "utf8");
        return {
            success: true,
            path: path.relative(workspaceReal, targetPath) || path.basename(targetPath),
            occurrences: 1,
            charactersBefore: content.length,
            charactersAfter: nextContent.length,
            displayDiff: buildLineDiff(content, nextContent)
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function normalizeEditEntries(args = {}) {
    const raw = Array.isArray(args.edits) && args.edits.length
        ? args.edits
        : (typeof args.old_text === "string" ? [args] : []);
    return raw.map(entry => ({
        oldText: typeof entry?.old_text === "string" ? entry.old_text : "",
        newText: typeof entry?.new_text === "string" ? entry.new_text : "",
        replaceAll: entry?.replace_all === true
    }));
}

async function multiEditFile(workspacePath, args = {}) {
    const edits = normalizeEditEntries(args);
    if (!edits.length) return { success: false, error: "edits must contain at least one {old_text,new_text} entry" };
    const invalidIndex = edits.findIndex(edit => !edit.oldText);
    if (invalidIndex >= 0) return { success: false, error: `edits[${invalidIndex}].old_text must be a non-empty string` };
    try {
        const { targetPath, workspaceReal } = await resolveWorkspacePath(workspacePath, args.path);
        const original = await fs.readFile(targetPath, "utf8");
        const relativePath = path.relative(workspaceReal, targetPath) || path.basename(targetPath);
        let content = original;
        const applied = [];
        // Each edit sees the result of the previous one, matching the order the
        // model wrote them in; a failure aborts before anything reaches disk.
        for (let index = 0; index < edits.length; index += 1) {
            const edit = edits[index];
            const occurrences = countOccurrences(content, edit.oldText);
            if (occurrences === 0) {
                return {
                    success: false,
                    path: relativePath,
                    failedIndex: index,
                    appliedCount: 0,
                    error: `edits[${index}].old_text not found`,
                    hint: "No edits were saved because the batch must apply atomically. Re-read the file and verify every old_text."
                };
            }
            if (occurrences > 1 && !edit.replaceAll) {
                return {
                    success: false,
                    path: relativePath,
                    failedIndex: index,
                    occurrences,
                    appliedCount: 0,
                    error: `edits[${index}].old_text is ambiguous`,
                    hint: `edits[${index}].old_text matches ${occurrences} locations. Add surrounding context, or set replace_all=true for that entry to replace all of them.`
                };
            }
            content = edit.replaceAll
                ? content.split(edit.oldText).join(edit.newText)
                : content.replace(edit.oldText, edit.newText);
            applied.push({ index, occurrences });
            if (content === original) {
                return {
                    success: false,
                    path: relativePath,
                    failedIndex: index,
                    appliedCount: 0,
                    error: `edits[${index}] produced no change`,
                    hint: "old_text and new_text are identical. Remove the no-op edit or supply the intended replacement."
                };
            }
        }
        if (content === original) return { success: false, path: relativePath, error: "edits produced no change" };
        await fs.writeFile(targetPath, content, "utf8");
        return {
            success: true,
            path: relativePath,
            editCount: edits.length,
            applied,
            charactersBefore: original.length,
            charactersAfter: content.length,
            displayDiff: buildLineDiff(original, content)
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function globToRegExp(pattern) {
    // Translate a shell-style glob into an anchored regexp that matches POSIX-style
    // relative paths. "**" spans directory separators, "*" and "?" stay within one
    // segment, and character classes pass through unchanged.
    const source = String(pattern || "").trim();
    let regex = "";
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (char === "*") {
            if (source[index + 1] === "*") {
                index += 1;
                if (source[index + 1] === "/") {
                    index += 1;
                    regex += "(?:[^/]+/)*";
                } else {
                    regex += ".*";
                }
            } else {
                regex += "[^/]*";
            }
            continue;
        }
        if (char === "?") { regex += "[^/]"; continue; }
        if (char === "[") {
            const close = source.indexOf("]", index + 1);
            if (close > index + 1) {
                let body = source.slice(index + 1, close);
                if (body[0] === "!") body = `^${body.slice(1)}`;
                regex += `[${body.replace(/\\/g, "\\\\")}]`;
                index = close;
                continue;
            }
        }
        regex += char.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    return new RegExp(`^${regex}$`, "i");
}

async function globFiles(workspacePath, args = {}) {
    const pattern = String(args.pattern || "").trim();
    if (!pattern) return { success: false, error: "pattern is required" };
    const limit = Math.max(1, Math.min(MAX_GLOB_LIMIT, Number(args.limit) || DEFAULT_GLOB_LIMIT));
    try {
        const directoryInput = String(args.path || args.dir_path || ".").trim() || ".";
        const { workspaceReal, targetPath } = await resolveWorkspacePath(workspacePath, directoryInput, { allowMissing: false });
        const startStat = await fs.stat(targetPath);
        if (!startStat.isDirectory()) return { success: false, error: `not a directory: ${directoryInput}` };
        let matcher;
        try {
            matcher = globToRegExp(pattern);
        } catch (error) {
            return { success: false, error: `invalid glob pattern: ${error.message}` };
        }
        const matches = [];
        let truncated = false;
        const visit = async directory => {
            if (matches.length >= limit) { truncated = true; return; }
            let entries;
            try {
                entries = await fs.readdir(directory, { withFileTypes: true });
            } catch {
                return;
            }
            entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
            for (const entry of entries) {
                if (matches.length >= limit) { truncated = true; break; }
                if (entry.isSymbolicLink()) continue;
                if (WORKSPACE_SCAN_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
                const fullPath = path.join(directory, entry.name);
                const relativePath = path.relative(workspaceReal, fullPath).split(path.sep).join("/");
                if (entry.isDirectory()) {
                    await visit(fullPath);
                    continue;
                }
                if (!entry.isFile() || !matcher.test(relativePath)) continue;
                let entryStat;
                try {
                    entryStat = await fs.stat(fullPath);
                } catch {
                    continue;
                }
                matches.push({
                    path: relativePath,
                    size: entryStat.size,
                    modifiedAt: entryStat.mtime?.toISOString?.() || ""
                });
            }
        };
        await visit(targetPath);
        matches.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path));
        return { success: true, pattern, matches, totalCount: matches.length, truncated };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function deletePath(workspacePath, args = {}) {
    const requested = String(args.path || "").trim();
    if (!requested) return { success: false, error: "path is required" };
    if (rejectsParentTraversal(requested)) return { success: false, error: "parent traversal is not allowed" };
    try {
        const { workspaceReal, targetPath } = await resolveWorkspacePath(workspacePath, requested, { allowMissing: false });
        const relativePath = path.relative(workspaceReal, targetPath) || path.basename(targetPath);
        // Refuse to delete the workspace root itself; that would destroy the session.
        if (!relativePath || relativePath === "." || targetPath === workspaceReal) {
            return { success: false, error: "refusing to delete the workspace root" };
        }
        const stats = await fs.lstat(targetPath);
        if (stats.isDirectory()) {
            const entries = await fs.readdir(targetPath);
            if (entries.length && args.recursive !== true) {
                return {
                    success: false,
                    path: relativePath,
                    entryCount: entries.length,
                    error: "directory is not empty",
                    hint: "Pass recursive:true to delete a non-empty directory, or delete its files individually."
                };
            }
            await fs.rm(targetPath, { recursive: true, force: false });
            return { success: true, path: relativePath, type: "directory", removedEntries: entries.length };
        }
        await fs.rm(targetPath, { force: false });
        return { success: true, path: relativePath, type: "file", size: stats.size };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function movePath(workspacePath, args = {}) {
    const from = String(args.from || args.source || "").trim();
    const to = String(args.to || args.destination || "").trim();
    if (!from || !to) return { success: false, error: "from and to are required" };
    try {
        const source = await resolveWorkspacePath(workspacePath, from, { allowMissing: false });
        const destination = await resolveWorkspacePath(workspacePath, to, { allowMissing: true });
        const { workspaceReal } = source;
        if (source.targetPath === workspaceReal) return { success: false, error: "refusing to move the workspace root" };
        let overwrote = false;
        try {
            await fs.lstat(destination.targetPath);
            overwrote = true;
            if (args.overwrite !== true) {
                return {
                    success: false,
                    from: path.relative(workspaceReal, source.targetPath).split(path.sep).join("/"),
                    to: path.relative(workspaceReal, destination.targetPath).split(path.sep).join("/"),
                    error: "destination already exists",
                    hint: "Pass overwrite:true to replace the existing target."
                };
            }
        } catch (error) {
            if (!error || error.code !== "ENOENT") throw error;
        }
        await fs.mkdir(path.dirname(destination.targetPath), { recursive: true });
        await fs.rename(source.targetPath, destination.targetPath);
        return {
            success: true,
            from: path.relative(workspaceReal, source.targetPath).split(path.sep).join("/"),
            to: path.relative(workspaceReal, destination.targetPath).split(path.sep).join("/"),
            overwrote
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function copyPath(workspacePath, args = {}) {
    const from = String(args.from || args.source || "").trim();
    const to = String(args.to || args.destination || "").trim();
    if (!from || !to) return { success: false, error: "from and to are required" };
    try {
        const source = await resolveWorkspacePath(workspacePath, from, { allowMissing: false });
        const destination = await resolveWorkspacePath(workspacePath, to, { allowMissing: true });
        const { workspaceReal } = source;
        const relativeFrom = path.relative(workspaceReal, source.targetPath).split(path.sep).join("/");
        const relativeTo = path.relative(workspaceReal, destination.targetPath).split(path.sep).join("/");
        const sourceStats = await fs.lstat(source.targetPath);
        if (sourceStats.isDirectory()) {
            if (isPathInside(source.targetPath, destination.targetPath)) {
                return { success: false, error: "cannot copy a directory into itself" };
            }
            await fs.mkdir(destination.targetPath, { recursive: true });
            await fs.cp(source.targetPath, destination.targetPath, {
                recursive: true,
                force: args.overwrite === true,
                errorOnExist: args.overwrite !== true,
                filter: candidate => {
                    // Keep the copy inside the workspace and skip links and build output.
                    const candidateReal = path.resolve(candidate);
                    if (!isPathInside(workspaceReal, candidateReal)) return false;
                    // The root itself is always copied; only descendants are filtered.
                    if (candidateReal === path.resolve(source.targetPath)) return true;
                    return !WORKSPACE_SCAN_EXCLUDED_DIRECTORIES.has(path.basename(candidate).toLowerCase());
                }
            });
            return { success: true, from: relativeFrom, to: relativeTo, type: "directory" };
        }
        await fs.mkdir(path.dirname(destination.targetPath), { recursive: true });
        if (args.overwrite !== true) {
            try {
                await fs.lstat(destination.targetPath);
                return {
                    success: false,
                    from: relativeFrom,
                    to: relativeTo,
                    error: "destination already exists",
                    hint: "Pass overwrite:true to replace the existing target."
                };
            } catch (error) {
                if (!error || error.code !== "ENOENT") throw error;
            }
        }
        await fs.copyFile(source.targetPath, destination.targetPath);
        return { success: true, from: relativeFrom, to: relativeTo, type: "file", size: sourceStats.size };
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
        const windowsCommand = `$agentUtf8 = New-Object System.Text.UTF8Encoding $false; [Console]::InputEncoding = $agentUtf8; [Console]::OutputEncoding = $agentUtf8; $OutputEncoding = $agentUtf8; ${command}`;
        const shellArgs = process.platform === "win32"
            ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsCommand]
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

/**
 * Runs long-lived processes (dev servers, watchers) that the Agent must start and
 * keep running while it continues working. Output is buffered in a ring so the
 * model can poll it with read_process_output instead of blocking a shell call.
 */
class AgentBackgroundShellManager {
    constructor(options = {}) {
        this.processes = new Map();
        this.sequence = 0;
        this.maxLifetimeMs = Number(options.maxLifetimeMs) > 0 ? Number(options.maxLifetimeMs) : BACKGROUND_SHELL_MAX_LIFETIME_MS;
    }

    buildCommand(command) {
        if (process.platform === "win32") {
            return {
                executable: "powershell.exe",
                args: [
                    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                    `$agentUtf8 = New-Object System.Text.UTF8Encoding $false; [Console]::InputEncoding = $agentUtf8; [Console]::OutputEncoding = $agentUtf8; $OutputEncoding = $agentUtf8; ${command}`
                ]
            };
        }
        return { executable: process.env.SHELL || "/bin/sh", args: ["-lc", command] };
    }

    start(options = {}) {
        const processId = String(options.processId || "").trim() || `bg-${Date.now()}-${this.sequence += 1}`;
        const command = String(options.command || "");
        if (!command.trim()) return { success: false, error: "command is required" };
        if (this.processes.has(processId)) return { success: false, error: `process id already in use: ${processId}` };
        const { executable, args } = this.buildCommand(command);
        let child;
        try {
            child = spawn(executable, args, {
                cwd: options.cwd,
                windowsHide: true,
                env: process.env
            });
        } catch (error) {
            return { success: false, error: error.message };
        }
        const state = {
            processId,
            command,
            child,
            stdoutBytes: 0,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutChunks: [],
            stderrChunks: [],
            startedAt: Date.now(),
            exitCode: null,
            exited: false,
            cancelled: false,
            timer: null
        };
        const appendChunk = (chunk, target, streamName) => {
            const buffer = Buffer.from(chunk);
            if (streamName === "stdout") state.stdoutBytes += buffer.length;
            else state.stderrBytes += buffer.length;
            target.push(buffer);
            let total = target.reduce((sum, item) => sum + item.length, 0);
            while (total > BACKGROUND_SHELL_BUFFER_BYTES && target.length > 1) {
                const removed = target.shift();
                total -= removed.length;
                if (streamName === "stdout") state.stdoutTruncated = true;
                else state.stderrTruncated = true;
            }
        };
        child.stdout?.on("data", chunk => appendChunk(chunk, state.stdoutChunks, "stdout"));
        child.stderr?.on("data", chunk => appendChunk(chunk, state.stderrChunks, "stderr"));
        child.on("error", error => {
            state.exited = true;
            state.exitCode = -1;
            state.error = error.message;
        });
        child.on("close", code => {
            state.exited = true;
            state.exitCode = Number.isInteger(code) ? code : -1;
            if (state.timer) clearTimeout(state.timer);
        });
        // Background processes are a convenience, never a permanent leak: reap on
        // a fixed lifetime so a forgotten server cannot outlive the session.
        state.timer = setTimeout(() => {
            state.timedOut = true;
            killProcessTree(child);
        }, this.maxLifetimeMs);
        state.timer.unref?.();
        this.processes.set(processId, state);
        return {
            success: true,
            processId,
            command,
            cwd: options.cwd,
            message: `process started in the background; poll it with read_process_output using process_id="${processId}"`
        };
    }

    read(processId, options = {}) {
        const state = this.processes.get(String(processId || "").trim());
        if (!state) return { success: false, error: `unknown process id: ${processId}` };
        const tailBytes = Number(options.tail_bytes) > 0 ? Math.min(Number(options.tail_bytes), BACKGROUND_SHELL_BUFFER_BYTES) : 0;
        const collect = chunks => {
            const text = Buffer.concat(chunks).toString("utf8");
            return tailBytes > 0 && text.length > tailBytes ? text.slice(-tailBytes) : text;
        };
        return {
            success: true,
            processId: state.processId,
            command: state.command,
            running: !state.exited,
            exitCode: state.exitCode,
            elapsedMs: Date.now() - state.startedAt,
            stdout: collect(state.stdoutChunks),
            stderr: collect(state.stderrChunks),
            stdoutBytes: state.stdoutBytes,
            stderrBytes: state.stderrBytes,
            stdoutTruncated: state.stdoutTruncated,
            stderrTruncated: state.stderrTruncated,
            timedOut: state.timedOut === true,
            hint: state.exited
                ? "process has exited; the buffer above is its complete retained output"
                : "process is still running; call read_process_output again after it has had time to produce output"
        };
    }

    list() {
        return {
            success: true,
            processes: [...this.processes.values()].map(state => ({
                processId: state.processId,
                command: state.command,
                running: !state.exited,
                exitCode: state.exitCode,
                elapsedMs: Date.now() - state.startedAt,
                stdoutBytes: state.stdoutBytes,
                stderrBytes: state.stderrBytes
            }))
        };
    }

    stop(processId) {
        const key = String(processId || "").trim();
        const state = this.processes.get(key);
        if (!state) return { success: false, error: `unknown process id: ${processId}` };
        state.cancelled = true;
        if (!state.exited) killProcessTree(state.child);
        const result = this.read(key);
        this.processes.delete(key);
        if (state.timer) clearTimeout(state.timer);
        return {
            ...result,
            running: false,
            stopped: true,
            finalStdout: result.stdout,
            finalStderr: result.stderr
        };
    }

    /**
     * Stops a process and resolves once it has actually exited. On Windows the
     * kill is performed by an async `taskkill`, so the synchronous stop() returns
     * before the process is gone and its working directory stays locked.
     */
    async stopAndWait(processId, timeoutMs = 5000) {
        const key = String(processId || "").trim();
        const state = this.processes.get(key);
        if (!state) return { success: false, error: `unknown process id: ${processId}` };
        if (state.exited) return this.stop(key);
        const exited = new Promise(resolve => {
            if (state.exited) { resolve(); return; }
            state.child.once("close", resolve);
            // A process that ignores termination must not hang the caller forever.
            setTimeout(resolve, timeoutMs).unref?.();
        });
        const result = this.stop(key);
        await exited;
        return result;
    }

    async stopAllAndWait(timeoutMs = 5000) {
        const ids = [...this.processes.keys()];
        await Promise.all(ids.map(id => this.stopAndWait(id, timeoutMs)));
        return ids;
    }

    stopAll() {
        const ids = [...this.processes.keys()];
        ids.forEach(id => this.stop(id));
        return ids;
    }
}

/**
 * Parses the `*** Begin Patch` envelope emitted natively by Codex- and
 * Claude-Code-style models. Supporting it means a model that ignores our JSON
 * protocol still produces useful edits instead of a hard failure.
 */
function parseApplyPatch(patchText) {
    const lines = splitTextLines(String(patchText || ""));
    if (!lines.length) return { error: "patch is empty" };
    const operations = [];
    let current = null;
    let cursor = 0;
    if (/^\*\*\*\s*Begin Patch\s*$/i.test(lines[0].trim())) cursor = 1;

    const finishCurrent = () => {
        if (!current) return;
        if (current.type === "update" && !current.hunks.length) {
            current.error = "update section contains no @@ hunk";
        }
        operations.push(current);
        current = null;
    };

    for (; cursor < lines.length; cursor += 1) {
        const raw = lines[cursor];
        const trimmed = raw.trim();
        if (/^\*\*\*\s*End Patch\s*$/i.test(trimmed)) break;
        if (/^\*\*\*\s*Begin Patch\s*$/i.test(trimmed)) continue;
        const marker = trimmed.match(/^\*\*\*\s*(Add|Update|Delete)\s+File:\s*(.+?)\s*$/i);
        if (marker) {
            finishCurrent();
            const type = marker[1].toLowerCase();
            current = { type, path: marker[2], lines: [], hunks: [] };
            continue;
        }
        if (!current) {
            if (trimmed) return { error: `unexpected content before any file section: ${trimmed.slice(0, 120)}` };
            continue;
        }
        if (trimmed.startsWith("@@")) {
            if (current.type !== "update") return { error: `@@ hunk is only valid in an Update section (${current.path})` };
            current.hunks.push({ header: trimmed, lines: [] });
            continue;
        }
        if (current.type === "update") {
            if (!current.hunks.length) {
                // A raw +/- line before any @@ hunk: start an implicit hunk.
                if (/^[+\-]/.test(raw)) current.hunks.push({ header: "", lines: [] });
                else if (!trimmed) continue;
                else return { error: `update section for ${current.path} has content before the first @@ hunk` };
            }
            current.hunks[current.hunks.length - 1].lines.push(raw);
            continue;
        }
        current.lines.push(raw);
    }
    finishCurrent();
    if (!operations.length) return { error: "no file sections found in patch" };
    return { operations };
}

/** Applies one Update-section hunk by locating its exact old-line block. */
function applyPatchHunk(content, hunk, pathLabel) {
    const oldLines = [];
    const newLines = [];
    for (const raw of hunk.lines) {
        if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
        if (raw.startsWith("-")) { oldLines.push(raw.slice(1)); continue; }
        if (raw.startsWith("+")) { newLines.push(raw.slice(1)); continue; }
        // Context lines (leading space, or an empty line) belong to both sides.
        const context = raw.startsWith(" ") ? raw.slice(1) : raw;
        oldLines.push(context);
        newLines.push(context);
    }
    if (!oldLines.length) return { error: `hunk for ${pathLabel} has no context or removed lines to locate` };
    const fileLines = splitTextLines(content);
    let matches = 0;
    let matchIndex = -1;
    for (let start = 0; start + oldLines.length <= fileLines.length; start += 1) {
        let equal = true;
        for (let offset = 0; offset < oldLines.length; offset += 1) {
            if (fileLines[start + offset] !== oldLines[offset]) { equal = false; break; }
        }
        if (!equal) continue;
        matches += 1;
        matchIndex = start;
        if (matches > 1) break;
    }
    if (matches === 0) return { error: `hunk context not found in ${pathLabel}` };
    if (matches > 1) return { error: `hunk context is ambiguous in ${pathLabel} (matched ${matches}+ locations)` };
    const next = [
        ...fileLines.slice(0, matchIndex),
        ...newLines,
        ...fileLines.slice(matchIndex + oldLines.length)
    ];
    const hadTrailingNewline = /\r?\n$/.test(content);
    return { content: next.join("\n") + (hadTrailingNewline && next.length ? "\n" : ""), removedLines: oldLines.length, addedLines: newLines.length };
}

async function applyPatch(workspacePath, args = {}) {
    const patchText = String(args.input || args.patch || args.diff || args.content || "");
    if (!patchText.trim()) return { success: false, error: "patch input is required" };
    const parsed = parseApplyPatch(patchText);
    if (parsed.error) return { success: false, error: parsed.error };
    const results = [];
    const diffs = [];
    try {
        const workspaceReal = await fs.realpath(workspacePath);
        for (const operation of parsed.operations) {
            if (operation.error) return { success: false, error: operation.error, appliedCount: 0 };
            const target = await resolveWorkspacePath(workspacePath, operation.path, { allowMissing: operation.type === "add" });
            const relativePath = path.relative(workspaceReal, target.targetPath).split(path.sep).join("/");
            let existing = "";
            let existed = false;
            try {
                existing = await fs.readFile(target.targetPath, "utf8");
                existed = true;
            } catch (error) {
                if (error?.code !== "ENOENT") throw error;
            }
            if (operation.type === "add") {
                if (existed) return { success: false, error: `Add File target already exists: ${relativePath}`, appliedCount: 0 };
                const addedLines = operation.lines
                    .filter(raw => !raw.startsWith("\\"))
                    .map(raw => (raw.startsWith("+") ? raw.slice(1) : raw));
                while (addedLines.length && !addedLines[addedLines.length - 1].trim()) addedLines.pop();
                const created = addedLines.join("\n") + (addedLines.length ? "\n" : "");
                await fs.mkdir(path.dirname(target.targetPath), { recursive: true });
                await fs.writeFile(target.targetPath, created, "utf8");
                diffs.push(buildLineDiff("", created));
                results.push({ type: "add", path: relativePath, addedLines: addedLines.length });
                continue;
            }
            if (!existed) return { success: false, error: `file not found for ${operation.type}: ${relativePath}`, appliedCount: 0 };
            if (operation.type === "delete") {
                await fs.rm(target.targetPath, { force: false });
                diffs.push(buildLineDiff(existing, ""));
                results.push({ type: "delete", path: relativePath, removedLines: splitTextLines(existing).length });
                continue;
            }
            let content = existing;
            for (const hunk of operation.hunks) {
                const applied = applyPatchHunk(content, hunk, relativePath);
                if (applied.error) return { success: false, error: applied.error, appliedCount: 0 };
                content = applied.content;
            }
            if (content === existing) {
                results.push({ type: "update", path: relativePath, hunks: operation.hunks.length, changed: false });
                continue;
            }
            await fs.writeFile(target.targetPath, content, "utf8");
            diffs.push(buildLineDiff(existing, content));
            results.push({ type: "update", path: relativePath, hunks: operation.hunks.length, changed: true });
        }
        // Combine per-file diffs so the UI can render one ordinary diff block.
        const combined = {
            removedLines: diffs.reduce((sum, diff) => sum + diff.removedLines, 0),
            addedLines: diffs.reduce((sum, diff) => sum + diff.addedLines, 0),
            lines: diffs.flatMap(diff => diff.lines)
        };
        return {
            success: true,
            operationCount: results.length,
            operations: results,
            displayDiff: combined
        };
    } catch (error) {
        return { success: false, error: error.message, appliedCount: 0 };
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

async function scanWorkspaceTextFiles(workspacePath) {
    const workspaceReal = await fs.realpath(workspacePath);
    const matches = [];

    async function visit(directory) {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory() && WORKSPACE_SCAN_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(target);
                continue;
            }
            if (!entry.isFile()) continue;
            const extension = path.extname(entry.name).toLowerCase();
            if (extension !== ".txt" && extension !== ".md") continue;
            matches.push(path.relative(workspaceReal, target).split(path.sep).join("/"));
        }
    }

    await visit(workspaceReal);
    matches.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
    return {
        totalCount: matches.length,
        preview: matches.slice(0, 5)
    };
}

async function listDir(workspacePath, args = {}) {
    try {
        const dirPath = String(args.dir_path || args.path || ".").trim();
        const offset = Math.max(0, Number(args.offset) || 0);
        const limit = Number(args.limit) > 0 ? Number(args.limit) : 0;
        const maxDepth = Math.max(1, Math.min(10, Number(args.depth) || 1));
        const { workspaceReal, targetPath } = await resolveWorkspacePath(workspacePath, dirPath, { allowMissing: false });
        const stat = await fs.stat(targetPath);
        if (!stat.isDirectory()) return { success: false, error: `not a directory: ${dirPath}` };
        const allEntries = [];
        async function visit(directory, currentDepth) {
            let entries;
            try {
                entries = await fs.readdir(directory, { withFileTypes: true });
            } catch (error) {
                return;
            }
            entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
            for (const entry of entries) {
                if (entry.isSymbolicLink()) continue;
                if (WORKSPACE_SCAN_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
                const fullPath = path.join(directory, entry.name);
                const relativePath = path.relative(workspaceReal, fullPath).split(path.sep).join("/");
                let entryStat;
                try {
                    entryStat = await fs.stat(fullPath);
                } catch {
                    continue;
                }
                allEntries.push({
                    name: entry.name,
                    path: relativePath || entry.name,
                    type: entryStat.isDirectory() ? "directory" : "file",
                    size: entryStat.isFile() ? entryStat.size : 0,
                    modifiedAt: entryStat.mtime?.toISOString?.() || ""
                });
                if (entryStat.isDirectory() && currentDepth < maxDepth) {
                    await visit(fullPath, currentDepth + 1);
                }
            }
        }
        await visit(targetPath, 1);
        const totalCount = allEntries.length;
        const paginated = limit > 0 ? allEntries.slice(offset, offset + limit) : allEntries.slice(offset);
        return {
            success: true,
            path: path.relative(workspaceReal, targetPath) || ".",
            entries: paginated,
            totalCount,
            offset,
            limit: limit || totalCount,
            hasMore: limit > 0 && offset + limit < totalCount
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function grepFiles(workspacePath, args = {}) {
    try {
        const pattern = String(args.pattern || "").trim();
        if (!pattern) return { success: false, error: "pattern is required" };
        const includeGlob = String(args.include || "").trim();
        const excludeGlob = String(args.exclude || "").trim();
        const searchPath = String(args.path || ".").trim() || ".";
        const limit = Math.max(1, Math.min(1000, Number(args.limit) || 100));
        const caseSensitive = args.case_sensitive === true;
        const filesOnly = args.output_mode === "files_only";
        const includeContext = filesOnly ? 0 : Math.max(0, Math.min(10, Number(args.context) || 0));
        let regex;
        try {
            regex = new RegExp(pattern, caseSensitive ? "" : "i");
        } catch (error) {
            return { success: false, error: `invalid regex pattern: ${error.message}` };
        }
        const { workspaceReal, targetPath } = await resolveWorkspacePath(workspacePath, searchPath, { allowMissing: false });
        const toGlobMatcher = glob => {
            if (!glob) return null;
            try {
                return globToRegExp(glob);
            } catch {
                return null;
            }
        };
        const includeMatch = toGlobMatcher(includeGlob);
        const excludeMatch = toGlobMatcher(excludeGlob);
        const matches = [];
        const matchedFiles = new Set();
        let truncated = false;
        let scannedFiles = 0;
        const considerFile = async fullPath => {
            const relativePath = path.relative(workspaceReal, fullPath).split(path.sep).join("/");
            const baseName = path.basename(fullPath);
            if (includeMatch && !includeMatch.test(relativePath) && !includeMatch.test(baseName)) return;
            if (excludeMatch && (excludeMatch.test(relativePath) || excludeMatch.test(baseName))) return;
            let content;
            try {
                const fileStat = await fs.stat(fullPath);
                if (fileStat.size > 2 * 1024 * 1024) return;
                content = await fs.readFile(fullPath, "utf8");
            } catch {
                return;
            }
            // Skip binary-looking files: a NUL byte in the first block is the cheapest
            // reliable signal and avoids returning mojibake line matches.
            if (content.slice(0, 8000).includes("\0")) return;
            scannedFiles += 1;
            const lines = content.split(/\r?\n/);
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                if (matches.length >= limit) { truncated = true; break; }
                if (!regex.test(lines[lineIndex])) continue;
                if (filesOnly) {
                    if (!matchedFiles.has(relativePath)) {
                        matchedFiles.add(relativePath);
                        matches.push({ path: relativePath });
                    }
                    break;
                }
                const entry = {
                    path: relativePath,
                    line: lineIndex + 1,
                    content: lines[lineIndex].slice(0, 500)
                };
                if (includeContext > 0) {
                    const before = [];
                    const after = [];
                    for (let offset = includeContext; offset > 0; offset -= 1) {
                        const position = lineIndex - offset;
                        if (position >= 0) before.push({ line: position + 1, content: lines[position].slice(0, 500) });
                    }
                    for (let offset = 1; offset <= includeContext; offset += 1) {
                        const position = lineIndex + offset;
                        if (position < lines.length) after.push({ line: position + 1, content: lines[position].slice(0, 500) });
                    }
                    if (before.length) entry.before = before;
                    if (after.length) entry.after = after;
                }
                matches.push(entry);
            }
        };
        const visit = async directory => {
            if (matches.length >= limit) { truncated = true; return; }
            let entries;
            try {
                entries = await fs.readdir(directory, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (matches.length >= limit) { truncated = true; break; }
                if (entry.isSymbolicLink()) continue;
                if (WORKSPACE_SCAN_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
                const fullPath = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    await visit(fullPath);
                    continue;
                }
                if (entry.isFile()) await considerFile(fullPath);
            }
        };
        const startStat = await fs.stat(targetPath);
        if (startStat.isFile()) await considerFile(targetPath);
        else await visit(targetPath);
        return {
            success: true,
            pattern,
            matches,
            totalCount: matches.length,
            scannedFiles,
            truncated
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

const IMAGE_MIME_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
};
const MAX_IMAGE_DATA_URL_BYTES = 8 * 1024 * 1024;

async function viewImage(workspacePath, args = {}) {
    try {
        const imagePath = String(args.path || args.file_path || "").trim();
        if (!imagePath) return { success: false, error: "path is required" };
        const { workspaceReal, targetPath } = await resolveWorkspacePath(workspacePath, imagePath, { allowMissing: false });
        const stat = await fs.stat(targetPath);
        if (!stat.isFile()) return { success: false, error: `not a file: ${imagePath}` };
        const extension = path.extname(targetPath).toLowerCase();
        const mimeType = IMAGE_MIME_TYPES[extension] || "application/octet-stream";
        if (!mimeType.startsWith("image/")) {
            return { success: false, error: `not a supported image format: ${extension || "unknown"}` };
        }
        const relativePath = path.relative(workspaceReal, targetPath).split(path.sep).join("/");
        if (stat.size > MAX_IMAGE_DATA_URL_BYTES) {
            return {
                success: true,
                path: relativePath,
                mimeType,
                fileSize: stat.size,
                modifiedAt: stat.mtime?.toISOString?.() || "",
                dataUrl: "",
                note: `image exceeds ${Math.round(MAX_IMAGE_DATA_URL_BYTES / 1024 / 1024)}MB, data URL omitted`
            };
        }
        const buffer = await fs.readFile(targetPath);
        const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
        return {
            success: true,
            path: relativePath,
            mimeType,
            fileSize: stat.size,
            modifiedAt: stat.mtime?.toISOString?.() || "",
            dataUrl
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

module.exports = {
    DEFAULT_SHELL_TIMEOUT_MS,
    DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_READ_LINE_COUNT,
    DEFAULT_GLOB_LIMIT,
    DEFAULT_SEARCH_ENGINES,
    BACKGROUND_SHELL_BUFFER_BYTES,
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
    buildLineDiff,
    readFileRange,
    writeFile,
    editFile,
    multiEditFile,
    globFiles,
    deletePath,
    movePath,
    copyPath,
    applyPatch,
    parseApplyPatch,
    globToRegExp,
    listDir,
    grepFiles,
    viewImage,
    AgentWorkspaceStore,
    AgentShellRunner,
    AgentBackgroundShellManager,
    getEnvironmentDescription,
    scanWorkspaceTextFiles
};
