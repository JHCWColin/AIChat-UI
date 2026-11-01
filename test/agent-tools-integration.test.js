const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
    writeFile, readFileRange, editFile, multiEditFile, applyPatch,
    globFiles, grepFiles, listDir, copyPath, movePath, deletePath, viewImage,
    AgentShellRunner, AgentBackgroundShellManager
} = require("../agent-tools");

async function sandbox(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiui-agent-integration-"));
    const root = path.join(directory, "中文 空格 工作区");
    const outside = path.join(directory, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return { root, outside };
}
function ok(result) { assert.equal(result.success, true, JSON.stringify(result)); return result; }
function command(script, args = []) {
    const quote = value => "'" + String(value).replace(/'/g, process.platform === "win32" ? "''" : "'\\''") + "'";
    return (process.platform === "win32" ? "& " : "") + [process.execPath, script, ...args].map(quote).join(" ");
}
async function waitFor(read, check, timeoutMs = 8000) {
    const until = Date.now() + timeoutMs;
    let result;
    while (Date.now() < until) {
        result = await read();
        if (check(result)) return result;
        await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.fail("timed out waiting for process state: " + JSON.stringify(result));
}

test("Agent file workflow creates, discovers, refactors, runs and archives a Unicode project", async t => {
    const { root } = await sandbox(t);
    ok(await writeFile(root, { path: "src/计算 模块.cjs", content: "exports.label = '初始🙂';\r\nexports.sum = (a, b) => a + b;\r\n" }));
    ok(await writeFile(root, { path: "verify.cjs", content: "const assert = require('node:assert/strict'); const app = require('./src/计算 模块.cjs'); assert.equal(app.sum(4, 5), 9); assert.equal(app.label, '完成🙂'); console.log(JSON.stringify({cwd:process.cwd(),label:app.label}));" }));
    const found = ok(await globFiles(root, { pattern: "**/*.cjs" }));
    assert.deepEqual(found.matches.map(item => item.path).sort(), ["src/计算 模块.cjs", "verify.cjs"]);
    const listing = ok(await listDir(root, { depth: 2, limit: 2 }));
    assert.equal(listing.hasMore, true);
    const source = ok(await readFileRange(root, { path: "src/计算 模块.cjs" }));
    assert.equal(source.totalLines, 2);
    assert.match(source.content, /初始🙂/);
    ok(await editFile(root, { path: "src/计算 模块.cjs", old_text: "初始🙂", new_text: "中间🙂" }));
    ok(await multiEditFile(root, { path: "src/计算 模块.cjs", edits: [
        { old_text: "中间🙂", new_text: "完成🙂" },
        { old_text: "a + b", new_text: "Number(a) + Number(b)" }
    ] }));
    const search = ok(await grepFiles(root, { pattern: "Number\\(a\\)", include: "**/*.cjs", context: 1 }));
    assert.equal(search.matches.length, 1);
    assert.equal(search.matches[0].line, 2);
    const runner = new AgentShellRunner();
    const executed = await runner.run({ executionId: "project-check", command: command("verify.cjs"), cwd: root, timeoutMs: 10000 });
    assert.equal(executed.exitCode, 0, executed.stderr);
    const output = JSON.parse(executed.stdout.trim());
    assert.equal(await fs.realpath(output.cwd), await fs.realpath(root));
    assert.equal(output.label, "完成🙂");
    ok(await copyPath(root, { from: "src", to: "archive/src" }));
    ok(await movePath(root, { from: "archive/src/计算 模块.cjs", to: "archive/备份.cjs" }));
    assert.deepEqual(await fs.readFile(path.join(root, "archive/备份.cjs")), await fs.readFile(path.join(root, "src/计算 模块.cjs")));
    ok(await deletePath(root, { path: "archive", recursive: true }));
    await assert.rejects(fs.stat(path.join(root, "archive")), { code: "ENOENT" });
    assert.equal(runner.running.size, 0);
});

test("literal edit replacements preserve JavaScript dollar syntax and neighboring text", async t => {
    const { root } = await sandbox(t);
    const replacement = "literal $& $$ $` $' $1";
    ok(await writeFile(root, { path: "literal.txt", content: "HEAD original TAIL" }));
    ok(await editFile(root, { path: "literal.txt", old_text: "original", new_text: replacement }));
    assert.equal(await fs.readFile(path.join(root, "literal.txt"), "utf8"), `HEAD ${replacement} TAIL`);
    ok(await writeFile(root, { path: "batch.txt", content: "HEAD first SECOND TAIL" }));
    ok(await multiEditFile(root, { path: "batch.txt", edits: [
        { old_text: "first", new_text: replacement },
        { old_text: "SECOND", new_text: "$&$`$'$$" }
    ] }));
    assert.equal(await fs.readFile(path.join(root, "batch.txt"), "utf8"), `HEAD ${replacement} $&$\`$'$$ TAIL`);
});

test("a later invalid patch section leaves earlier files untouched", async t => {
    const { root } = await sandbox(t);
    ok(await writeFile(root, { path: "existing.txt", content: "original\n" }));
    const result = await applyPatch(root, { input: [
        "*** Begin Patch", "*** Add File: new.txt", "+must not remain", "*** Update File: existing.txt", "@@", "-missing context", "+changed", "*** End Patch"
    ].join("\n") });
    assert.equal(result.success, false);
    assert.equal(result.appliedCount, 0);
    await assert.rejects(fs.stat(path.join(root, "new.txt")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(root, "existing.txt"), "utf8"), "original\n");
});

test("file tools reject junction escape and recursive discovery never follows it", async t => {
    const { root, outside } = await sandbox(t);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret sentinel", "utf8");
    await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    for (const result of await Promise.all([
        readFileRange(root, { path: "linked/secret.txt" }), writeFile(root, { path: "linked/new.txt", content: "no" }),
        editFile(root, { path: "linked/secret.txt", old_text: "secret", new_text: "changed" }),
        deletePath(root, { path: "linked/secret.txt" }), copyPath(root, { from: "linked/secret.txt", to: "copy.txt" }),
        movePath(root, { from: "linked/secret.txt", to: "moved.txt" })
    ])) { assert.equal(result.success, false); assert.match(result.error, /link|workspace/); }
    assert.deepEqual(ok(await globFiles(root, { pattern: "**/*.txt" })).matches, []);
    assert.deepEqual(ok(await grepFiles(root, { pattern: "secret" })).matches, []);
    assert.deepEqual(ok(await listDir(root, { depth: 10 })).entries, []);
    assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "secret sentinel");
    await assert.rejects(fs.stat(path.join(outside, "new.txt")), { code: "ENOENT" });
});

test("image inspection and binary copy retain real bytes while search skips binary data", async t => {
    const { root } = await sandbox(t);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64");
    await fs.writeFile(path.join(root, "像素 图片.png"), png);
    const image = ok(await viewImage(root, { path: "像素 图片.png" }));
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.fileSize, png.length);
    assert.deepEqual(Buffer.from(image.dataUrl.split(",")[1], "base64"), png);
    const binary = Buffer.concat([Buffer.from([0, 255, 254, 128]), Buffer.from("NEVER_INCLUDE_ME")]);
    await fs.writeFile(path.join(root, "sample.bin"), binary);
    ok(await copyPath(root, { from: "sample.bin", to: "备份 二进制.bin" }));
    assert.deepEqual(await fs.readFile(path.join(root, "备份 二进制.bin")), binary);
    assert.equal((await viewImage(root, { path: "sample.bin" })).success, false);
    assert.equal(ok(await grepFiles(root, { pattern: "NEVER_INCLUDE_ME" })).matches.length, 0);
    const largeImage = await fs.open(path.join(root, "large.png"), "w");
    await largeImage.truncate(8 * 1024 * 1024 + 1);
    await largeImage.close();
    const large = ok(await viewImage(root, { path: "large.png" }));
    assert.equal(large.dataUrl, "");
    assert.match(large.note, /exceeds/);
});

test("shell captures nonzero exit, stderr, exact Unicode arguments and progress", async t => {
    const { root } = await sandbox(t);
    ok(await writeFile(root, { path: "参数 程序.cjs", content: "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})); console.error('错误🙂'); process.exitCode=7;" }));
    const progress = [];
    const runner = new AgentShellRunner();
    const result = await runner.run({ executionId: "unicode-args", command: command("参数 程序.cjs", ["中文 空格", "单'引号", "$&literal"]), cwd: root, timeoutMs: 10000, onProgress: state => progress.push(state) });
    assert.equal(result.exitCode, 7);
    assert.deepEqual(JSON.parse(result.stdout.trim()).args, ["中文 空格", "单'引号", "$&literal"]);
    assert.match(result.stderr, /错误🙂/);
    assert(progress.length > 0);
    assert.equal(progress[0].executionId, "unicode-args");
    assert.equal(result.timedOut, false);
    assert.equal(runner.running.size, 0);
    // A later successful command must retain ordinary shell sequencing behavior.
    const thenSuccessful = await runner.run({ executionId: "failure-then-success", command: command("参数 程序.cjs") + (process.platform === "win32" ? "; Write-Output 'recovered'" : "; printf recovered"), cwd: root, timeoutMs: 10000 });
    assert.equal(thenSuccessful.exitCode, 0);
    assert.match(thenSuccessful.stdout, /recovered/);
});

test("foreground cancellation and timeout reap a real process before a late write", async t => {
    const { root } = await sandbox(t);
    ok(await writeFile(root, { path: "long.cjs", content: "console.log('ready'); setTimeout(()=>require('fs').writeFileSync('late.txt','unexpected'),2000); setInterval(()=>{},1000);" }));
    for (const mode of ["cancel", "timeout"]) {
        const runner = new AgentShellRunner();
        let ready;
        const started = new Promise(resolve => { ready = resolve; });
        const pending = runner.run({ executionId: mode, command: command("long.cjs"), cwd: root, timeoutMs: mode === "timeout" ? 1200 : 10000, onProgress: () => ready() });
        if (mode === "cancel") { await started; assert.equal(runner.cancel(mode), true); }
        const result = await pending;
        assert.equal(result.cancelled, mode === "cancel");
        assert.equal(result.timedOut, mode === "timeout");
        assert.equal(runner.running.size, 0);
    }
    await new Promise(resolve => setTimeout(resolve, 2200));
    await assert.rejects(fs.stat(path.join(root, "late.txt")), { code: "ENOENT" });
});

test("background task naturally exits, exposes final output and reports invalid cwd", async t => {
    const { root } = await sandbox(t);
    ok(await writeFile(root, { path: "background.cjs", content: "console.log('后台 中文🙂'); console.error('诊断'); process.exitCode=3;" }));
    const manager = new AgentBackgroundShellManager();
    t.after(() => manager.stopAllAndWait());
    ok(manager.start({ processId: "natural", command: command("background.cjs"), cwd: root }));
    const ended = await waitFor(() => manager.read("natural"), state => !state.running);
    assert.equal(ended.exitCode, 3);
    assert.match(ended.stdout, /后台 中文🙂/);
    assert.match(ended.stderr, /诊断/);
    ok(await manager.stopAndWait("natural"));
    ok(manager.start({ processId: "bad-cwd", command: "echo harmless", cwd: path.join(root, "missing") }));
    const invalid = await waitFor(() => manager.read("bad-cwd"), state => !state.running);
    assert.notEqual(invalid.exitCode, 0);
    assert.equal(manager.list().processes.find(state => state.processId === "bad-cwd").running, false);
});

test("one patch can add and then update a file, while directory copies skip external links", async t => {
    const { root, outside } = await sandbox(t);
    const applied = ok(await applyPatch(root, { input: [
        "*** Begin Patch", "*** Add File: project/配置.txt", "+first", "+old", "*** Update File: project/配置.txt", "@@", " first", "-old", "+new", "*** Add File: project/notes.txt", "+temporary", "*** Delete File: project/notes.txt", "*** End Patch"
    ].join("\n") }));
    assert.equal(applied.operationCount, 4);
    assert.equal(await fs.readFile(path.join(root, "project/配置.txt"), "utf8"), "first\nnew\n");
    await assert.rejects(fs.stat(path.join(root, "project/notes.txt")), { code: "ENOENT" });
    await fs.writeFile(path.join(outside, "secret.txt"), "outside");
    await fs.symlink(outside, path.join(root, "project/external"), process.platform === "win32" ? "junction" : "dir");
    ok(await writeFile(root, { path: "project/node_modules/generated.txt", content: "ignored" }));
    ok(await copyPath(root, { from: "project", to: "backup" }));
    assert.equal(await fs.readFile(path.join(root, "backup/配置.txt"), "utf8"), "first\nnew\n");
    await assert.rejects(fs.lstat(path.join(root, "backup/external")), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.join(root, "backup/node_modules")), { code: "ENOENT" });
});

test("output limits retain valid UTF-8 and background tail_bytes measures bytes", async t => {
    const { root } = await sandbox(t);
    ok(await writeFile(root, { path: "output.cjs", content: "process.stdout.write('甲乙丙'); process.stderr.write('🙂🙂');" }));
    const runner = new AgentShellRunner();
    const limited = await runner.run({ executionId: "limited", command: command("output.cjs"), cwd: root, timeoutMs: 10000, maxOutputBytes: 5 });
    assert.equal(limited.exitCode, 0, limited.stderr);
    assert.equal(limited.stdout, "甲");
    assert.equal(limited.stderr, "🙂");
    assert.equal(limited.stdoutTruncated, true);
    assert.equal(limited.stderrTruncated, true);
    assert.equal(limited.stdoutBytes, 9);
    assert.equal(limited.stderrBytes, 8);
    const manager = new AgentBackgroundShellManager();
    t.after(() => manager.stopAllAndWait());
    ok(manager.start({ processId: "tail-unicode", command: command("output.cjs"), cwd: root }));
    await waitFor(() => manager.read("tail-unicode"), state => !state.running);
    const tail = manager.read("tail-unicode", { tail_bytes: 4 });
    assert.equal(tail.stdout, "丙");
    assert.equal(tail.stderr, "🙂");
    assert(Buffer.byteLength(tail.stdout) <= 4);
    assert.doesNotMatch(tail.stdout + tail.stderr, /�/);
});

test("failed patch path validation preserves an earlier planned update and outside sentinel", async t => {
    const { root, outside } = await sandbox(t);
    ok(await writeFile(root, { path: "stable.txt", content: "stable\n" }));
    await fs.writeFile(path.join(outside, "keep.txt"), "outside sentinel");
    const result = await applyPatch(root, { input: [
        "*** Begin Patch", "*** Update File: stable.txt", "@@", "-stable", "+changed", "*** Delete File: ../outside/keep.txt", "*** End Patch"
    ].join("\n") });
    assert.equal(result.success, false);
    assert.equal(result.appliedCount, 0);
    assert.equal(await fs.readFile(path.join(root, "stable.txt"), "utf8"), "stable\n");
    assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "outside sentinel");
});
