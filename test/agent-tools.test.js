const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
    readFileRange,
    writeFile,
    editFile,
    commandMatchesPrefix,
    findAllowedCommandPrefix,
    deriveAllowedCommandPrefix,
    AgentWorkspaceStore,
    AgentShellRunner
} = require("../agent-tools");

async function withWorkspace(run) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiui-agent-test-"));
    try {
        await run(root);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

test("read_file_range uses inclusive lines and clamps end_line", async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, "sample.txt"), "one\ntwo\nthree\n", "utf8");
        const result = await readFileRange(root, { path: "sample.txt", start_line: 2, end_line: 100 });
        assert.equal(result.success, true);
        assert.equal(result.content, "two\nthree");
        assert.equal(result.actualStartLine, 2);
        assert.equal(result.actualEndLine, 3);
        assert.equal(result.returnedLines, 2);
        assert.equal(result.totalLines, 3);
    });
});

test("read_file_range reports an empty result beyond EOF", async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, "sample.txt"), "one\ntwo", "utf8");
        const result = await readFileRange(root, { path: "sample.txt", start_line: 3, end_line: 8 });
        assert.equal(result.success, true);
        assert.equal(result.content, "");
        assert.equal(result.returnedLines, 0);
        assert.equal(result.totalLines, 2);
    });
});

test("workspace file tools reject parent traversal and outside absolute paths", async () => {
    await withWorkspace(async root => {
        const traversal = await writeFile(root, { path: "../outside.txt", content: "no" });
        assert.equal(traversal.success, false);
        const outside = await readFileRange(root, { path: path.parse(root).root, start_line: 1, end_line: 1 });
        assert.equal(outside.success, false);
    });
});

test("write_file creates parents and edit_file requires a unique match", async () => {
    await withWorkspace(async root => {
        const written = await writeFile(root, { path: "nested/file.txt", content: "alpha beta alpha" });
        assert.equal(written.success, true);
        const ambiguous = await editFile(root, { path: "nested/file.txt", old_text: "alpha", new_text: "x" });
        assert.deepEqual(ambiguous, { success: false, error: "old_text is ambiguous", occurrences: 2 });
        const edited = await editFile(root, { path: "nested/file.txt", old_text: "alpha beta", new_text: "gamma" });
        assert.equal(edited.success, true);
        assert.equal(await fs.readFile(path.join(root, "nested/file.txt"), "utf8"), "gamma alpha");
    });
});

test("safe command matching enforces boundaries and rejects chaining", () => {
    assert.equal(commandMatchesPrefix("git status --short", "git status"), true);
    assert.equal(commandMatchesPrefix("git statusx", "git status"), false);
    assert.equal(commandMatchesPrefix("git status; Remove-Item file", "git status"), false);
    assert.equal(commandMatchesPrefix('git status "$(Remove-Item file)"', "git status"), false);
    assert.equal(findAllowedCommandPrefix("npm run build -- --mode test", ["npm run", "npm run build"]), "npm run build");
    assert.equal(deriveAllowedCommandPrefix("git push origin main"), "git push");
});

test("workspace bindings are immutable until removed", async () => {
    await withWorkspace(async root => {
        const other = await fs.mkdtemp(path.join(os.tmpdir(), "aiui-agent-other-"));
        const store = new AgentWorkspaceStore(path.join(root, "bindings.json"));
        try {
            const first = await store.bind("chat-1", root);
            const second = await store.bind("chat-1", other);
            assert.equal(second.path, first.path);
            await store.remove("chat-1");
            const rebound = await store.bind("chat-1", other);
            assert.equal(rebound.path, await fs.realpath(other));
        } finally {
            await fs.rm(other, { recursive: true, force: true });
        }
    });
});

test("run_shell returns stdout, stderr, and exitCode without using an AI API", async () => {
    await withWorkspace(async root => {
        const runner = new AgentShellRunner();
        const result = await runner.run({
            executionId: "test-shell",
            command: process.platform === "win32" ? "Write-Output agent-ok" : "printf agent-ok",
            cwd: root,
            timeoutMs: 10000
        });
        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, /agent-ok/);
        assert.equal(typeof result.stderr, "string");
    });
});
