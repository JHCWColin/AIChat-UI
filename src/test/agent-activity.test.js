const test = require('node:test');
const assert = require('node:assert/strict');
const Activity = require('../renderer/agent-activity.js');

const ok = extra => ({ success: true, ...extra });

test('counts reads, commands, web calls and file writes separately', () => {
    const chat = {};
    Activity.applyToolActivity(chat, 'read_file_range', { result: ok() });
    Activity.applyToolActivity(chat, 'read_file_range', { result: ok() });
    Activity.applyToolActivity(chat, 'view_image', { result: ok() });
    Activity.applyToolActivity(chat, 'run_shell', { result: ok({ exitCode: 1 }) });
    Activity.applyToolActivity(chat, 'start_process', { result: ok() });
    Activity.applyToolActivity(chat, 'list_dir', { result: ok() });
    Activity.applyToolActivity(chat, 'glob_files', { result: ok() });
    Activity.applyToolActivity(chat, 'grep_files', { result: ok() });
    Activity.applyToolActivity(chat, 'web_search', { result: ok() });
    Activity.applyToolActivity(chat, 'browse_web', { result: ok() });
    Activity.applyToolActivity(chat, 'write_file', { result: ok(), displayDiff: { addedLines: 103, removedLines: 0 } });
    assert.deepEqual(chat.agentActivity, { files: 6, commands: 2, web: 2, writes: 1, added: 103, removed: 0 });
    // Reading the same file again is counted again.
    Activity.applyToolActivity(chat, 'read_file_range', { result: ok() });
    assert.equal(chat.agentActivity.files, 7);
});

test('edit diffs accumulate into added and removed totals', () => {
    const chat = {};
    Activity.applyToolActivity(chat, 'edit_file', { result: ok(), displayDiff: { addedLines: 8, removedLines: 5 } });
    Activity.applyToolActivity(chat, 'multi_edit_file', { result: ok({ displayDiff: { addedLines: 2, removedLines: 9 } }) });
    assert.equal(chat.agentActivity.added, 10);
    assert.equal(chat.agentActivity.removed, 14);
    assert.equal(chat.agentActivity.writes, 2);
});

test('failed, rejected and cancelled calls are ignored', () => {
    const chat = {};
    Activity.applyToolActivity(chat, 'read_file_range', { result: { success: false, error: 'nope' } });
    Activity.applyToolActivity(chat, 'run_shell', { result: { success: true, rejected: true } });
    Activity.applyToolActivity(chat, 'web_search', { result: { success: true, cancelled: true } });
    Activity.applyToolActivity(chat, 'write_file', { result: null });
    assert.equal(chat.agentActivity, undefined);
});

test('unrelated tools and non-agent chats are left untouched', () => {
    const chat = {};
    Activity.applyToolActivity(chat, 'update_plan', { result: ok() });
    Activity.applyToolActivity(chat, 'finish_task', { result: ok() });
    assert.equal(chat.agentActivity, undefined);
    assert.equal(Activity.applyToolActivity(null, 'read_file_range', { result: ok() }), null);
});

test('normalize clamps hostile archive values', () => {
    const stats = Activity.normalize({ files: '12', commands: -3, web: 0, writes: 2.9, added: '1e3', removed: NaN, junk: 5 });
    assert.deepEqual(stats, { files: 12, commands: 0, web: 0, writes: 2, added: 1000, removed: 0 });
    assert.equal(Activity.isEmpty(stats), false);
    assert.equal(Activity.isEmpty({}), true);
    assert.deepEqual(Activity.normalize(null), { files: 0, commands: 0, web: 0, writes: 0, added: 0, removed: 0 });
});
