const test = require('node:test');
const assert = require('node:assert/strict');
const { SpeechQueue, cleanText, createSentenceReader } = require('../renderer/text-speech');

const tick = () => new Promise(resolve => setImmediate(resolve));

test('streamed sentences are emitted once and long segments are bounded', () => {
    const read = createSentenceReader();
    const prepare = text => cleanText(text, true);
    assert.deepEqual(read(prepare('你好。第二句（暂'), false), ['你好。']);
    assert.deepEqual(read(prepare('你好。第二句（暂停）！结尾'), false), ['第二句！']);
    assert.deepEqual(read(prepare('你好。第二句（暂停）！结尾'), true), ['结尾']);
    const long = createSentenceReader()('长'.repeat(1000), true);
    assert.ok(long.every(segment => segment.length <= 160));
    assert.equal(long.join('').length, 1000);
});

test('a fifth request waits for the second audio to start and stop cancels synthesis', async () => {
    const requests = [];
    const audios = [];
    const queue = new SpeechQueue({
        synthesize(text, signal) {
            return new Promise(resolve => requests.push({ text, signal, resolve }));
        },
        createAudio() {
            const audio = { play: async () => {}, pause() {}, load() {}, removeAttribute() {} };
            audios.push(audio);
            return audio;
        },
        onChange() {},
        onError: assert.fail,
        onFinish: assert.fail
    });
    queue.enqueue(['一', '二', '三', '四', '五', '六'], 'reply');
    assert.equal(queue.sourceKey, 'reply');
    for (let i = 0; i < 3; i++) {
        requests[i].resolve('audio');
        await tick();
    }
    assert.equal(requests.length, 3);
    audios[0].onplaying();
    assert.deepEqual(requests.map(({ text }) => text), ['一', '二', '三', '四']);
    requests[3].resolve('audio');
    await tick();
    assert.equal(requests.length, 4);
    queue.togglePause();
    assert.equal(queue.paused, true);
    queue.togglePause();
    audios[0].onended();
    assert.equal(requests.length, 4);
    audios[1].onplaying();
    assert.equal(requests[4].text, '五');
    queue.stop();
    assert.ok(requests[4].signal.aborted);
    requests[4].resolve('audio');
    await tick();
    assert.equal(requests.length, 5);
    assert.equal(queue.sourceKey, null);
});
