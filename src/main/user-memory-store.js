const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../renderer/user-memory');

function createDiskMemoryStore(directory) {
    const file = path.join(directory, 'user-memory.json');
    let data;
    function read() {
        if (data) return data;
        try {
            data = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            data = new Map();
        }
        return data;
    }
    function write(next) {
        fs.mkdirSync(directory, { recursive: true });
        const temporary = file + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(next)), { mode: 0o600 });
        fs.renameSync(temporary, file);
        data = next;
    }
    return createStore({
        getItem: key => read().get(key) ?? null,
        setItem(key, value) {
            const current = read();
            if (current.get(key) !== value) write(new Map(current).set(key, value));
        },
        removeItem(key) {
            const next = new Map(read());
            if (next.delete(key)) write(next);
        }
    });
}

module.exports = { createDiskMemoryStore };
