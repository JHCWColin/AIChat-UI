(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.AIUITextSpeech = factory();
})(globalThis, function () {
    const MAX_WAITING = 3;
    const MAX_SEGMENT_LENGTH = 160;

    function cleanText(text, ignoreParentheses) {
        let output = String(text || '')
            .replace(/\[replace\]\s*\r?\nstart:\d+\s*\r?\nend:\d+\s*\r?\n\s*\x60\x60\x60[\s\S]*?(?:\x60\x60\x60|$)/gi, '')
            .replace(/(?:\x60{3}|~{3})[\s\S]*?(?:\x60{3}|~{3}|$)/g, '')
            .replace(/!\[[^\]]*\]\([^)\r\n]*(?:\)|$)/g, '')
            .replace(/\[([^\]]*)\]\([^)\r\n]*(?:\)|$)/g, '$1')
            .replace(/<[^>\r\n]*(?:>|$)/g, '')
            .replace(/^[ \t]*(?:#{1,6}|>|[-*]|\d+[.)])\s+/gm, '')
            .replace(/[*_\x60]/g, '');
        if (ignoreParentheses) {
            let previous;
            do {
                previous = output;
                output = output.replace(/（[^（）]*）|\([^()]*\)/g, '');
            } while (output !== previous);
            output = output.replace(/[（(][^）)]*$/, '');
        }
        return output;
    }

    function nextBoundary(text, final) {
        const punctuation = /\r?\n|[。！？!?；;]+[”’」』）)]*|\.(?=\s|$)/g;
        const match = punctuation.exec(text);
        if (match && match.index < MAX_SEGMENT_LENGTH
            && (final || match[0] !== '.' || punctuation.lastIndex < text.length)) {
            return punctuation.lastIndex;
        }
        if (text.length > MAX_SEGMENT_LENGTH) {
            const prefix = text.slice(0, MAX_SEGMENT_LENGTH);
            const breakAt = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('，'), prefix.lastIndexOf(',')) + 1;
            if (breakAt > MAX_SEGMENT_LENGTH / 2) return breakAt;
            return /[\uD800-\uDBFF]$/.test(prefix) ? MAX_SEGMENT_LENGTH - 1 : MAX_SEGMENT_LENGTH;
        }
        return final ? text.length : 0;
    }

    function createSentenceReader() {
        let consumed = '';
        return (text, final) => {
            // A provider can replace its cumulative snapshot. Keep already
            // queued speech from being emitted a second time.
            if (!text.startsWith(consumed)) return [];
            const sentences = [];
            let remainder = text.slice(consumed.length);
            for (let end = nextBoundary(remainder, final); end > 0; end = nextBoundary(remainder, final)) {
                const segment = remainder.slice(0, end);
                consumed += segment;
                remainder = remainder.slice(end);
                const spoken = segment.trim();
                if (/[\p{L}\p{N}]/u.test(spoken)) sentences.push(spoken);
            }
            return sentences;
        };
    }

    class SpeechQueue {
        constructor({ synthesize, createAudio, onChange, onFinish, onError }) {
            Object.assign(this, { synthesize, createAudio, onChange, onFinish, onError });
            this.pending = [];
            this.ready = [];
            this.abort = new AbortController();
            this.current = null;
            this.loading = null;
            this.paused = false;
            this.closed = false;
        }

        get sourceKey() {
            return (this.current || this.ready[0] || this.loading || this.pending[0])?.sourceKey || null;
        }

        enqueue(sentences, sourceKey) {
            if (this.closed || this.abort.signal.aborted || !sentences.length) return;
            for (const text of sentences) this.pending.push({ text, sourceKey });
            this.pump();
        }

        close() {
            this.closed = true;
            this.pump();
        }

        stop() {
            this.abort.abort();
            this.clearAudio();
            this.loading = null;
            this.pending.length = 0;
            this.ready.length = 0;
        }

        clearAudio() {
            const audio = this.current?.audio;
            this.current = null;
            if (!audio) return;
            audio.onplaying = audio.onended = audio.onerror = null;
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
        }

        togglePause() {
            if (this.abort.signal.aborted) return;
            this.paused = !this.paused;
            if (this.paused) this.current?.audio.pause();
            else if (this.current) this.play(this.current);
            this.pump();
        }

        pump() {
            if (this.abort.signal.aborted) return;
            if (!this.paused && !this.current && this.ready.length) {
                const item = this.ready.shift();
                const audio = this.createAudio(item.data);
                this.current = { ...item, audio, started: false };
                const current = this.current;
                audio.onplaying = () => {
                    if (this.current !== current || this.paused) return;
                    current.started = true;
                    this.pump();
                };
                audio.onended = () => {
                    if (this.current !== current) return;
                    this.clearAudio();
                    this.pump();
                };
                audio.onerror = () => this.fail(new Error('无法播放合成的语音'));
                this.play(current);
            }
            // Include reserved audio until it actually starts playing. There is
            // only one request in flight, and it reserves one of these slots.
            const waiting = this.ready.length + Number(Boolean(this.current && !this.current.started));
            if (!this.paused && !this.loading && this.pending.length && waiting < MAX_WAITING) {
                void this.synthesizeNext(this.pending.shift());
            }
            const active = Boolean(this.current || this.loading || this.ready.length || this.pending.length);
            if (!active && this.closed) {
                this.stop();
                this.onFinish();
                return;
            }
            this.onChange(active);
        }

        play(item) {
            item.audio.play().catch(error => {
                if (!this.paused && this.current === item && error.name !== 'AbortError') this.fail(error);
            });
        }

        async synthesizeNext(item) {
            this.loading = item;
            try {
                const data = await this.synthesize(item.text, this.abort.signal);
                if (this.abort.signal.aborted) return;
                if (!data) throw new Error('Fish Audio 返回了空音频');
                this.ready.push({ ...item, data });
                this.loading = null;
                this.pump();
            } catch (error) {
                if (!this.abort.signal.aborted) this.fail(error);
            }
        }

        fail(error) {
            this.stop();
            this.onError(error);
            this.onFinish();
        }
    }

    return { cleanText, createSentenceReader, SpeechQueue };
});
