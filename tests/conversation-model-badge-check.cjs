"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// 1. Verify CSS rules exist in witt-interface bundle
const css = fs.readFileSync(path.join(__dirname, "../web/witt-interface-20261008.css"), "utf8");
assert.ok(css.includes(".conversation-model-badge"), "CSS must contain .conversation-model-badge");
assert.ok(css.includes(".model-gpt"), "CSS must contain .model-gpt rule");
assert.ok(css.includes(".model-claude"), "CSS must contain .model-claude rule");
assert.ok(css.includes(".model-gemini"), "CSS must contain .model-gemini rule");
assert.ok(css.includes(':root[data-theme="dark"] #drawer .conversation-model-badge.model-gpt'), "Dark mode GPT style present");
assert.ok(css.includes(':root[data-theme="dark"] #drawer .conversation-model-badge.model-claude'), "Dark mode Claude style present");
assert.ok(css.includes(':root[data-theme="dark"] #drawer .conversation-model-badge.model-gemini'), "Dark mode Gemini style present");

// 2. Extract conversationModelBadge from app-workspace-20260916-r3.js
const appJs = fs.readFileSync(path.join(__dirname, "../web/app-workspace-20260916-r3.js"), "utf8");
assert.ok(appJs.includes("function conversationModelBadge("), "app-workspace must define conversationModelBadge");

const fnMatch = appJs.match(/function conversationModelBadge\(item\) \{[\s\S]*?\n  \}/);
assert.ok(fnMatch, "conversationModelBadge function must be extractable");
const names = ["preservePendingModel", "modelSource", "modelDisplayName"];
const dependencies = names.map(name => {
  const match = appJs.match(new RegExp("function " + name + "\\([^]*?\\n  \\}"));
  assert.ok(match, name + " must be extractable");
  return match[0];
}).join("\n");
const state = { activeId: "active", model: "stellarbit:claude-sonnet", capabilities: { models: [] } };
const pendingModelSettings = new Map();
const badge = new Function("state", "pendingModelSettings", "modelNames", dependencies + "\n" + fnMatch[0] + "\nreturn conversationModelBadge;")(state, pendingModelSettings, {});
assert.deepEqual(badge({id:"gpt",model:"gpt-6.1-sol"}), {id:"gpt",label:"gpt-6.1-sol",source:"官方 GPT"});
assert.deepEqual(badge({id:"gemini",model:"gemini:gemini-3.8-flash"}), {id:"gemini",label:"gemini-3.8-flash",source:"反重力"});
assert.deepEqual(badge({id:"claude",model:"claude:sonnet"}), {id:"claude",label:"claude:sonnet",source:"Claude"});
assert.deepEqual(badge({id:"active",model:"gpt-old"}), {id:"stellarbit",label:"claude-sonnet",source:"Stellarbit"});
pendingModelSettings.set("pending", {model:"stellarbit:gpt-new",startedAt:Date.now()});
assert.equal(badge({id:"pending",model:"gpt-old"}).label,"gpt-new");
assert.deepEqual(badge({id:"fallback",provider:"antigravity"}), {id:"gemini",label:"Gemini"});

// 3. Verify app.js also has conversationModelBadge and markup
const legacyAppJs = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
assert.ok(legacyAppJs.includes("function conversationModelBadge("), "app.js must define conversationModelBadge");
assert.ok(legacyAppJs.includes("conversation-model-badge"), "app.js must render conversation-model-badge");

console.log("PASS conversation model badge check: GPT, Claude, and Gemini badges verified");
