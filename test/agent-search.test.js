const test = require("node:test");
const assert = require("node:assert/strict");
const AgentSearch = require("../agent-search");

test("normalizes engine names and falls back to the default", () => {
    assert.equal(AgentSearch.normalizeEngine("bing"), "bing");
    assert.equal(AgentSearch.normalizeEngine("Bing"), "bing");
    assert.equal(AgentSearch.normalizeEngine("duckduckgo"), "duckduckgo");
    assert.equal(AgentSearch.normalizeEngine("ddg"), "duckduckgo");
    assert.equal(AgentSearch.normalizeEngine(""), "bing");
    assert.equal(AgentSearch.normalizeEngine("unknown-engine"), "bing");
});

test("clamps the result limit into the supported range", () => {
    assert.equal(AgentSearch.normalizeLimit(undefined), AgentSearch.DEFAULT_RESULT_LIMIT);
    assert.equal(AgentSearch.normalizeLimit(0), AgentSearch.DEFAULT_RESULT_LIMIT);
    assert.equal(AgentSearch.normalizeLimit(-4), AgentSearch.DEFAULT_RESULT_LIMIT);
    assert.equal(AgentSearch.normalizeLimit(3), 3);
    assert.equal(AgentSearch.normalizeLimit(999), AgentSearch.MAX_RESULT_LIMIT);
});

test("builds keyless search URLs for each engine", () => {
    const bing = AgentSearch.buildSearchUrl("bing", "electron agent 工具");
    assert.match(bing, /^https:\/\/www\.bing\.com\/search\?/);
    assert.match(bing, /q=electron%20agent%20%E5%B7%A5%E5%85%B7/);

    const ddg = AgentSearch.buildSearchUrl("duckduckgo", "electron agent");
    assert.match(ddg, /^https:\/\/html\.duckduckgo\.com\/html\/\?q=/);
});

test("encodes the query so operators and unicode survive the round trip", () => {
    const url = AgentSearch.buildSearchUrl("bing", 'site:example.com "a & b"');
    const query = new URL(url).searchParams.get("q");
    assert.equal(query, 'site:example.com "a & b"');
});

test("decodes Bing redirect links back to the destination URL", () => {
    const target = "https://example.com/page?x=1";
    const encoded = Buffer.from(target, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const wrapped = `https://www.bing.com/ck/a?!&&p=abc&u=a1${encoded}&ntb=1`;
    assert.equal(AgentSearch.decodeBingRedirect(wrapped), target);
    // Plain links and undecodable payloads pass through unchanged.
    assert.equal(AgentSearch.decodeBingRedirect("https://example.com/plain"), "https://example.com/plain");
    assert.equal(AgentSearch.decodeBingRedirect("https://www.bing.com/ck/a?u=a1!!!!"), "https://www.bing.com/ck/a?u=a1!!!!");
});

test("parses Bing HTML results with titles, URLs, and snippets", () => {
    const html = `
        <ol id="b_results">
          <li class="b_algo"><h2><a href="https://example.com/one">First &amp; Result</a></h2>
            <div class="b_caption"><p class="b_lineclamp4">Snippet for the <b>first</b> result.</p></div></li>
          <li class="b_algo"><h2><a href="https://example.com/two">Second Result</a></h2>
            <p>Another snippet.</p></li>
        </ol>`;
    const results = AgentSearch.parseBingHtml(html, 5);
    assert.equal(results.length, 2);
    assert.equal(results[0].title, "First & Result");
    assert.equal(results[0].url, "https://example.com/one");
    assert.equal(results[0].snippet, "Snippet for the first result.");
    assert.equal(results[0].engine, "bing");
    assert.equal(results[1].url, "https://example.com/two");
});

test("parses DuckDuckGo HTML results", () => {
    const html = `
        <div class="result results_links">
          <h2 class="result__title"><a class="result__a" href="https://example.org/a">Alpha</a></h2>
          <a class="result__snippet" href="https://example.org/a">Alpha snippet text</a>
        </div>`;
    const results = AgentSearch.parseDuckDuckGoHtml(html, 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Alpha");
    assert.equal(results[0].url, "https://example.org/a");
    assert.equal(results[0].snippet, "Alpha snippet text");
    assert.equal(results[0].engine, "duckduckgo");
});

test("filters engine-internal and duplicate links from results", () => {
    const html = `
      <li class="b_algo"><h2><a href="https://www.bing.com/search?q=other">Bing internal</a></h2></li>
      <li class="b_algo"><h2><a href="https://example.com/dup">Dup</a></h2></li>
      <li class="b_algo"><h2><a href="https://example.com/dup">Dup again</a></h2></li>`;
    const results = AgentSearch.parseBingHtml(html, 5);
    assert.deepEqual(results.map(r => r.url), ["https://example.com/dup"]);
});

test("respects the requested result limit while parsing", () => {
    const blocks = Array.from({ length: 8 }, (_, index) =>
        `<li class="b_algo"><h2><a href="https://example.com/${index}">R${index}</a></h2></li>`).join("");
    assert.equal(AgentSearch.parseBingHtml(blocks, 3).length, 3);
    assert.equal(AgentSearch.parseBingHtml(blocks, 99).length, 8);
});

test("maps the official Bing API response onto result entries", () => {
    const payload = {
        webPages: {
            value: [
                { name: "API One", url: "https://api.example.com/1", snippet: "first" },
                { name: "API Two", url: "https://api.example.com/2", snippet: "second" }
            ]
        }
    };
    const results = AgentSearch.parseBingApiResponse(payload, 5);
    assert.equal(results.length, 2);
    assert.equal(results[0].title, "API One");
    assert.equal(results[0].url, "https://api.example.com/1");
    assert.equal(results[0].snippet, "first");
    assert.equal(results[0].engine, "bing");
    // A response with no web pages must not throw.
    assert.deepEqual(AgentSearch.parseBingApiResponse({}, 5), []);
    assert.deepEqual(AgentSearch.parseBingApiResponse(null, 5), []);
});

test("builds the official Bing API URL with key-free parameters only", () => {
    const url = AgentSearch.buildApiSearchUrl("agent tools", { limit: 4 });
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.bing.microsoft.com");
    assert.equal(parsed.searchParams.get("q"), "agent tools");
    assert.equal(parsed.searchParams.get("count"), "4");
});

test("parses an empty or malformed page without throwing", () => {
    assert.deepEqual(AgentSearch.parseBingHtml("", 5), []);
    assert.deepEqual(AgentSearch.parseDuckDuckGoHtml("", 5), []);
    assert.deepEqual(AgentSearch.parseSearchHtml("bing", "<html>no results</html>", 5), []);
});