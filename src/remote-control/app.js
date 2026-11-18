(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    let device = null;
    let csrfToken = '';
    let snapshot = null;
    let revision = -1;
    let interval = 1000;
    let pollTimer;
    let pollGeneration = 0;
    let authGeneration = 0;
    let lastSync = 0;
    let sending = false;
    let pendingMessage = null;
    let followLatest = true;
    let transcriptSignature = '';
    let resultTimer;
    const messageElements = new Map();
    const renderedMessages = new WeakMap();
    const setText = (id, text) => { $(id).textContent = text; };
    const pollInterval = value => Math.max(500, Math.min(2000, Number(value) || 1000));
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    let preferredTheme = '';
    try { preferredTheme = localStorage.getItem('aiui_gateway_theme') || ''; } catch {}
    if (!['light', 'dark'].includes(preferredTheme)) preferredTheme = '';
    function applyTheme() {
        const theme = preferredTheme || (systemTheme.matches ? 'dark' : 'light');
        document.documentElement.dataset.theme = theme;
        document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#1b1f1c' : '#fafaf8';
        document.querySelectorAll('.theme-toggle').forEach(button => {
            button.textContent = theme === 'dark' ? '☼' : '◐';
            button.title = theme === 'dark' ? '切换亮色主题' : '切换暗色主题';
            button.setAttribute('aria-label', button.title);
        });
    }
    document.querySelectorAll('.theme-toggle').forEach(button => button.addEventListener('click', () => {
        preferredTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem('aiui_gateway_theme', preferredTheme); } catch {}
        applyTheme();
    }));
    if (systemTheme.addEventListener) systemTheme.addEventListener('change', () => { if (!preferredTheme) applyTheme(); });
    else systemTheme.addListener(() => { if (!preferredTheme) applyTheme(); });
    applyTheme();
    const escapeHtml = value => String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
    function safeLink(value) {
        try {
            const raw = String(value || '').trim();
            if (!raw) return '';
            const url = new URL(raw, location.href);
            return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : '';
        } catch { return ''; }
    }
    const markdown = window.marked?.Marked ? new window.marked.Marked({ gfm: true, breaks: false, async: false }) : null;
    if (markdown) markdown.use({ renderer: {
        // Raw HTML stays text, and image syntax becomes a link. Neither can make
        // a browser fetch an image before the reader explicitly opens its URL.
        html(token) { return escapeHtml(token.text); },
        image(token) {
            const href = safeLink(token.href);
            const label = `图片：${token.text || '查看图片'}`;
            return href ? `<a class="image-reference" href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : escapeHtml(label);
        }
    } });
    function renderMarkdown(element, text) {
        if (!markdown || !window.DOMPurify) { element.textContent = text; return; }
        try {
            const fragment = window.DOMPurify.sanitize(markdown.parse(text), {
                RETURN_DOM_FRAGMENT: true,
                ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'a', 'pre', 'code', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'span', 'kbd', 'sup', 'sub'],
                ALLOWED_ATTR: ['href', 'title', 'start', 'colspan', 'rowspan', 'class'],
                ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false
            });
            fragment.querySelectorAll('a').forEach(link => {
                const href = safeLink(link.getAttribute('href'));
                if (!href) link.removeAttribute('href');
                else { link.href = href; link.target = '_blank'; link.rel = 'nofollow noopener noreferrer'; }
            });
            fragment.querySelectorAll('table').forEach(table => {
                const wrapper = document.createElement('div'); wrapper.className = 'table-scroll';
                table.replaceWith(wrapper); wrapper.append(table);
            });
            element.replaceChildren(fragment);
        } catch { element.textContent = text; }
    }
    async function request(path, { method = 'GET', data, timeout = 5000 } = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(path, {
                method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
                headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrfToken ? { 'X-Gateway-CSRF': csrfToken } : {}) },
                ...(data ? { body: JSON.stringify(data) } : {})
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                const error = new Error(body.error || body.message || `连接失败（${response.status}）`);
                error.status = response.status; error.code = body.code; throw error;
            }
            return body;
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('连接超时，正在等待电脑端响应。');
            throw error;
        } finally { clearTimeout(timer); }
    }
    function showLogin(message = '') {
        clearTimeout(pollTimer); pollGeneration += 1;
        device = null; csrfToken = ''; snapshot = null; revision = -1; lastSync = 0;
        pendingMessage = null; transcriptSignature = ''; messageElements.clear();
        $('workspace-view').hidden = true; $('login-view').hidden = false;
        $('access-code').value = '';
        $('message-input').value = ''; updateInput();
        $('login-error').hidden = !message; setText('login-error', message);
        $('login-button').disabled = false; setText('login-button', '验证并连接 →');
    }
    function updateSession(data) {
        if (data.device) device = data.device;
        if (data.csrfToken) csrfToken = data.csrfToken;
        interval = pollInterval(data.pollIntervalMs);
        const writable = Boolean(device?.canWrite ?? (device?.role === 'write' && data.allowWrite !== false));
        $('permission-badge').classList.toggle('writable', writable);
        setText('permission-badge', writable ? '可写' : '只读');
        $('readonly-notice').hidden = writable;
        $('message-form').hidden = !writable;
        if (!writable) { pendingMessage = null; $('message-input').value = ''; updateInput(); }
        $('device-label').title = `${device?.name || '当前设备'} · ${writable ? '可追加消息' : '只读监看'} · 所有 AI 请求均由电脑端完成`;
        $('permission-badge').title = $('device-label').title;
        updateComposer();
    }
    function showWorkspace(data) {
        clearTimeout(pollTimer); pollGeneration += 1;
        $('login-view').hidden = true; $('workspace-view').hidden = false;
        $('login-error').hidden = true; $('access-code').value = '';
        revision = -1; snapshot = null; transcriptSignature = ''; messageElements.clear(); followLatest = true;
        updateSession(data); renderSnapshot(null);
        poll(pollGeneration);
    }
    function setConnection(ok, message = '') {
        const element = $('connection-state'); element.classList.toggle('error', !ok);
        element.replaceChildren(document.createElement('i'), document.createTextNode(ok ? '已连接' : '重连中'));
        $('connection-error').hidden = !message; setText('connection-error', message);
    }
    async function poll(generation) {
        if (!device || generation !== pollGeneration) return;
        const started = Date.now();
        let failed = false;
        try {
            const data = await request(`/api/state?revision=${encodeURIComponent(revision)}`, { timeout: 4500 });
            if (generation !== pollGeneration) return;
            lastSync = Date.now();
            updateSession(data);
            if (data.snapshot !== undefined) renderSnapshot(data.snapshot);
            if (data.revision !== undefined) revision = data.revision;
            setConnection(true); updateSyncTime();
        } catch (error) {
            if (generation !== pollGeneration) return;
            if (error.status === 401 || error.status === 403) { showLogin(error.status === 403 ? '此设备已被电脑端强制下线或阻止。请在电脑端解除后重新连接。' : '登录已失效，请重新输入访问码。'); return; }
            failed = true;
            setConnection(false, '暂时无法连接电脑端，正在自动重试。请确认网关仍在运行，且两台设备处于同一局域网。');
            updateComposer();
        } finally {
            if (device && generation === pollGeneration) pollTimer = setTimeout(() => poll(generation), failed ? 1500 : Math.max(100, interval - (Date.now() - started)));
        }
    }
    function emptyConversation() {
        const empty = document.createElement('div'); empty.className = 'conversation-empty';
        const heading = document.createElement('h2'); heading.textContent = '等待电脑端的当前会话';
        const copy = document.createElement('p'); copy.textContent = '在电脑端打开 Agent 会话后自动同步。';
        empty.append(heading, copy); return empty;
    }
    function messageKind(message) {
        if (message.kind === 'thinking') return 'thinking';
        if (['tool', 'activity'].includes(message.kind) || ['tool', 'activity'].includes(message.role)) return 'tool';
        return message.role === 'user' ? 'user' : 'assistant';
    }
    function createMessage(message, key) {
        const row = document.createElement('article'); row.dataset.messageId = key;
        const kind = messageKind(message);
        row.className = `message ${kind}`;
        if (kind === 'tool' || kind === 'thinking') {
            const details = document.createElement('details'); details.className = 'message-details'; details.open = kind === 'thinking';
            const summary = document.createElement('summary');
            const arrow = document.createElement('span'); arrow.className = 'fold-arrow'; arrow.setAttribute('aria-hidden', 'true');
            const icon = document.createElement('span'); icon.className = 'tool-icon'; icon.setAttribute('aria-hidden', 'true');
            const title = document.createElement('span'); title.className = 'tool-title';
            const preview = document.createElement('span'); preview.className = 'tool-summary';
            const time = document.createElement('span'); time.className = 'tool-time';
            const body = document.createElement('div'); body.className = 'tool-body';
            summary.append(arrow, icon, title, preview, time); details.append(summary, body); row.append(details);
            details.addEventListener('toggle', () => {
                // Expanding a detail should not make subsequent polls jump away.
                const container = $('messages');
                followLatest = container.scrollHeight - container.scrollTop - container.clientHeight < 70;
                $('scroll-latest').hidden = followLatest;
            });
        } else {
            const header = document.createElement('div'); header.className = 'message-header';
            header.textContent = kind === 'user' ? '你' : 'Agent';
            const content = document.createElement('div'); content.className = 'message-content';
            row.append(header, content);
        }
        return row;
    }
    function updateMessage(row, message) {
        const signature = JSON.stringify(message);
        if (renderedMessages.get(row) === signature) return;
        renderedMessages.set(row, signature);
        const kind = messageKind(message);
        const text = String(message.content || '');
        const failed = ['failed', 'error'].includes(message.status);
        row.dataset.status = failed ? 'failed' : message.status || '';
        if (kind === 'tool' || kind === 'thinking') {
            row.querySelector('.tool-icon').textContent = message.status === 'running' ? '◌' : failed ? '!' : '✓';
            const title = row.querySelector('.tool-title');
            const preview = row.querySelector('.tool-summary');
            const body = row.querySelector('.tool-body');
            const time = row.querySelector('.tool-time');
            if (kind === 'thinking') {
                title.textContent = message.status === 'running' ? '思考中' : '思考';
                preview.textContent = '';
                const lines = text.split(/\r?\n/);
                body.textContent = lines.length > 6 && !/省略/.test(text)
                    ? `${lines.slice(0, 3).join('\n')}\n… 已省略 ${lines.length - 6} 行 …\n${lines.slice(-3).join('\n')}` : text;
                if (Number(message.omittedLines) > 0 && !/省略/.test(body.textContent)) {
                    body.textContent = `${lines.slice(0, 3).join('\n')}\n… 已省略 ${Math.floor(message.omittedLines)} 行 …\n${lines.slice(3).join('\n')}`;
                }
                time.textContent = Number.isFinite(message.durationMs) ? `${Math.max(0, Math.round(message.durationMs / 1000))} 秒` : '';
            } else {
                title.textContent = text || '使用工具';
                const detail = String(message.detail || '');
                const name = String(message.toolName || '');
                preview.textContent = [name, detail.split(/\r?\n/)[0]].filter(Boolean).join(' · ');
                preview.title = preview.textContent;
                body.textContent = [name, detail].filter(Boolean).join('\n');
                time.textContent = '';
            }
        } else {
            const content = row.querySelector('.message-content');
            if (kind === 'assistant') renderMarkdown(content, text);
            else content.textContent = text;
        }
    }
    function renderMessages(messages) {
        const signature = JSON.stringify(messages);
        if (signature === transcriptSignature) return;
        transcriptSignature = signature;
        const container = $('messages');
        const wasAtBottom = followLatest || container.scrollHeight - container.scrollTop - container.clientHeight < 80;
        if (!messages.length) { container.replaceChildren(emptyConversation()); messageElements.clear(); return; }
        container.querySelector('.conversation-empty')?.remove();
        const activeKeys = new Set();
        messages.forEach((message, index) => {
            const key = String(message.id ?? `${index}-${message.role}-${message.kind || ''}`);
            activeKeys.add(key);
            const expectedClass = messageKind(message);
            let row = messageElements.get(key);
            if (row && !row.classList.contains(expectedClass)) { row.remove(); row = null; }
            if (!row) { row = createMessage(message, key); messageElements.set(key, row); }
            updateMessage(row, message);
            if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
        });
        for (const [key, row] of messageElements) if (!activeKeys.has(key)) { row.remove(); messageElements.delete(key); }
        if (wasAtBottom) {
            // Scroll immediately as background tabs may defer animation frames.
            // A delayed frame must also respect a user who has started reading.
            scrollLatest();
            requestAnimationFrame(() => { if (followLatest) scrollLatest(); });
        }
        else $('scroll-latest').hidden = false;
    }
    function renderSnapshot(next) {
        const previousChat = snapshot?.chatId;
        snapshot = next;
        if (previousChat && previousChat !== next?.chatId) {
            $('message-input').value = ''; pendingMessage = null; updateInput();
            transcriptSignature = ''; messageElements.clear(); $('messages').replaceChildren(); followLatest = true;
            sendResult('电脑端已切换会话，草稿已清空。');
        }
        const active = Boolean(next?.agentEnabled && next?.chatId);
        setText('session-title', active ? next.title || 'Agent 会话' : '等待电脑端会话');
        $('session-title').title = $('session-title').textContent;
        setText('activity-title', !active ? '等待当前会话' : next.running ? 'Agent 正在运行' : '等待下一轮任务');
        setText('activity-detail', !active ? '等待电脑端打开 Agent 会话' : `${next.activity || (next.running ? '正在处理任务' : '等待下一轮任务')}${next.queuedCount ? ` · ${next.queuedCount} 条消息待处理` : ''}`);
        $('activity-detail').title = $('activity-detail').textContent;
        renderMessages(active && Array.isArray(next.messages) ? next.messages : []);
        updateComposer();
    }
    function updateComposer() {
        const available = Boolean(device && snapshot?.agentEnabled && snapshot?.chatId && Date.now() - lastSync < 10000);
        const writable = Boolean(device?.canWrite ?? device?.role === 'write');
        $('message-input').disabled = !available || !writable || sending;
        $('send-button').disabled = !available || !writable || sending || !$('message-input').value.trim();
        $('message-input').placeholder = !available ? '等待电脑端活动的 Agent 会话…' : snapshot.running ? '追加消息，Agent 将在下一步处理…' : '发送消息，继续下一轮任务…';
    }
    function updateInput() {
        const input = $('message-input');
        input.style.height = 'auto'; input.style.height = `${Math.min(140, input.scrollHeight)}px`;
        updateComposer();
    }
    function scrollLatest() { const container = $('messages'); container.scrollTop = container.scrollHeight; followLatest = true; $('scroll-latest').hidden = true; }
    function updateSyncTime() {
        const seconds = lastSync ? Math.max(0, Math.floor((Date.now() - lastSync) / 1000)) : null;
        setText('last-sync', seconds === null ? '正在同步' : seconds < 3 ? '刚刚同步' : `${seconds} 秒前同步`);
    }
    function sendResult(message, error = false) {
        clearTimeout(resultTimer); setText('send-result', message); $('send-result').className = error ? 'send-result error' : 'send-result'; $('send-result').hidden = false;
        if (!error) resultTimer = setTimeout(() => { $('send-result').hidden = true; }, 6000);
    }
    function newRequestId() {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
        if (globalThis.crypto?.getRandomValues) { const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes); return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); }
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    }
    $('login-form').addEventListener('submit', async event => {
        authGeneration += 1;
        event.preventDefault(); $('login-button').disabled = true; setText('login-button', '正在验证…'); $('login-error').hidden = true;
        try {
            const data = await request('/api/login', { method: 'POST', data: { code: $('access-code').value.trim(), deviceName: $('device-name').value.trim() } });
            showWorkspace(data);
        } catch (error) { setText('login-error', error.message); $('login-error').hidden = false; }
        finally { $('login-button').disabled = false; setText('login-button', '验证并连接 →'); }
    });
    $('logout-button').addEventListener('click', async () => {
        $('logout-button').disabled = true;
        try { await request('/api/logout', { method: 'POST', data: {} }); showLogin('已断开连接。'); }
        catch (error) { if (error.status === 401 || error.status === 403) showLogin('连接已失效。'); else { setConnection(false, '断开连接失败，请重试；电脑端也可以强制下线此设备。'); } }
        finally { $('logout-button').disabled = false; }
    });
    $('message-form').addEventListener('submit', async event => {
        event.preventDefault();
        const text = $('message-input').value.trim();
        if (!text || sending || !snapshot?.agentEnabled || !snapshot?.chatId || !(device?.canWrite ?? device?.role === 'write')) return;
        const chatId = snapshot.chatId;
        if (!pendingMessage || pendingMessage.text !== text || pendingMessage.chatId !== chatId) pendingMessage = { text, chatId, requestId: newRequestId() };
        const message = pendingMessage;
        sending = true; updateComposer(); $('send-result').hidden = true;
        try {
            const result = await request('/api/messages', { method: 'POST', data: message, timeout: 8000 });
            if (!device || snapshot?.chatId !== chatId) return;
            if ($('message-input').value.trim() === text) { $('message-input').value = ''; updateInput(); }
            if (pendingMessage === message) pendingMessage = null;
            sendResult(result.queued ? '已发送到电脑端，等待 Agent 处理。' : '已发送到电脑端。');
            followLatest = true;
        } catch (error) {
            if (error.status === 401) { showLogin('登录已失效，请重新输入访问码。'); return; }
            if (error.status === 403) {
                // A role downgrade may reject writing while the monitoring session remains valid.
                try { const session = await request('/api/session'); if (!session.authenticated) { showLogin('连接已失效。'); return; } updateSession(session); }
                catch { showLogin('此设备已被电脑端强制下线。'); return; }
            }
            if (error.status && error.status < 500) pendingMessage = null;
            sendResult(`${error.message}${!error.status ? ' 可再次发送重试，相同消息不会重复提交。' : ''}`, true);
        } finally { sending = false; updateComposer(); }
    });
    $('message-input').addEventListener('input', updateInput);
    $('message-input').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); $('message-form').requestSubmit(); } });
    $('messages').addEventListener('scroll', () => { const container = $('messages'); followLatest = container.scrollHeight - container.scrollTop - container.clientHeight < 70; $('scroll-latest').hidden = followLatest; }, { passive: true });
    $('scroll-latest').addEventListener('click', scrollLatest);
    window.addEventListener('resize', () => { if (followLatest) scrollLatest(); });
    window.addEventListener('pageshow', event => { if (event.persisted && device) { clearTimeout(pollTimer); pollGeneration += 1; poll(pollGeneration); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && device) { clearTimeout(pollTimer); pollGeneration += 1; poll(pollGeneration); } });
    setInterval(() => { if (device) { updateSyncTime(); updateComposer(); } }, 1000);
    const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    $('device-name').value = isMobile ? '我的手机' : '我的浏览器';
    const initialAuthGeneration = authGeneration;
    request('/api/session').then(data => {
        if (initialAuthGeneration !== authGeneration) return;
        if (data.authenticated) showWorkspace(data); else showLogin();
    }).catch(error => {
        if (initialAuthGeneration === authGeneration) showLogin(error.status === 403 ? '此设备已被电脑端阻止，请先在电脑端解除。' : '无法连接网关，请确认电脑端网关仍在运行。');
    });
})();
