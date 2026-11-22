const test = require("node:test");
const assert = require("node:assert/strict");
const FishAudio = require("../shared/fish-audio");

test("domestic speech keeps the existing endpoint and sends the selected engine model ID", () => {
    const config = { apiKey: "test-key", voiceId: "domestic-voice" };
    const request = FishAudio.buildRequest("你好", config);
    assert.equal(request.url, "https://fishaudio.org/api/open/v1/speech/tts");
    assert.deepEqual(JSON.parse(request.body), {
        text: "你好", voiceId: "domestic-voice", modelId: "fishaudio-s21pro-free", format: "mp3", speed: 1
    });
    const flash = FishAudio.buildRequest("你好", { ...config, model: "s2.1-pro-flash" });
    assert.equal(JSON.parse(flash.body).modelId, "fishaudio-s21pro-flash");
});

test("international speech uses the documented API host, model header and reference ID", () => {
    const config = { endpoint: "international", apiBase: "https://fish.audio/", apiKey: "test-key", voiceId: "international-voice" };
    const request = FishAudio.buildRequest("Hello", { ...config, model: "s2.1-pro" });
    assert.equal(request.url, "https://api.fish.audio/v1/tts");
    assert.equal(request.headers.model, "s2.1-pro");
    assert.equal(request.headers.Authorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(request.body), { text: "Hello", reference_id: "international-voice", format: "mp3" });
    assert.equal(FishAudio.buildRequest("Hello", config).headers.model, "s2.1-pro-free");
});
