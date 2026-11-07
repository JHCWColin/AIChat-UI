(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    let archiveBusy = false;
    function finishProgress() {
        archiveBusy = false;
        for (const id of ['export-chats-btn','import-chats-btn']) if ($(id)) $(id).disabled = false;
    }
    async function beginProgress(action) {
        archiveBusy = true;
        for (const id of ['export-chats-btn','import-chats-btn']) if ($(id)) $(id).disabled = true;
        let lastPaint = 0, current = 0;
        const label = document.createElement('div'); label.className = 'archive-progress-label';
        const track = document.createElement('div'); track.className = 'archive-progress-track';
        const fill = document.createElement('div'); fill.className = 'archive-progress-fill'; track.append(fill);
        track.setAttribute('role','progressbar'); track.setAttribute('aria-label',`${action}记录`); track.setAttribute('aria-valuemin','0'); track.setAttribute('aria-valuemax','100');
        async function update(percent,stage) {
            current = Math.max(current,Math.min(100,Math.round(percent)));
            const notification = $('voice-notification');
            if (!notification.contains(track)) { showVoiceNotification('',false,0,true); notification.append(label,track); }
            label.textContent = `${action}记录 · ${stage} ${current}%`;
            track.setAttribute('aria-valuenow',String(current)); fill.style.width = `${current}%`;
            if (Date.now()-lastPaint>=32) { lastPaint=Date.now(); await new Promise(resolve => setTimeout(resolve,0)); }
        }
        await update(0,'准备中');
        await new Promise(resolve => setTimeout(resolve,16));
        return update;
    }
    const canonical = value => JSON.stringify(value, (key,item) => ['toolId','contentRef','executionId','_countedRound','importedInterrupted'].includes(key) ? undefined:key === 'status' && item === 'running' ? 'done':item);
    async function digest(value) {
        const bytes = new TextEncoder().encode(canonical(value));
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte => byte.toString(16).padStart(2,'0')).join('');
    }
    async function materialize(message) {
        const result = JSON.parse(JSON.stringify(message));
        delete result.attachments; delete result._tempAttachments;
        if (result.contentRef && window.getAgentStoredResult) { result.content = await window.getAgentStoredResult(result.contentRef) || result.content; delete result.contentRef; }
        async function visit(value) {
            if (typeof value === 'string' && /^img:[\w-]+$/.test(value)) {
                const image = await ImageStore.getImage(value.slice(4));
                if (!image) throw new Error('图片记录缺失，无法生成完整存档');
                return image;
            }
            if (Array.isArray(value)) return Promise.all(value.map(visit));
            if (value && typeof value === 'object') {
                const entries = await Promise.all(Object.entries(value).map(async ([key,item]) => [key,await visit(item)]));
                return Object.fromEntries(entries);
            }
            return value;
        }
        return visit(result);
    }
    async function buildArchive(progress = async () => {}) {
            const archive = [];
            const total = Math.max(1,chats.reduce((count,chat) => count+(chat.messages || []).length,0));
            let completed = 0;
            for (const chat of chats) {
                const copy = { ...chat,messages:[] };
                for (const message of chat.messages || []) { copy.messages.push(await materialize(message)); await progress(++completed/total*40,'整理会话和图片'); }
                archive.push(copy);
            }
            const records = {};
            for (const chat of archive) for (const message of chat.messages) if (message.voiceRecordId && !records[message.voiceRecordId]) {
                const record = await VoiceRecordStore.getRecord(message.voiceRecordId); if (record) records[message.voiceRecordId] = record;
            }
            await progress(45,'生成存档');
            const zip = new JSZip(); zip.file('conversations.json',JSON.stringify({ format:'aiui-chat-archive',version:1,exportedAt:new Date().toISOString(),chats:archive,voiceRecords:records }));
            return zip;
    }
    async function exportChats() {
        if (archiveBusy) return;
        try {
            const progress = await beginProgress('导出');
            const zip = await buildArchive(progress);
            const blob = await zip.generateAsync({ type:'blob',compression:'DEFLATE',compressionOptions:{ level:6 } },metadata => { void progress(50+metadata.percent*.48,'压缩 ZIP'); });
            await progress(100,'完成');
            const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `AIUI-chats-${new Date().toISOString().slice(0,10)}.zip`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url),30000);
            showVoiceNotification(`已导出 ${chats.length} 个会话`,false,3000);
        } catch (error) { showVoiceNotification(`导出失败：${error.message}`,true,5000); }
        finally { finishProgress(); }
    }
    async function importChats(file) {
        if (archiveBusy) return;
        try {
            if (isGenerating || window.isAgentTaskRunning?.()) throw new Error('请在当前任务结束后导入');
            if (file.size > 512*1024*1024) throw new Error('存档超过 512 MB');
            const progress = await beginProgress('导入');
            await progress(3,'读取 ZIP');
            const zip = await JSZip.loadAsync(file); const entry = zip.file('conversations.json');
            if (!entry) throw new Error('缺少 conversations.json');
            const text = await entry.async('string',metadata => { void progress(5+metadata.percent*.15,'解压记录'); });
            if (text.length > 512*1024*1024) throw new Error('解压后的记录过大');
            await progress(22,'解析记录');
            const data = JSON.parse(text);
            if (data.format !== 'aiui-chat-archive' || data.version !== 1 || !Array.isArray(data.chats)) throw new Error('不支持的存档格式');
            const staged = JSON.parse(JSON.stringify(chats));
            for (const [id,record] of Object.entries(data.voiceRecords || {})) if (record && typeof record === 'object' && !await VoiceRecordStore.getRecord(id)) await VoiceRecordStore.storeRecord({ ...record,id });
            let addedChats = 0, addedMessages = 0;
            for (const [index,incoming] of data.chats.entries()) {
                await progress(25+index/Math.max(1,data.chats.length)*45,'合并并去重');
                if (!incoming || !Array.isArray(incoming.messages)) throw new Error('无效的会话记录');
                const messages = incoming.messages.filter(message => message && ['user','assistant','tool','system'].includes(message.role));
                let target = staged.find(chat => String(chat.id) === String(incoming.id));
                if (!target) {
                    // Different IDs can still be copies of exactly the same export.
                    const incomingHash = await digest(messages);
                    let duplicate = false;
                    for (const existing of staged) if (await digest(await Promise.all((existing.messages || []).map(materialize))) === incomingHash) { duplicate = true; break; }
                    if (duplicate) continue;
                    target = { ...incoming,id:incoming.id || crypto.randomUUID(),messages:[] };
                    // A workspace trust decision cannot be imported from an archive.
                    delete target.agentWorkspace; delete target.agentWorkspaceConfirmed; delete target.agentEnvironment;
                    staged.push(target); addedChats++;
                }
                const existingHashes = new Map();
                for (const existing of target.messages) {
                    const hash = await digest(await materialize(existing)); existingHashes.set(hash,(existingHashes.get(hash) || 0)+1);
                }
                const occurrences = new Map();
                for (const message of messages) {
                    const clean = JSON.parse(JSON.stringify(message)); delete clean.attachments; delete clean._tempAttachments;
                    const hash = await digest(clean); const occurrence = (occurrences.get(hash) || 0)+1; occurrences.set(hash,occurrence);
                    if ((existingHashes.get(hash) || 0) >= occurrence) continue;
                    if (clean.status === 'running') { clean.status = 'done'; clean.importedInterrupted = true; }
                    if (clean.toolId) clean.toolId = `import-${crypto.randomUUID()}`;
                    delete clean.contentRef; delete clean.executionId;
                    target.messages.push(clean); addedMessages++;
                }
            }
            // Keep large inline images out of localStorage just as normal messages do.
            await progress(72,'保存图片');
            let imageCompleted = 0;
            const imageTotal = Math.max(1,staged.reduce((sum,chat) => sum+chat.messages.length,0));
            for (const chat of staged) for (const message of chat.messages) {
                if (Array.isArray(message.generatedImages)) message.generatedImages = await Promise.all(message.generatedImages.map(async image => typeof image === 'string' && image.startsWith('data:image/') ? `img:${await ImageStore.storeImage(image)}`:image));
                await progress(72+ ++imageCompleted/imageTotal*18,'保存图片');
            }
            await progress(94,'保存会话');
            localStorage.setItem('ai_chats',JSON.stringify(staged)); chats = staged;
            renderChatHistory(); const active = chats.find(chat => chat.id === activeChatId); if (active) await renderMessagesWithResolvedRefs(active.messages);
            await progress(100,'完成');
            window.electronAPI?.preferencesChanged(); showVoiceNotification(`已追加 ${addedChats} 个会话、${addedMessages} 条消息`,false,4000); updateTokenEstimate();
        } catch (error) { showVoiceNotification(`导入失败：${error.message}`,true,5000); }
        finally { finishProgress(); }
    }
    window.addEventListener('load',() => {
        // Archive operations run in the main window, with its live result store.
        if (new URLSearchParams(location.search).has('preferences')) return;
        function archiveButton(id,label,icon) {
            const button = document.createElement('button'); button.type = 'button'; button.id = id;
            button.className = 'flex items-center gap-3 px-3 py-2 hover:bg-gray-800 rounded-xl transition-colors';
            button.innerHTML = `<i data-lucide="${icon}" class="w-5 h-5"></i><span class="text-sm">${label}</span>`;
            return button;
        }
        const exportButton = archiveButton('export-chats-btn','导出记录','file-output'); exportButton.onclick = exportChats;
        const importButton = archiveButton('import-chats-btn','导入记录','file-input');
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.zip'; input.hidden = true; input.onchange = async () => { if (input.files[0]) await importChats(input.files[0]); input.value = ''; };
        importButton.onclick = () => input.click(); $('sidebar').lastElementChild.prepend(exportButton,importButton,input);
        lucide.createIcons();
    });
    window.AIUIChatArchive = { materialize,importChats,exportChats,buildArchive };
})();
