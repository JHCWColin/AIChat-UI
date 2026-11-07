const { parentPort } = require('node:worker_threads');
const tokenizer = require('./tokenizer-runtime.cjs');
parentPort.on('message', ({ id, texts, model }) => {
    try {
        let label = tokenizer.describe(model);
        const counts = texts.map(text => {
            try { return tokenizer.count(text, model); }
            catch (_) {
                label = '通用 o200k_base 参考估算';
                return tokenizer.count(text, '');
            }
        });
        parentPort.postMessage({ id, counts, label, generic: /参考估算|字符估算/.test(label) });
    } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
