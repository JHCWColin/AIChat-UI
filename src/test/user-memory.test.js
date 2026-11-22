const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDiskMemoryStore } = require('../main/user-memory-store');

function operation(action, fields) {
    return { name: 'manage_memory', arguments: { action, ...fields } };
}

async function temporaryProfile(context) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'aiui-memory-test-'));
    context.after(async () => {
        await fs.rm(path.join(profile, 'user-memory.json'), { force: true });
        await fs.rm(path.join(profile, 'user-memory.json.tmp'), { force: true });
        await fs.rmdir(profile);
    });
    return profile;
}

test('adding a memory preserves the first request prefix across app restarts', async context => {
    const profile = await temporaryProfile(context);
    const chat = { id: 'existing' };
    const draft = { id: 'draft' };
    const store = createDiskMemoryStore(profile);
    assert.equal(store.isEnabled(), true);
    const initial = store.getContext(chat);
    assert.equal(store.getContext(draft, { estimateOnly: true }), initial);
    assert.equal(store.applyCalls([operation('add', { text: '偏好中文答复' })])[0].result.ok, true);
    const reopened = createDiskMemoryStore(profile);
    assert.equal(reopened.getContext(chat), initial);
    assert.match(reopened.getContext(draft), /偏好中文答复/);
    assert.deepEqual(reopened.getTool(), store.getTool());
});

test('updates and deletions apply to prior snapshots and disabling blocks tool writes', async context => {
    const profile = await temporaryProfile(context);
    const store = createDiskMemoryStore(profile);
    const [add] = store.applyCalls([operation('add', { text: '使用浅色主题' })]);
    const chat = { id: 'after-add' };
    assert.match(store.getContext(chat), /使用浅色主题/);
    const [duplicate] = store.applyCalls([operation('add', { text: '  使用浅色主题  ' })]);
    assert.equal(duplicate.result.id, add.result.id);
    assert.equal(duplicate.result.unchanged, true);
    store.applyCalls([operation('update', { id: add.result.id, text: '使用深色主题' })]);
    assert.doesNotMatch(store.getContext(chat), /使用浅色主题/);
    assert.match(store.getContext(chat), /使用深色主题/);
    store.setEnabled(false);
    assert.equal(store.getContext(chat), '');
    assert.equal(store.applyCalls([operation('add', { text: '不能写入' })])[0].result.ok, false);
    assert.deepEqual(store.list(), [{ id: add.result.id, text: '使用深色主题' }]);
    assert.equal(store.deleteRecord(add.result.id).ok, true);
    store.setEnabled(true);
    assert.doesNotMatch(store.getContext(chat), /使用深色主题|不能写入/);
    assert.deepEqual(store.list(), []);
});

test('activity counts only successful changes and retains no record data', async context => {
    const profile = await temporaryProfile(context);
    const store = createDiskMemoryStore(profile);
    const results = store.applyCalls([
        operation('add', { text: '偏好纯文本' }),
        operation('add', { text: '偏好纯文本' }),
        operation('update', { previous_text: '偏好纯文本', text: '偏好 Markdown' }),
        operation('delete', { previous_text: '偏好 Markdown' }),
        operation('delete', { previous_text: '已不存在' })
    ]);
    assert.deepEqual(store.summarizeResults(results), { created: 1, updated: 1, deleted: 1 });
    assert.equal(store.summarizeResults([results[1], results[4]]), null);
    assert.deepEqual(store.normalizeActivity({ created: 2, updated: '3', deleted: 0, text: '私密信息' }), { created: 2 });
});
