const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
    readFileRange,
    writeFile,
    editFile,
    multiEditFile,
    globFiles,
    deletePath,
    movePath,
    copyPath,
    applyPatch,
    grepFiles,
    buildLineDiff,
    commandMatchesPrefix,
    findAllowedCommandPrefix,
    deriveAllowedCommandPrefix,
    AgentWorkspaceStore,
    AgentShellRunner,
    AgentBackgroundShellManager,
    scanWorkspaceTextFiles
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
        assert.equal(ambiguous.success, false);
        assert.equal(ambiguous.error, "old_text is ambiguous");
        assert.equal(ambiguous.occurrences, 2);
        assert.match(ambiguous.hint, /multi_edit_file/);
        const edited = await editFile(root, { path: "nested/file.txt", old_text: "alpha beta", new_text: "gamma" });
        assert.equal(edited.success, true);
        assert.equal(await fs.readFile(path.join(root, "nested/file.txt"), "utf8"), "gamma alpha");
    });
});

test("edit_file reports a missing match with recovery guidance", async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, "sample.txt"), "hello\nworld\n", "utf8");
        const result = await editFile(root, { path: "sample.txt", old_text: "not present", new_text: "x" });
        assert.equal(result.success, false);
        assert.equal(result.error, "old_text not found");
        assert.match(result.hint, /verbatim/);
        assert.equal(result.totalLines, 2);
    });
});

test("edit_file diffs the whole file rather than the replaced fragment", async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, "sample.txt"), "header\nbody\nfooter\n", "utf8");
        const result = await editFile(root, { path: "sample.txt", old_text: "body", new_text: "content" });
        assert.equal(result.success, true);
        assert.deepEqual(result.displayDiff.lines, [
            { type: "delete", text: "body" },
            { type: "add", text: "content" }
        ]);
    });
});

test("multi_edit_file applies edits atomically and honours replace_all", async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, "app.js"), "const a = 1;\nconst b = 2;\nlog(a, a);\n", "utf8");
        const applied = await multiEditFile(root, {
            path: "app.js",
            edits: [
                { old_text: "const a = 1;", new_text: "const a = 10;" },
                { old_text: "a", new_text: "a2", replace_all: true }
            ]
        });
        assert.equal(applied.success, true);
        assert.equal(applied.editCount, 2);
        assert.equal(await fs.readFile(path.join(root, "app.js"), "utf8"), "const a2 = 10;\nconst b = 2;\nlog(a2, a2);\n");
    });
});

test("multi_edit_file writes nothing when any edit fails", async () => {
    await withWorkspace(async root => {
        const original = "alpha\nbeta\n";
        await fs.writeFile(path.join(root, "app.txt"), original, "utf8");
        const result = await multiEditFile(root, {
            path: "app.txt",
            edits: [
                { old_text: "alpha", new_text: "gamma" },
                { old_text: "missing", new_text: "x" }
            ]
        });
        assert.equal(result.success, false);
        assert.equal(result.failedIndex, 1);
        assert.equal(result.appliedCount, 0);
        assert.equal(await fs.readFile(path.join(root, "app.txt"), "utf8"), original);
    });
});

test("multi_edit_file rejects an ambiguous edit unless replace_all is set", async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, "app.txt"), "dup\ndup\n", "utf8");
        const ambiguous = await multiEditFile(root, { path: "app.txt", edits: [{ old_text: "dup", new_text: "x" }] });
        assert.equal(ambiguous.success, false);
        assert.equal(ambiguous.occurrences, 2);
        const forced = await multiEditFile(root, { path: "app.txt", edits: [{ old_text: "dup", new_text: "x", replace_all: true }] });
        assert.equal(forced.success, true);
        assert.equal(await fs.readFile(path.join(root, "app.txt"), "utf8"), "x\nx\n");
    });
});

test("glob_files matches by relative path and respects the result limit", async () => {
    await withWorkspace(async root => {
        await fs.mkdir(path.join(root, "src", "deep"), { recursive: true });
        await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
        await fs.writeFile(path.join(root, "src", "index.ts"), "a", "utf8");
        await fs.writeFile(path.join(root, "src", "deep", "nested.ts"), "b", "utf8");
        await fs.writeFile(path.join(root, "src", "readme.md"), "c", "utf8");
        await fs.writeFile(path.join(root, "node_modules", "pkg.ts"), "d", "utf8");

        const all = await globFiles(root, { pattern: "**/*.ts" });
        assert.equal(all.success, true);
        assert.deepEqual(all.matches.map(m => m.path).sort(), ["src/deep/nested.ts", "src/index.ts"]);

        const shallow = await globFiles(root, { pattern: "src/*.ts" });
        assert.deepEqual(shallow.matches.map(m => m.path), ["src/index.ts"]);

        const limited = await globFiles(root, { pattern: "**/*.ts", limit: 1 });
        assert.equal(limited.matches.length, 1);
        assert.equal(limited.truncated, true);
    });
});

test("delete_path refuses the workspace root and guards non-empty directories", async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, "keep.txt"), "data", "utf8");
        await fs.mkdir(path.join(root, "folder"), { recursive: true });
        await fs.writeFile(path.join(root, "folder", "inner.txt"), "data", "utf8");

        const rootDelete = await deletePath(root, { path: "." });
        assert.equal(rootDelete.success, false);

        const guarded = await deletePath(root, { path: "folder" });
        assert.equal(guarded.success, false);
        assert.equal(guarded.error, "directory is not empty");

        const recursive = await deletePath(root, { path: "folder", recursive: true });
        assert.equal(recursive.success, true);
        assert.equal(recursive.type, "directory");

        const file = await deletePath(root, { path: "keep.txt" });
        assert.equal(file.success, true);
        assert.equal(file.type, "file");
        await assert.rejects(fs.stat(path.join(root, "keep.txt")));
    });
});

test("move_path and copy_path stay inside the workspace", async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, "source.txt"), "content", "utf8");
        const moved = await movePath(root, { from: "source.txt", to: "nested/moved.txt" });
        assert.equal(moved.success, true);
        assert.equal(moved.to, "nested/moved.txt");

        const copied = await copyPath(root, { from: "nested/moved.txt", to: "copy.txt" });
        assert.equal(copied.success, true);
        assert.equal(await fs.readFile(path.join(root, "copy.txt"), "utf8"), "content");

        const escape = await copyPath(root, { from: "copy.txt", to: "../outside.txt" });
        assert.equal(escape.success, false);

        const conflict = await movePath(root, { from: "copy.txt", to: "nested/moved.txt" });
        assert.equal(conflict.success, false);
        assert.equal(conflict.error, "destination already exists");
    });
});

test("grep_files supports context lines, files_only, and binary skipping", async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, "a.js"), "line one\nconst target = 1;\nline three\n", "utf8");
        await fs.writeFile(path.join(root, "b.js"), "const target = 2;\n", "utf8");
        await fs.writeFile(path.join(root, "c.md"), "const target = 3;\n", "utf8");
        await fs.writeFile(path.join(root, "binary.bin"), "const target\u0000binary", "utf8");

        const content = await grepFiles(root, { pattern: "const target", include: "*.js" });
        assert.equal(content.success, true);
        assert.equal(content.totalCount, 2);
        assert.ok(!content.matches.some(m => m.path.includes("binary")));

        const withContext = await grepFiles(root, { pattern: "const target = 1", context: 1 });
        assert.deepEqual(withContext.matches[0].before, [{ line: 1, content: "line one" }]);
        assert.deepEqual(withContext.matches[0].after, [{ line: 3, content: "line three" }]);

        const filesOnly = await grepFiles(root, { pattern: "const target", output_mode: "files_only" });
        assert.deepEqual(filesOnly.matches.map(m => m.path).sort(), ["a.js", "b.js", "c.md"]);

        const excluded = await grepFiles(root, { pattern: "const target", exclude: "*.md" });
        assert.ok(!excluded.matches.some(m => m.path === "c.md"));

        const caseSensitive = await grepFiles(root, { pattern: "CONST TARGET", case_sensitive: true });
        assert.equal(caseSensitive.totalCount, 0);
    });
});

test("read_file_range works without explicit line numbers and pages forward", async () => {
    await withWorkspace(async root => {
        const content = Array.from({ length: 5 }, (_, index) => `line-${index + 1}`).join("\n");
        await fs.writeFile(path.join(root, "long.txt"), content, "utf8");

        const openEnded = await readFileRange(root, { path: "long.txt" });
        assert.equal(openEnded.success, true);
        assert.equal(openEnded.returnedLines, 5);
        assert.equal(openEnded.totalLines, 5);
        assert.equal(openEnded.hasMore, false);

        const paged = await readFileRange(root, { path: "long.txt", start_line: 3 });
        assert.equal(paged.content, "line-3\nline-4\nline-5");
        assert.equal(paged.actualStartLine, 3);
        assert.equal(paged.hasMore, false);

        const noEnd = await readFileRange(root, { path: "long.txt", start_line: 2 });
        assert.equal(noEnd.content, "line-2\nline-3\nline-4\nline-5");
    });
});

test("file changes return line-oriented display diffs", async () => {
    assert.deepEqual(buildLineDiff("same\nold\ntail", "same\nnew\ntail"), {
        removedLines: 1,
        addedLines: 1,
        lines: [
            { type: "delete", text: "old" },
            { type: "add", text: "new" }
        ]
    });
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, "sample.txt"), "old", "utf8");
        const result = await writeFile(root, { path: "sample.txt", content: "new" });
        assert.deepEqual(result.displayDiff.lines, [
            { type: "delete", text: "old" },
            { type: "add", text: "new" }
        ]);
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

test("workspace scan finds text instructions, skips generated directories, and limits the preview", async () => {
    await withWorkspace(async root => {
        await fs.mkdir(path.join(root, "src"), { recursive: true });
        await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
        await fs.mkdir(path.join(root, "dist"), { recursive: true });
        for (let index = 0; index < 7; index += 1) {
            await fs.writeFile(path.join(root, "src", `file-${index}.md`), "instruction", "utf8");
        }
        await fs.writeFile(path.join(root, "node_modules", "pkg", "ignored.md"), "ignored", "utf8");
        await fs.writeFile(path.join(root, "dist", "ignored.txt"), "ignored", "utf8");
        await fs.writeFile(path.join(root, "src", "ignored.js"), "ignored", "utf8");

        const result = await scanWorkspaceTextFiles(root);
        assert.equal(result.totalCount, 7);
        assert.equal(result.preview.length, 5);
        assert.ok(result.preview.every(filePath => filePath.startsWith("src/")));
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

test("run_shell preserves Chinese output as UTF-8", { skip: process.platform !== "win32" }, async () => {
    await withWorkspace(async root => {
        const runner = new AgentShellRunner();
        const result = await runner.run({
            executionId: "test-shell-utf8",
            command: "Write-Output '中文命令输出'",
            cwd: root,
            timeoutMs: 10000
        });
        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, /中文命令输出/);
        assert.doesNotMatch(result.stdout, /�/);
    });
});

test("background processes can be started, read, and stopped", async () => {
    await withWorkspace(async root => {
        const manager = new AgentBackgroundShellManager();
        try {
            const started = manager.start({
                command: process.platform === "win32"
                    ? "Write-Output 'bg-ready'; Start-Sleep -Seconds 30"
                    : "printf 'bg-ready'; sleep 30",
                processId: "test-bg",
                cwd: root
            });
            assert.equal(started.success, true);
            assert.equal(started.processId, "test-bg");

            // Duplicate ids must be rejected rather than silently replacing a live process.
            assert.equal(manager.start({ command: "echo x", processId: "test-bg", cwd: root }).success, false);

            const listed = manager.list();
            assert.equal(listed.processes.length, 1);
            assert.equal(listed.processes[0].running, true);
            assert.deepEqual(manager.read("missing-id"), { success: false, error: "unknown process id: missing-id" });

            const stopped = await manager.stopAndWait("test-bg");
            assert.equal(stopped.running, false);
            assert.equal(stopped.stopped, true);
            assert.equal(manager.list().processes.length, 0);
        } finally {
            await manager.stopAllAndWait();
        }
    });
});

test("background process output is captured and tails are honoured", async () => {
    await withWorkspace(async root => {
        const manager = new AgentBackgroundShellManager();
        try {
            manager.start({
                command: process.platform === "win32"
                    ? "Write-Output 'first-line'; Write-Output 'second-line'; Start-Sleep -Seconds 30"
                    : "printf 'first-line\nsecond-line\n'; sleep 30",
                processId: "test-bg-output",
                cwd: root
            });
            // Give the shell a moment to flush its first writes.
            await new Promise(resolve => setTimeout(resolve, 1500));
            const full = manager.read("test-bg-output");
            assert.equal(full.success, true);
            assert.match(full.stdout, /first-line/);
            assert.match(full.stdout, /second-line/);
            assert.ok(full.stdoutBytes > 0);

            const tailed = manager.read("test-bg-output", { tail_bytes: 5 });
            assert.equal(tailed.stdout, full.stdout.slice(-5));
        } finally {
            await manager.stopAllAndWait();
        }
    });
});

test("apply_patch adds, updates, and deletes files from one envelope", async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, "existing.txt"), "alpha\nbeta\ngamma\n", "utf8");
        await fs.writeFile(path.join(root, "doomed.txt"), "remove me\n", "utf8");
        const patch = [
            "*** Begin Patch",
            "*** Add File: created.txt",
            "+first line",
            "+second line",
            "*** Update File: existing.txt",
            "@@",
            " alpha",
            "-beta",
            "+BETA",
            " gamma",
            "*** Delete File: doomed.txt",
            "*** End Patch"
        ].join("\n");
        const result = await applyPatch(root, { input: patch });
        assert.equal(result.success, true);
        assert.equal(result.operationCount, 3);
        assert.equal(await fs.readFile(path.join(root, "created.txt"), "utf8"), "first line\nsecond line\n");
        assert.equal(await fs.readFile(path.join(root, "existing.txt"), "utf8"), "alpha\nBETA\ngamma\n");
        await assert.rejects(fs.stat(path.join(root, "doomed.txt")));
        assert.ok(result.displayDiff.addedLines > 0);
    });
});

test("apply_patch fails cleanly on ambiguous or missing hunk context", async () => {
    await withWorkspace(async root => {
        await fs.writeFile(path.join(root, "dup.txt"), "same\nsame\n", "utf8");
        const ambiguous = await applyPatch(root, {
            input: "*** Begin Patch\n*** Update File: dup.txt\n@@\n-same\n+changed\n*** End Patch"
        });
        assert.equal(ambiguous.success, false);
        assert.match(ambiguous.error, /ambiguous/);
        // The failed patch must not have modified the file.
        assert.equal(await fs.readFile(path.join(root, "dup.txt"), "utf8"), "same\nsame\n");

        const missing = await applyPatch(root, {
            input: "*** Begin Patch\n*** Update File: dup.txt\n@@\n-not present\n+x\n*** End Patch"
        });
        assert.equal(missing.success, false);
        assert.match(missing.error, /not found/);
    });
});

test("apply_patch rejects malformed envelopes and out-of-workspace paths", async () => {
    await withWorkspace(async root => {
        const empty = await applyPatch(root, { input: "*** Begin Patch\n*** End Patch" });
        assert.equal(empty.success, false);
        assert.match(empty.error, /no file sections/);

        const orphan = await applyPatch(root, { input: "*** Begin Patch\nstray text\n*** End Patch" });
        assert.equal(orphan.success, false);
        assert.match(orphan.error, /unexpected content/);

        const escapePatch = await applyPatch(root, {
            input: "*** Begin Patch\n*** Add File: ../escaped.txt\n+bad\n*** End Patch"
        });
        assert.equal(escapePatch.success, false);
    });
});
