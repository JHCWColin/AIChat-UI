const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { canonicalizeToolCall } = require('../tool-call-normalizer');
const { readFileRange, grepFiles } = require('../agent-tools');

async function workspace(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-tool-arguments-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

test('normalized open-ended reads continue from the requested line and retain backend validation', async t => {
    const root = await workspace(t);
    await fs.writeFile(path.join(root, 'lines.txt'), Array.from({ length: 2300 }, (_, i) => `line ${i + 1}`).join('\n'));
    const normalize = args => canonicalizeToolCall({ name: 'read_file_range', arguments: args }).arguments;
    const result = await readFileRange(root, normalize({ path: 'lines.txt', start_line: 301 }));
    assert.equal(result.actualStartLine, 301);
    assert.equal(result.content.split('\n')[0], 'line 301');
    const invalid = await readFileRange(root, normalize({ path: 'lines.txt', start_line: 0 }));
    assert.equal(invalid.success, false);
    const alias = canonicalizeToolCall({ name: 'read_file', arguments: { file_path: 'lines.txt', start_line: 500, end_line: 501, offset: 1 } });
    const aliased = await readFileRange(root, alias.arguments);
    assert.equal(aliased.content, 'line 500\nline 501');
});

test('normalized grep honors case, exclusion, surrounding lines and file-only output', async t => {
    const root = await workspace(t);
    await fs.writeFile(path.join(root, 'keep.txt'), 'before\nNeedle\nafter\nneedle\n');
    await fs.writeFile(path.join(root, 'skip.txt'), 'Needle\n');
    const normalize = args => canonicalizeToolCall({ name: 'grep_files', arguments: args }).arguments;
    const args = { pattern: 'Needle', include: '*.txt', exclude: 'skip.txt', case_sensitive: true, context: 1 };
    const result = await grepFiles(root, normalize(args));
    assert.equal(result.success, true);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].path, 'keep.txt');
    assert.equal(result.matches[0].line, 2);
    assert.deepEqual(result.matches[0].before, [{ line: 1, content: 'before' }]);
    assert.deepEqual(result.matches[0].after, [{ line: 3, content: 'after' }]);
    const files = await grepFiles(root, normalize({ ...args, output_mode: 'files_only' }));
    assert.deepEqual(files.matches, [{ path: 'keep.txt' }]);
});

test('normalized image calls preserve the explicitly requested image detail', () => {
    for (const name of ['view_image', 'read_image', 'functions.view_image']) {
        const call = canonicalizeToolCall({ name, arguments: { path: 'photo.png', detail: 'original' } });
        assert.equal(call.name, 'view_image');
        assert.equal(call.arguments.detail, 'original');
    }
});
