'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const userData = path.join(os.tmpdir(), `aiui-api-profiles-${process.pid}`);
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
require('../main');
setTimeout(() => { console.error('API profiles smoke test timeout'); app.exit(1); }, 90000).unref();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (win, source) => win.webContents.executeJavaScript(source, true);
async function until(callback, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const value = await callback();
        if (value) return value;
        await sleep(80);
    }
    throw new Error(`Timed out: ${label}`);
}
const fixtures = {
    default: { api_key: 'test-default', base_url: 'https://default.example/v1', request_endpoint: '/responses',
        max_tokens_limit: '0', model_list: '["default-model"]', selected_model: 'default-model' },
    A: { api_key: 'test-key-a', base_url: 'https://a.example/v1', request_endpoint: '/v1/messages',
        max_tokens_limit: '1234', model_list: '["a-model","a-second"]', selected_model: 'a-second' },
    B: { api_key: 'test-key-b', base_url: 'https://b.example/v1', request_endpoint: '/chat/completions',
        max_tokens_limit: '9876', model_list: '["b-model"]', selected_model: 'b-model' }
};
const state = `(() => ({
    api_key: document.getElementById('api-key-input').value,
    base_url: document.getElementById('base-url-input').value,
    request_endpoint: document.querySelector('input[name="request-endpoint"]:checked')?.value,
    max_tokens_limit: document.getElementById('max-tokens-input').value,
    model_list: JSON.stringify(normalizeModelList(document.getElementById('model-list-input').value)),
    selected_model: document.getElementById('model-select').value
}))()`;
app.whenReady().then(async () => {
    try {
        const main = await until(() => BrowserWindow.getAllWindows().find(win => /index\.html$/.test(win.webContents.getURL())), 'main window');
        await until(() => evaluate(main, "Boolean(document.getElementById('input-max-lines'))"), 'main ready');
        await evaluate(main, `closeSetupGuide(); localStorage.setItem('first_setup_guide_shown', '1');
            applyApiSettings(${JSON.stringify(fixtures.default)});
            localStorage.setItem('api_profiles', JSON.stringify({
                A: { settings: ${JSON.stringify(fixtures.A)}, updatedAt: 123 },
                B: ${JSON.stringify(fixtures.B)}
            })); toggleSettings();`);
        const prefs = await until(() => BrowserWindow.getAllWindows().find(win => /preferences=1/.test(win.webContents.getURL())), 'preferences window');
        await until(() => evaluate(prefs, "Boolean(document.getElementById('input-max-lines') && document.getElementById('settings-modal').classList.contains('modal-active'))"), 'preferences ready');
        await evaluate(prefs, "window.confirm = () => true; switchSettingsSection('api', document.querySelector('[data-section=api]'));");
        const animations = await evaluate(prefs, `['settings-modal'].flatMap(id => [document.getElementById(id), document.getElementById(id).firstElementChild]).map(el => {
            const s = getComputedStyle(el); return [s.opacity, s.transform, s.transitionDuration, s.animationName, s.pointerEvents];
        })`);
        for (const values of animations) assert.deepEqual(values, ['1', 'none', '0s', 'none', 'auto']);
        assert.deepEqual(await evaluate(prefs, state), fixtures.default);
        for (const name of ['A', 'B', 'A']) {
            // Exercise the select's real onchange handler.
            await evaluate(prefs, `document.getElementById('api-profile-select').value = '${name}';
                document.getElementById('api-profile-select').dispatchEvent(new Event('change', { bubbles: true }));`);
            assert.deepEqual(await evaluate(prefs, state), fixtures[name]);
            await until(() => evaluate(main, `document.getElementById('model-select').value === '${fixtures[name].selected_model}' && maxTokensLimit === ${fixtures[name].max_tokens_limit}`), 'main settings synchronized');
        }
        // Dirty edits must neither overwrite the source profile nor escape to another profile.
        await evaluate(prefs, `document.getElementById('api-key-input').value = 'unsaved'; markApiSettingsDirty();
            window.confirm = () => false; switchApiProfile('B');`);
        assert.equal((await evaluate(prefs, state)).api_key, 'unsaved');
        assert.equal(await evaluate(prefs, "document.getElementById('api-profile-select').value"), 'A');
        await evaluate(prefs, "window.confirm = () => true; switchApiProfile('B'); switchApiProfile('A');");
        assert.deepEqual(await evaluate(prefs, state), fixtures.A);
        // Updating includes renaming and reads the visible fields, without a prior settings save.
        await evaluate(prefs, `document.getElementById('api-profile-name').value = 'Renamed A';
            document.getElementById('api-key-input').value = 'edited-a';
            document.getElementById('base-url-input').value = 'https://edited-a.example/v1';
            document.getElementById('max-tokens-input').value = '4567';
            document.querySelector('input[name="request-endpoint"][value="/responses"]').checked = true;
            document.getElementById('model-list-input').value = 'new-a-model';
            markApiSettingsDirty(); document.getElementById('api-profile-save').click();`);
        assert.equal(await evaluate(prefs, "localStorage.getItem('active_api_profile')"), 'Renamed A');
        assert.equal(await evaluate(prefs, "Object.hasOwn(readApiProfiles(), 'A')"), false);
        await evaluate(prefs, "switchApiProfile('B'); switchApiProfile('Renamed A');");
        assert.equal((await evaluate(prefs, state)).api_key, 'edited-a');
        assert.equal((await evaluate(prefs, state)).model_list, '["new-a-model"]');
        assert.deepEqual(await evaluate(prefs, state), {
            api_key: 'edited-a', base_url: 'https://edited-a.example/v1',
            request_endpoint: '/responses', max_tokens_limit: '4567',
            model_list: '["new-a-model"]', selected_model: 'new-a-model'
        });
        // New configuration is a draft until explicitly created; duplicate names cannot overwrite.
        await evaluate(prefs, "createApiProfile();");
        assert.equal(await evaluate(prefs, "document.getElementById('api-profile-save').textContent"), '创建配置');
        assert.equal(await evaluate(prefs, "document.getElementById('api-key-input').value"), '');
        assert.equal(await evaluate(prefs, 'saveSettings(true)'), false);
        await evaluate(prefs, "document.getElementById('api-profile-name').value = 'B';");
        assert.equal(await evaluate(prefs, 'saveSettings(true)'), false);
        assert.deepEqual(await evaluate(prefs, 'readApiProfiles().B.settings'), fixtures.B);
        await evaluate(prefs, `document.getElementById('api-profile-name').value = 'Created C';
            document.getElementById('api-key-input').value = 'test-key-c';
            document.getElementById('base-url-input').value = 'https://c.example/v1';
            document.getElementById('model-list-input').value = 'c-model';
            document.getElementById('api-profile-save').click();`);
        assert.equal(await evaluate(prefs, "localStorage.getItem('active_api_profile')"), 'Created C');
        // Reopening the document must retain the profile and its configuration.
        await new Promise(resolve => {
            prefs.webContents.once('did-finish-load', resolve);
            prefs.webContents.reload();
        });
        await until(() => evaluate(prefs, "Boolean(document.getElementById('input-max-lines') && document.getElementById('settings-modal').classList.contains('modal-active'))"), 'reloaded preferences');
        await evaluate(prefs, "window.confirm = () => true; switchSettingsSection('api', document.querySelector('[data-section=api]'));");
        assert.equal((await evaluate(prefs, state)).api_key, 'test-key-c');
        assert.equal(await evaluate(prefs, "document.getElementById('api-profile-name').value"), 'Created C');
        assert.equal(await evaluate(prefs, "document.getElementById('section-api').classList.contains('active-section')"), true);
        prefs.show(); prefs.focus(); prefs.setSize(1061, 820);
        assert.equal(await evaluate(prefs, "getComputedStyle(document.getElementById('section-api')).display"), 'block');
        await sleep(150);
        await fs.writeFile(path.join(userData, 'api-profiles.png'), (await prefs.webContents.capturePage()).toPNG());
        await evaluate(prefs, "createApiProfile(); cancelApiProfileEdits();");
        assert.equal(await evaluate(prefs, "document.getElementById('api-profile-name').value"), 'Created C');
        await evaluate(prefs, "deleteApiProfile();");
        assert.equal(await evaluate(prefs, "Object.hasOwn(readApiProfiles(), 'Created C')"), false);
        assert.deepEqual(await evaluate(prefs, state), fixtures.default);
        await evaluate(prefs, "switchApiProfile('B'); switchApiProfile('');");
        assert.deepEqual(await evaluate(prefs, state), fixtures.default);
        console.log(JSON.stringify({ passed: true, screenshot: path.join(userData, 'api-profiles.png') }));
        app.exit(0);
    } catch (error) { console.error(error.stack || error); app.exit(1); }
});
