#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const WEB_DIR = path.resolve(__dirname, "../web");

const OVERLAY_FILES = [
  "conversation-entry.css",
  "provider-accounts.css",
  "simplified-settings.css",
  "settings-glass.css",
  "quota-panel.css",
  "header-capsule.css",
  "xuanyu-build-panel.css",
  "web-desktop-adapt.css",
  "witt-features.css",
];

// Safe CSS minifier: strips comments and collapses non-semantic whitespace
// without touching string literals, data URIs, or calc() operators.
function minifyCss(source) {
  let out = "";
  let i = 0;
  const len = source.length;
  let quote = "";
  let inUrl = false;

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < len) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (inUrl) {
      out += ch;
      if (ch === ")") inUrl = false;
      i += 1;
      continue;
    }

    if ((ch === "u" || ch === "U") && /^url\(/i.test(source.slice(i, i + 4))) {
      inUrl = true;
      out += source.slice(i, i + 4);
      i += 4;
      continue;
    }

    if (/\s/.test(ch)) {
      while (i < len && /\s/.test(source[i])) i += 1;
      const prev = out[out.length - 1] || "";
      const after = source[i] || "";
      if (prev && after && !/[{}:;,>]/.test(prev) && !/[{};,>)]/.test(after) && prev !== "(") {
        out += " ";
      }
      continue;
    }

    if (ch === ";" && next === "}") {
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out.trim() + "\n";
}

function buildSingle(srcName, outName) {
  const raw = fs.readFileSync(path.join(WEB_DIR, srcName), "utf8");
  const min = minifyCss(raw);
  fs.writeFileSync(path.join(WEB_DIR, outName), min, "utf8");
  return { raw: Buffer.byteLength(raw), min: Buffer.byteLength(min) };
}

function buildOverlays(outName) {
  const parts = OVERLAY_FILES.map((name) => fs.readFileSync(path.join(WEB_DIR, name), "utf8"));
  const combined = parts.join("\n");
  const min = minifyCss(combined);
  fs.writeFileSync(path.join(WEB_DIR, outName), min, "utf8");
  return { raw: Buffer.byteLength(combined), min: Buffer.byteLength(min) };
}

const baseStats = buildSingle("witt-base-20261008.css", "witt-base-20261008.min.css");
const ifaceStats = buildSingle("witt-interface-20261008.css", "witt-interface-20261008.min.css");
const overlayStats = buildOverlays("witt-overlays.min.css");

const rawTotal = baseStats.raw + ifaceStats.raw + overlayStats.raw;
const minTotal = baseStats.min + ifaceStats.min + overlayStats.min;
const savedPct = Math.round(((rawTotal - minTotal) / rawTotal) * 100);

console.log(
  `Built 3 CSS bundles: ${(rawTotal / 1024).toFixed(1)} KB -> ${(minTotal / 1024).toFixed(1)} KB (-${savedPct}%)`,
);
