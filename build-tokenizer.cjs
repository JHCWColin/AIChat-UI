const fs = require("fs/promises");
const path = require("path");
const esbuild = require("esbuild");
const { gunzipSync } = require("zlib");
const { createHash } = require("crypto");

const root = __dirname;

async function build() {
    const assetRoot = path.join(root, "tokenizer-assets");
    const manifest = JSON.parse(await fs.readFile(path.join(assetRoot, "manifest.json"), "utf8"));
    for (const family of ["deepseek-v4", "deepseek-v41"]) {
        const data = gunzipSync(await fs.readFile(path.join(assetRoot, `${family}.json.gz`)));
        const sha256 = createHash("sha256").update(data).digest("hex");
        if (sha256 !== manifest[family]?.sha256) throw new Error(`Tokenizer asset integrity check failed: ${family}`);
    }
    await esbuild.build({
        entryPoints: [path.join(root, "tokenizer-entry.js")],
        bundle: true,
        minify: true,
        legalComments: "none",
        platform: "node",
        format: "cjs",
        target: "node22",
        outfile: path.join(root, "tokenizer-runtime.cjs")
    });
    await fs.copyFile(
        require.resolve("tiktoken/lite/tiktoken_bg.wasm"),
        path.join(root, "tiktoken_bg.wasm")
    );
}

build().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
