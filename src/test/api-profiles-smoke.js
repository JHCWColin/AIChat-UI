'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const userData = path.join(os.tmpdir(), `aiui-api-profiles-${process.pid}`);
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
require('../main/main');
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
const voiceFields = {
    profile: 'voice-fish-profile-select', profileName: 'voice-fish-profile-name',
    endpoint: 'voice-fish-endpoint-select', apiBase: 'voice-fish-base-input', apiKey: 'voice-fish-key-input',
    model: 'voice-fish-model-select', voiceName: 'voice-fish-name-input', voiceId: 'voice-fish-id-input'
};
const voiceForm = `Object.fromEntries(Object.entries(${JSON.stringify(voiceFields)})
    .map(([field,id]) => [field,document.getElementById(id).value]))`;
const voiceSnapshot = `(() => {
    const {fishApiEndpoint,fishApiBase,fishApiKey,fishModel,fishVoiceName,fishVoiceId} = getVoiceChatSettingsSnapshot();
    return {endpoint:fishApiEndpoint,apiBase:fishApiBase,apiKey:fishApiKey,model:fishModel,voiceName:fishVoiceName,voiceId:fishVoiceId};
})()`;
function voiceValueMismatches(win, source, expected) {
    return evaluate(win, `(() => {
        const actual = ${source};
        return Object.entries(${JSON.stringify(expected)}).filter(([field,value]) => actual[field] !== value).map(([field]) => field);
    })()`);
}
async function assertVoiceValues(win, source, expected, description) {
    assert.deepEqual(await voiceValueMismatches(win, source, expected), [], description);
}
async function assertVoiceRuntime(main, prefs, expected, description) {
    await assertVoiceValues(prefs, 'getSavedFishAudioSettings()', expected, description);
    await until(async () => (await voiceValueMismatches(main, voiceSnapshot, expected)).length === 0, description);
}
function editVoiceValues(win, edits) {
    return evaluate(win, `(() => {
        const fields = ${JSON.stringify(voiceFields)};
        for (const [field,value] of Object.entries(${JSON.stringify(edits)})) {
            const input = document.getElementById(fields[field]);
            input.value = value;
            input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles:true }));
        }
    })()`);
}
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

        const legacyVoice = { endpoint:'international', apiBase:'https://legacy-voice.example', apiKey:'test-legacy-international',
            model:'drama-3', voiceName:'旧音色', voiceId:'test-legacy-voice' };
        const domestic = { endpoint:'domestic', apiBase:'https://domestic-voice.example', apiKey:'test-domestic-profile-one',
            model:'s2.1-pro-flash', voiceName:'国内音色', voiceId:'test-domestic-voice' };
        const international = { endpoint:'international', apiBase:'https://international-voice.example', apiKey:'test-international-profile-one',
            model:'s2.1-pro', voiceName:'国际音色', voiceId:'test-international-voice' };
        const oldVoiceStorage = {
            voice_fish_endpoint:legacyVoice.endpoint, voice_fish_base:legacyVoice.apiBase,
            voice_fish_key:'test-legacy-domestic', voice_fish_international_key:legacyVoice.apiKey,
            voice_fish_model:legacyVoice.model, voice_fish_name:legacyVoice.voiceName, voice_fish_id:legacyVoice.voiceId
        };
        await evaluate(main,`localStorage.removeItem('voice_fish_profiles');
            Object.entries(${JSON.stringify(oldVoiceStorage)}).forEach(([key,value]) => localStorage.setItem(key,value));`);
        const showVoice = `document.querySelector('[data-section="voice-chat"]').click()`;
        await evaluate(prefs,showVoice);
        await assertVoiceValues(prefs,voiceForm,{...legacyVoice,profile:'default'},'legacy settings appear in the default voice profile');
        await editVoiceValues(prefs,{endpoint:'domestic'});
        await assertVoiceValues(prefs,voiceForm,{endpoint:'domestic',apiBase:'https://fishaudio.org',apiKey:oldVoiceStorage.voice_fish_key},'legacy domestic credentials belong to the domestic endpoint');
        await editVoiceValues(prefs,{endpoint:'international'});
        await assertVoiceRuntime(main,prefs,legacyVoice,'the active voice configuration feeds the main window snapshot');

        const createVoice = "document.getElementById('voice-fish-profile-create').click()";
        const selectedVoice = "document.getElementById('voice-fish-profile-select').value";
        await evaluate(prefs,createVoice);
        const firstProfile = await evaluate(prefs,selectedVoice);
        assert.ok(firstProfile && firstProfile !== 'default');
        await assertVoiceValues(prefs,voiceForm,{endpoint:'international',apiKey:''},'a new profile inherits the endpoint with an empty key');
        await editVoiceValues(prefs,{...international,profileName:'双端点测试'});
        await assertVoiceRuntime(main,prefs,international,'editing the international profile is saved immediately');
        await editVoiceValues(prefs,{endpoint:'domestic'});
        await assertVoiceValues(prefs,voiceForm,{endpoint:'domestic',apiKey:''},'domestic credentials are separate within the profile');
        await editVoiceValues(prefs,domestic);
        await assertVoiceRuntime(main,prefs,domestic,'editing the domestic profile is saved immediately');
        await editVoiceValues(prefs,{endpoint:'international'});
        await evaluate(prefs,`document.querySelector('[data-section="other"]').click(); ${showVoice}`);
        await assertVoiceValues(prefs,voiceForm,{...international,profile:firstProfile,profileName:'双端点测试'},'returning to voice preferences restores the selected endpoint and fields');

        await evaluate(prefs,createVoice);
        const secondProfile = await evaluate(prefs,selectedVoice);
        assert.ok(secondProfile && !['default',firstProfile].includes(secondProfile));
        await assertVoiceValues(prefs,voiceForm,{endpoint:'international',apiKey:''},'the second profile cannot inherit another profile’s key');
        const secondVoice = { endpoint:'international', apiKey:'test-international-profile-two' };
        await editVoiceValues(prefs,{...secondVoice,profileName:'国际单独配置'});
        await editVoiceValues(prefs,{profile:firstProfile});
        await assertVoiceValues(prefs,voiceForm,international,'switching profiles retains the first international configuration');
        await editVoiceValues(prefs,{profile:secondProfile});
        await assertVoiceRuntime(main,prefs,secondVoice,'switching profiles applies in the main window without an extra save');

        void prefs.webContents.executeJavaScript('void window.electronAPI.closePreferences(); true',true).catch(() => {});
        await until(() => prefs.isDestroyed(), 'preferences closed');
        await evaluate(main,'toggleSettings()');
        const reopened = await until(() => BrowserWindow.getAllWindows().find(win => /preferences=1/.test(win.webContents.getURL())), 'preferences reopened');
        await until(() => evaluate(reopened,"Boolean(document.getElementById('input-max-lines') && document.getElementById('settings-modal').classList.contains('modal-active'))"), 'reopened preferences ready');
        await evaluate(reopened,showVoice);
        await assertVoiceValues(reopened,voiceForm,{...secondVoice,profile:secondProfile,profileName:'国际单独配置'},'closing and reopening preferences keeps the active voice profile');
        await editVoiceValues(reopened,{apiKey:''});
        await editVoiceValues(reopened,{profile:firstProfile,endpoint:'domestic'});
        await assertVoiceValues(reopened,voiceForm,domestic,'the other endpoint’s settings survive edits in a different profile');
        await editVoiceValues(reopened,{profile:secondProfile});
        await assertVoiceValues(reopened,voiceForm,{...secondVoice,apiKey:''},'clearing a key is saved instead of restoring a fallback');
        await evaluate(reopened,"window.confirm=()=>true; document.getElementById('voice-fish-profile-delete').click()");
        await assertVoiceValues(reopened,voiceForm,{...legacyVoice,profile:'default'},'deleting the selected voice profile restores the original default');
        await evaluate(reopened,`document.querySelector('[data-section="api"]').click()`);
        assert.deepEqual(await evaluate(reopened,state),fixtures.default);

        console.log(JSON.stringify({ passed: true, screenshot: path.join(userData, 'api-profiles.png') }));
        app.exit(0);
    } catch (error) { console.error(error.stack || error); app.exit(1); }
});
