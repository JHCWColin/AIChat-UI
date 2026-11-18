/**
 * Web search adapters for the Agent `web_search` tool.
 *
 * Two engines are supported without any API key by parsing the public HTML
 * endpoints, and Bing additionally supports its official JSON API when the user
 * supplies a subscription key. Parsing lives here (not in main.js) so it can be
 * unit-tested without launching Electron.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.AgentSearch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const SEARCH_ENGINES = [
        { id: "bing", label: "Bing", supportsApiKey: true },
        { id: "duckduckgo", label: "DuckDuckGo", supportsApiKey: false }
    ];
    const DEFAULT_SEARCH_ENGINE = "bing";
    const DEFAULT_RESULT_LIMIT = 5;
    const MAX_RESULT_LIMIT = 10;

    const HTML_ENTITIES = {
        amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
        "#39": "'", "#34": '"', "#x27": "'", "#x2F": "/"
    };

    function decodeHtmlEntities(value) {
        return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
            const key = entity.toLowerCase();
            if (Object.prototype.hasOwnProperty.call(HTML_ENTITIES, key)) return HTML_ENTITIES[key];
            if (key.startsWith("#x")) {
                const code = parseInt(key.slice(2), 16);
                return Number.isFinite(code) ? String.fromCodePoint(code) : match;
            }
            if (key.startsWith("#")) {
                const code = parseInt(key.slice(1), 10);
                return Number.isFinite(code) ? String.fromCodePoint(code) : match;
            }
            return match;
        });
    }

    function stripTags(value) {
        return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    }

    function normalizeEngine(value) {
        const key = String(value || "").trim().toLowerCase();
        if (!key) return DEFAULT_SEARCH_ENGINE;
        const aliases = {
            bing: "bing", "bing-search": "bing", biying: "bing",
            ddg: "duckduckgo", duck: "duckduckgo", "duck-duck-go": "duckduckgo", duckduckgo: "duckduckgo"
        };
        if (aliases[key]) return aliases[key];
        const direct = SEARCH_ENGINES.find(engine => engine.id === key);
        return direct ? direct.id : DEFAULT_SEARCH_ENGINE;
    }

    function normalizeLimit(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESULT_LIMIT;
        return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.round(parsed)));
    }

    function buildSearchUrl(engine, query, options = {}) {
        const text = String(query || "").trim();
        const encoded = encodeURIComponent(text);
        if (normalizeEngine(engine) === "duckduckgo") {
            return `https://html.duckduckgo.com/html/?q=${encoded}`;
        }
        const params = [`q=${encoded}`];
        const market = String(options.market || "").trim();
        if (market) params.push(`mkt=${encodeURIComponent(market)}`);
        if (options.setLanguage !== false) params.push(`setlang=${encodeURIComponent(String(options.language || "zh-CN"))}`);
        return `https://www.bing.com/search?${params.join("&")}`;
    }

    function buildApiSearchUrl(query, options = {}) {
        const params = [
            `q=${encodeURIComponent(String(query || "").trim())}`,
            `count=${normalizeLimit(options.limit)}`,
            "responseFilter=Webpages"
        ];
        const market = String(options.market || "").trim();
        if (market) params.push(`mkt=${encodeURIComponent(market)}`);
        return `https://api.bing.microsoft.com/v7.0/search?${params.join("&")}`;
    }

    /**
     * Bing wraps outbound links as /ck/a?...&u=a1<base64url>. Decode them back to
     * the real destination so the model can fetch the page with browse_web.
     */
    function decodeBingRedirect(href) {
        const url = String(href || "").trim();
        if (!url) return "";
        if (!/^https?:\/\/(?:www\.)?bing\.com\/ck\/a/i.test(url)) return url;
        const match = url.match(/[?&]u=a1([^&]+)/i);
        if (!match) return url;
        try {
            const padded = match[1].replace(/-/g, "+").replace(/_/g, "/");
            const decoded = Buffer.from(padded, "base64").toString("utf8");
            return /^https?:\/\//i.test(decoded) ? decoded : url;
        } catch {
            return url;
        }
    }

    function absolutize(href, base) {
        const url = decodeBingRedirect(decodeHtmlEntities(href)).trim();
        if (!url) return "";
        if (/^https?:\/\//i.test(url)) return url;
        if (url.startsWith("//")) return `https:${url}`;
        try {
            return new URL(url, base).toString();
        } catch {
            return "";
        }
    }

    function isNoiseUrl(url) {
        if (!url) return true;
        return /^https?:\/\/(?:www\.)?bing\.com\/(?:ck\/a|search|images|videos|maps|account|rewards)/i.test(url)
            || /^https?:\/\/duckduckgo\.com/i.test(url)
            || /^https?:\/\/(?:www\.)?microsoft\.com\/(?:en-us\/)?bing/i.test(url)
            || /javascript:/i.test(url);
    }

    function pushResult(results, seen, entry, limit) {
        if (results.length >= limit) return false;
        const url = String(entry.url || "").trim();
        if (!url || isNoiseUrl(url) || seen.has(url)) return true;
        const title = stripTags(entry.title) || url;
        seen.add(url);
        results.push({
            title,
            url,
            snippet: stripTags(entry.snippet || "").slice(0, 400),
            engine: entry.engine || ""
        });
        return true;
    }

    /** Bing HTML results live in <li class="b_algo"> blocks with an <h2><a> title. */
    function parseBingHtml(html, limit = DEFAULT_RESULT_LIMIT) {
        const max = normalizeLimit(limit);
        const results = [];
        const seen = new Set();
        const blocks = String(html || "").split(/<li[^>]+class="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1);
        for (const block of blocks) {
            if (results.length >= max) break;
            const anchor = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
                || block.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
            if (!anchor) continue;
            const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
                || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
                || block.match(/<div[^>]+class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
            pushResult(results, seen, {
                title: anchor[2],
                url: absolutize(anchor[1], "https://www.bing.com"),
                snippet: snippetMatch ? snippetMatch[1] : "",
                engine: "bing"
            }, max);
        }
        return results;
    }

    /** DuckDuckGo HTML results use anchors carrying the result__a class. */
    function parseDuckDuckGoHtml(html, limit = DEFAULT_RESULT_LIMIT) {
        const max = normalizeLimit(limit);
        const results = [];
        const seen = new Set();
        const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|<\/div>\s*<\/div>\s*<\/div>|$)/gi;
        let match;
        while ((match = pattern.exec(String(html || "")))) {
            if (results.length >= max) break;
            const snippetMatch = match[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
            pushResult(results, seen, {
                title: match[2],
                url: absolutize(match[1], "https://duckduckgo.com"),
                snippet: snippetMatch ? snippetMatch[1] : "",
                engine: "duckduckgo"
            }, max);
        }
        return results;
    }

    function parseSearchHtml(engine, html, limit) {
        return normalizeEngine(engine) === "duckduckgo"
            ? parseDuckDuckGoHtml(html, limit)
            : parseBingHtml(html, limit);
    }

    /** Map the official Bing Web Search API JSON response onto our result shape. */
    function parseBingApiResponse(payload, limit = DEFAULT_RESULT_LIMIT) {
        const max = normalizeLimit(limit);
        const results = [];
        const seen = new Set();
        const pages = payload?.webPages?.value;
        for (const page of Array.isArray(pages) ? pages : []) {
            if (results.length >= max) break;
            pushResult(results, seen, {
                title: page?.name,
                url: page?.url,
                snippet: page?.snippet,
                engine: "bing"
            }, max);
        }
        return results;
    }

    return {
        SEARCH_ENGINES,
        DEFAULT_SEARCH_ENGINE,
        DEFAULT_RESULT_LIMIT,
        MAX_RESULT_LIMIT,
        decodeHtmlEntities,
        stripTags,
        normalizeEngine,
        normalizeLimit,
        buildSearchUrl,
        buildApiSearchUrl,
        decodeBingRedirect,
        parseBingHtml,
        parseDuckDuckGoHtml,
        parseSearchHtml,
        parseBingApiResponse
    };
});