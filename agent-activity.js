/*
 * Per-chat Agent activity counters shown in the "差异对比" sidebar panel.
 * Shared by the renderer (agent-ui / ui-enhancements) and by archive import so
 * the numbers survive export/import without leaking arbitrary payloads.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.AgentActivity = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const READ_TOOLS = new Set(["read_file_range", "view_image", "list_dir", "glob_files", "grep_files"]);
    const COMMAND_TOOLS = new Set(["run_shell", "start_process"]);
    const WEB_TOOLS = new Set(["web_search", "browse_web"]);
    const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit_file", "_codex_apply_patch", "_claude_insert_text"]);
    const KEYS = ["files", "commands", "web", "writes", "added", "removed"];

    function toCount(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
    }

    function normalize(value) {
        const source = value && typeof value === "object" ? value : {};
        const result = {};
        for (const key of KEYS) result[key] = toCount(source[key]);
        return result;
    }

    function isEmpty(stats) {
        const normalized = normalize(stats);
        return KEYS.every(key => normalized[key] === 0);
    }

    /**
     * Folds one finished tool call into a chat's counters.
     * Returns the updated stats, or null when the call changed nothing.
     */
    function applyToolActivity(chat, toolName, message) {
        if (!chat || !toolName) return null;
        const result = message && message.result;
        if (!result || result.success === false || result.rejected || result.cancelled) return null;
        const name = String(toolName);
        const diff = message ? (message.displayDiff || (message.result && message.result.displayDiff)) : null;
        const added = diff ? toCount(diff.addedLines) : 0;
        const removed = diff ? toCount(diff.removedLines) : 0;
        const touched = READ_TOOLS.has(name) || COMMAND_TOOLS.has(name) || WEB_TOOLS.has(name) || WRITE_TOOLS.has(name) || added || removed;
        if (!touched) return null;
        const stats = normalize(chat.agentActivity);
        if (READ_TOOLS.has(name)) stats.files += 1;
        else if (COMMAND_TOOLS.has(name)) stats.commands += 1;
        else if (WEB_TOOLS.has(name)) stats.web += 1;
        if (WRITE_TOOLS.has(name)) stats.writes += 1;
        stats.added += added;
        stats.removed += removed;
        chat.agentActivity = stats;
        return stats;
    }

    return { READ_TOOLS, COMMAND_TOOLS, WEB_TOOLS, WRITE_TOOLS, normalize, isEmpty, applyToolActivity };
});
