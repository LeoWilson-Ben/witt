#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT_DIR, "web");
const WEB_APP_DIR = path.join(ROOT_DIR, "web-app");
const DIST_DIR = path.join(ROOT_DIR, "web-dist");
const NODE_BIN = process.execPath;
const NPM_BIN = path.join(path.dirname(NODE_BIN), "npm");
const PATH_ENV = `${path.dirname(NODE_BIN)}:${process.env.PATH || ""}`;

function run(cmd, args, cwd) {
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, PATH: PATH_ENV },
  });
}

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

console.log("==> 1. Building minified CSS bundles");
run(NODE_BIN, [path.join(ROOT_DIR, "scripts/build-web-css.js")], ROOT_DIR);

console.log("==> 2. Typechecking web-app (tsc --noEmit)");
run(NPM_BIN, ["run", "typecheck"], WEB_APP_DIR);

console.log("==> 3. Building Vite Preact bundle -> web-dist/");
run(NPM_BIN, ["run", "build"], WEB_APP_DIR);

console.log("==> 4. Copying runtime static assets into web-dist/");
const indexHtml = fs.readFileSync(path.join(WEB_DIR, "index.html"), "utf8");
const activeCss = new Set(
  (indexHtml.match(/\/vault\/[^"?]+\.css/g) || []).map((item) => item.slice("/vault/".length)),
);
activeCss.add("boot-w.css");

let copiedFiles = 0;
for (const entry of fs.readdirSync(WEB_DIR, { withFileTypes: true })) {
  const name = entry.name;
  if (name === "index.html" || name === "account-migration.js" || name === "update.example.json") continue;
  const src = path.join(WEB_DIR, name);
  const dst = path.join(DIST_DIR, name);
  if (entry.isDirectory()) {
    copyRecursive(src, dst);
    copiedFiles += 1;
    continue;
  }
  if (name.endsWith(".css") && !activeCss.has(name)) continue;
  fs.copyFileSync(src, dst);
  copiedFiles += 1;
}

const assetsDir = path.join(DIST_DIR, "assets");
const assetSummaries = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir).sort().map((file) => {
      const sizeKb = (fs.statSync(path.join(assetsDir, file)).size / 1024).toFixed(1);
      return `${file} (${sizeKb} KB)`;
    })
  : [];

console.log(`Copied ${copiedFiles} runtime assets into web-dist/`);
console.log(`Vite bundles: ${assetSummaries.join(", ")}`);
