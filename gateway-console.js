(() => {
    'use strict';
    const api = window.gatewayConsoleAPI;
    const $ = id => document.getElementById(id);
    let status = null;
    let busy = false;
    let noticeTimer;
    let deviceSignature = '';
    const setText = (id, value) => { $(id).textContent = value; };
    function updateControlLocks() {
        const locked = busy || !api;
        $('toggle-gateway').disabled = locked;
        ['host', 'port', 'save-network'].forEach(id => { $(id).disabled = locked || Boolean(status?.running); });
        document.querySelectorAll('#allow-write, #rotate-codes, #advanced-form input, #advanced-form button, .device-role, .device-actions button').forEach(control => {
            control.disabled = locked || (control.classList.contains('device-role') && Boolean(control.closest('.device-row')?.classList.contains('blocked')));
        });
    }
    function notice(message, error = false) {
        clearTimeout(noticeTimer);
        $('notice').textContent = message;
        $('notice').className = error ? 'error' : '';
        $('notice').hidden = false;
        if (!error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4500);
    }
    async function run(action, message) {
        if (busy) return;
        busy = true;
        updateControlLocks();
        try {
            const next = await action();
            if (next?.config) render(next);
            else render(await api.getStatus());
            if (message) notice(message);
        } catch (error) { notice(error.message || String(error), true); }
        finally {
            busy = false;
            if (status) render(status);
            else updateControlLocks();
        }
    }
    async function copy(value) {
        try { await navigator.clipboard.writeText(value); notice('已复制。'); }
        catch {
            const temporary = document.createElement('textarea');
            temporary.value = value;
            temporary.style.position = 'fixed';
            temporary.style.opacity = '0';
            document.body.append(temporary);
            temporary.select();
            const copied = document.execCommand('copy');
            temporary.remove();
            notice(copied ? '已复制。' : '复制失败，请手动复制。', !copied);
        }
    }
    function button(label, className, action) {
        const element = document.createElement('button');
        element.type = 'button'; element.className = className; element.textContent = label;
        element.addEventListener('click', action); return element;
    }
    function relativeTime(value) {
        const time = typeof value === 'number' ? value : Date.parse(value);
        if (!Number.isFinite(time)) return '尚未同步';
        const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
        if (seconds < 5) return '刚刚在线';
        if (seconds < 60) return `${seconds} 秒前在线`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前在线`;
        return `${Math.floor(seconds / 3600)} 小时前在线`;
    }
    function renderDevices(devices) {
        const list = $('device-list');
        const nextSignature = JSON.stringify(devices.map(device => [device.id, device.name, device.ip, device.role, device.blocked, device.online]));
        // Keep an opened role selector stable during heartbeat-only refreshes.
        // Permission changes and kicks must still replace their controls at once.
        if (list.contains(document.activeElement) && document.activeElement.tagName === 'SELECT' && nextSignature === deviceSignature) return;
        deviceSignature = nextSignature;
        list.replaceChildren();
        setText('device-count', devices.filter(device => !device.blocked && device.online !== false).length);
        if (!devices.length) {
            const empty = document.createElement('p'); empty.className = 'empty-state';
            empty.textContent = '暂时没有设备接入。启动网关后，分享地址和对应权限的访问码。';
            list.append(empty); return;
        }
        for (const device of devices) {
            const row = document.createElement('div'); row.className = `device-row${device.blocked ? ' blocked' : ''}`;
            const icon = document.createElement('div'); icon.className = 'device-icon'; icon.setAttribute('aria-hidden', 'true');
            const text = document.createElement('div');
            const name = document.createElement('div'); name.className = 'device-name'; name.textContent = device.name || '未命名设备';
            const info = document.createElement('div'); info.className = 'device-info';
            info.textContent = `${device.ip || '未知地址'} · ${device.blocked ? '已强制下线' : relativeTime(device.lastSeenAt || device.lastSeen)}`;
            text.append(name, info);
            const role = document.createElement('select'); role.className = 'device-role';
            role.setAttribute('aria-label', `${device.name || '设备'}的访问权限`);
            for (const [value, label] of [['read', '只读 · 监看'], ['write', '可写 · 追加消息']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; role.append(option); }
            role.value = device.role; role.disabled = Boolean(device.blocked);
            role.addEventListener('change', () => run(() => api.setDeviceRole(device.id, role.value), '设备权限已更新。'));
            const actions = document.createElement('div'); actions.className = 'device-actions';
            actions.append(device.blocked
                ? button('解除阻止', 'button secondary', () => run(() => api.unblockDevice(device.id), '已允许该设备重新登录。'))
                : button('强制下线', 'button danger', () => run(() => api.kickDevice(device.id), '设备已下线并被阻止重新登录。')));
            row.append(icon, text, role, actions); list.append(row);
        }
    }
    function render(next) {
        status = next;
        const config = next.config || {};
        const running = Boolean(next.running);
        const badge = $('gateway-badge'); badge.classList.toggle('running', running);
        badge.replaceChildren(document.createElement('i'), document.createTextNode(running ? '运行中' : '已关闭'));
        setText('service-title', running ? '局域网网关已启动' : '随时准备连接');
        setText('service-detail', running ? '浏览器完成验证后，即可监看当前任务。你始终掌握每台设备的权限。' : '启动网关后，在同一局域网的浏览器输入下方地址。');
        const toggle = $('toggle-gateway'); toggle.textContent = running ? '关闭网关' : '启动网关 ↗'; toggle.classList.toggle('stop', running); toggle.disabled = busy || !api;
        const urls = $('gateway-urls'); urls.replaceChildren();
        for (const url of next.urls || []) {
            const row = document.createElement('div'); row.className = 'url-row';
            const code = document.createElement('code'); code.textContent = typeof url === 'string' ? url : url.url;
            row.append(code, button('复制地址', 'icon-button', () => copy(code.textContent))); urls.append(row);
        }
        const hostSelect = $('host');
        const selection = document.activeElement === hostSelect || hostSelect.dataset.dirty ? hostSelect.value : config.host;
        hostSelect.replaceChildren();
        for (const iface of next.interfaces || []) {
            const option = document.createElement('option'); option.value = iface.address;
            option.textContent = iface.label || `${iface.address} · ${iface.name}${iface.virtual ? '（虚拟网卡 / VPN）' : iface.internal ? '（仅本机）' : ''}`;
            hostSelect.append(option);
        }
        if (!Array.from(hostSelect.options).some(option => option.value === '0.0.0.0')) { const all = document.createElement('option'); all.value = '0.0.0.0'; all.textContent = '0.0.0.0 · 所有 IPv4 接口（含虚拟网卡）'; hostSelect.append(all); }
        if (selection && !Array.from(hostSelect.options).some(option => option.value === selection)) { const custom = document.createElement('option'); custom.value = selection; custom.textContent = `${selection} · 已保存的监听地址`; hostSelect.append(custom); }
        hostSelect.value = selection || '';
        hostSelect.disabled = running || busy; $('port').disabled = running || busy; $('save-network').disabled = running || busy;
        const values = { port: config.port, 'poll-interval': config.pollIntervalMs, 'session-ttl': config.sessionTtlMinutes, 'max-devices': config.maxDevices };
        for (const [id, value] of Object.entries(values)) { if (document.activeElement !== $(id) && !$(id).dataset.dirty) $(id).value = value ?? ''; }
        $('allow-write').checked = Boolean(config.allowWrite);
        $('read-code').value = next.credentials?.readCode || '';
        $('write-code').value = next.credentials?.writeCode || '';
        renderDevices(next.devices || []);
        const snapshot = next.snapshot;
        setText('current-session', snapshot?.agentEnabled ? `当前会话：${snapshot.title || 'Agent 会话'} · ${snapshot.running ? '正在运行' : '等待下一轮'}` : '仅共享桌面端当前活动的 Agent 会话');
        if (next.error) notice(String(next.error), true);
        updateControlLocks();
    }
    ['port', 'poll-interval', 'session-ttl', 'max-devices'].forEach(id => $(id).addEventListener('input', () => { $(id).dataset.dirty = 'true'; }));
    $('host').addEventListener('change', () => { $('host').dataset.dirty = 'true'; });
    $('network-form').addEventListener('submit', event => {
        event.preventDefault();
        run(async () => { const result = await api.configure({ host: $('host').value, port: Number($('port').value) }); delete $('host').dataset.dirty; delete $('port').dataset.dirty; return result; }, '网络设置已保存。');
    });
    $('advanced-form').addEventListener('submit', event => {
        event.preventDefault();
        run(async () => { const result = await api.configure({ pollIntervalMs: Number($('poll-interval').value), sessionTtlMinutes: Number($('session-ttl').value), maxDevices: Number($('max-devices').value) }); ['poll-interval', 'session-ttl', 'max-devices'].forEach(id => delete $(id).dataset.dirty); return result; }, '连接参数已生效。');
    });
    $('allow-write').addEventListener('change', () => run(() => api.configure({ allowWrite: $('allow-write').checked }), '远程写入权限已更新。'));
    $('toggle-gateway').addEventListener('click', () => {
        const networkDirty = Boolean($('host').dataset.dirty || $('port').dataset.dirty);
        if (!status?.running && networkDirty && !$('network-form').reportValidity()) return;
        run(async () => {
            if (status?.running) return api.stop();
            // Starting must bind the interface that the user currently sees.
            if (networkDirty) {
                await api.configure({ host: $('host').value, port: Number($('port').value) });
                delete $('host').dataset.dirty;
                delete $('port').dataset.dirty;
            }
            return api.start();
        });
    });
    $('rotate-codes').addEventListener('click', () => {
        if (window.confirm('重新生成访问码会使所有设备下线，旧访问码立即失效。是否继续？')) run(() => api.rotateCredentials(), '访问码已更新，请向设备分享新访问码。');
    });
    $('refresh-status').addEventListener('click', () => run(() => api.getStatus()));
    document.querySelectorAll('.copy-code').forEach(element => element.addEventListener('click', () => copy($(element.dataset.target).value)));
    document.querySelectorAll('.reveal-code').forEach(element => element.addEventListener('click', () => { const input = $(element.dataset.target); input.type = input.type === 'password' ? 'text' : 'password'; element.textContent = input.type === 'password' ? '显示' : '隐藏'; }));
    if (!api) { notice('此控制台仅可从 Electron 桌面端打开。', true); return; }
    api.onStatus(next => render(next));
    run(() => api.getStatus());
    // Heartbeats update the connection list without requiring a push per browser poll.
    setInterval(async () => { if (busy || document.hidden) return; try { render(await api.getStatus()); } catch {} }, 2500);
})();
