(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.FishAudio = factory();
})(globalThis, function () {
    const bases = {
        domestic: "https://fishaudio.org",
        international: "https://api.fish.audio"
    };
    const defaultModel = "s2.1-pro-free";
    const allModels = [
        [defaultModel, "S2.1 Pro (Free)", "fishaudio-s21pro-free"],
        ["s2.1-pro", "S2.1 Pro", "fishaudio-s21pro"],
        ["s2.1-pro-flash", "S2.1 Pro Flash", "fishaudio-s21pro-flash"],
        ["s2.1-flash", "S2.1 Flash", "fishaudio-s21-flash"],
        ["s2-pro", "S2 Pro", "fishaudio-s2pro"],
        ["s1", "S1", "fishaudio-s1"],
        ["drama-3", "Drama 3"]
    ];

    function endpointFor(endpoint, base) {
        if (endpoint === "domestic" || endpoint === "international") return endpoint;
        try {
            const hostname = new URL(base).hostname;
            if (hostname === "fish.audio" || hostname === "api.fish.audio") return "international";
        } catch {}
        return "domestic";
    }

    function modelsFor(endpoint) {
        return allModels.filter(([id, , domesticId]) => endpoint === "domestic" ? domesticId : !id.endsWith("-flash"));
    }

    function normalizeConfig(config = {}) {
        const endpoint = endpointFor(config.endpoint, config.apiBase);
        let apiBase = String(config.apiBase || "").trim().replace(/\/+$/, "");
        if (!apiBase || /^https?:\/\/(?:www\.)?fish\.audio$/i.test(apiBase)) apiBase = bases[endpoint];
        const model = modelsFor(endpoint).find(([id]) => id === config.model)?.[0] || defaultModel;
        return { endpoint, apiBase, model, apiKey: String(config.apiKey || "").trim(), voiceId: String(config.voiceId || "").trim() };
    }

    function buildRequest(text, input) {
        const config = normalizeConfig(input);
        const { endpoint, apiBase, apiKey, voiceId, model } = config;
        if (!apiKey || !voiceId) throw new Error("请先填写 Fish Audio API Key 和音色 ID");
        const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
        if (endpoint === "international") {
            headers.model = model;
            const base = apiBase.replace(/\/v1$/i, "");
            return { url: `${base}/v1/tts`, headers, body: JSON.stringify({ text, reference_id: voiceId, format: "mp3" }) };
        }
        const [, , modelId] = modelsFor(endpoint).find(([id]) => id === model);
        return {
            url: `${apiBase}/api/open/v1/speech/tts`,
            headers,
            body: JSON.stringify({ text, voiceId, modelId, format: "mp3", speed: 1 })
        };
    }

    return { bases, defaultModel, endpointFor, modelsFor, normalizeConfig, buildRequest };
});
