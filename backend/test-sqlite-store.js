"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { ConversationStore } = require("./sqlite-store");

function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-storage-test-"));
  const store = new ConversationStore(directory, options);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function conversation(id, count = 3) {
  return {
    id, title: `Conversation ${id}`, createdAt: "2026-09-16T00:00:00Z", updatedAt: "2026-09-16T00:00:00Z",
    messages: Array.from({ length: count }, (_, n) => ({
      id: `${id}-${n}`, role: n % 2 ? "assistant" : "user", status: "completed", text: `message ${n}`,
    })),
  };
}

function unload(store) {
  store.cache.clear(); store.cacheAccess.clear(); store.cacheSizes.clear();
}

test("unchanged saves do not update SQLite rows; in-place edits only change one message", (t) => {
  const store = fixture(t);
  const value = conversation("a", 100);
  store.save(value, { immediate: true });
  const changes = () => store.db.prepare("SELECT total_changes() AS n").get().n;
  const before = changes();
  store.save(value, { immediate: true });
  assert.equal(changes(), before);
  value.messages[42].text = "changed in place";
  store.save(value, { immediate: true });
  assert.equal(changes() - before, 1);
  unload(store);
  assert.equal(store.load("a").messages[42].text, "changed in place");
});

test("deletion and reordering persist correctly", (t) => {
  const store = fixture(t);
  const value = conversation("a", 5);
  store.save(value, { immediate: true });
  value.messages = [value.messages[4], value.messages[1]];
  store.save(value, { immediate: true });
  unload(store);
  assert.deepEqual(store.load("a").messages.map((item) => item.id), ["a-4", "a-1"]);
});

test("metadata and paging avoid full historical message loading and do not pollute cache", (t) => {
  const store = fixture(t);
  const value = conversation("a", 120);
  value.messages[20].attachments = [{ name: "report.pdf" }];
  store.save(value, { immediate: true });
  unload(store);
  store.selectMessages = { all() { throw new Error("must not load all messages"); } };
  const [metadata] = store.listMetadata();
  assert.equal(metadata.messages, undefined);
  assert.equal(metadata._storageSummary, undefined);
  assert.equal(metadata.totalMessages, 120);
  assert.equal(metadata.hasAttachments, true);
  const page = store.loadPage("a", { limit: 20 });
  assert.equal(page.messageOffset, 100);
  assert.equal(page.hasMore, true);
  assert.equal(page.messages.length, 20);
  assert.equal(page.messages[0].id, "a-100");
  const previous = store.loadPage("a", { before: page.messageOffset, limit: 100 });
  assert.equal(previous.messageOffset, 0);
  assert.equal(previous.hasMore, false);
  assert.equal(previous.messages.at(-1).id, "a-99");
  assert.equal(store.cache.size, 0);
});

test("legacy metadata reads safely without altering existing database records", (t) => {
  const store = fixture(t);
  const value = conversation("a");
  value.messages[1].status = "running";
  store.save(value, { immediate: true });
  unload(store);
  const raw = JSON.parse(store.selectConversation.get("a").payload_json);
  delete raw._storageSummary;
  store.db.prepare("UPDATE conversations SET payload_json = ? WHERE id = ?").run(JSON.stringify(raw), "a");
  const result = store.listMetadata()[0];
  assert.equal(result.busy, true);
  assert.equal(result.lastAssistantStatus, "running");
  assert.equal(result.totalMessages, 3);
  assert.equal(result.lastMessage, "message 2");
  assert.equal(JSON.parse(store.selectConversation.get("a").payload_json)._storageSummary, undefined);
});

test("cache bounds flush unsaved inactive edits but protect active and pending objects", (t) => {
  const store = fixture(t, { maxCachedConversations: 1 });
  const active = conversation("active");
  active.messages[1].status = "running";
  store.save(active, { immediate: true });
  const pending = conversation("pending");
  store.save(pending);
  const inactive = conversation("inactive");
  store.save(inactive, { immediate: true });
  inactive.messages[0].text = "unsaved mutation";
  store.save(conversation("new"), { immediate: true });
  assert.equal(store.cache.has("inactive"), false);
  assert.equal(store.cache.get("active"), active);
  assert.equal(store.cache.get("pending"), pending);
  assert.equal(store.loadPage("inactive").messages[0].text, "unsaved mutation");
});

test("pending live state is authoritative for list, pages and search", (t) => {
  const store = fixture(t);
  const value = conversation("a");
  store.save(value, { immediate: true });
  value.messages.push({ id: "a-new", role: "assistant", status: "running", text: "玄遇新增结果", artifacts: [{ id: "file" }] });
  store.save(value);
  assert.equal(store.listMetadata()[0].totalMessages, 4);
  assert.equal(store.listMetadata()[0].busy, true);
  assert.equal(store.loadPage("a", { limit: 1 }).messages[0].id, "a-new");
  assert.equal(store.search("玄遇", { attachmentsOnly: true })[0].matchingMessageId, "a-new");
  value.messages[0].text = "renamed";
  assert.equal(store.search("message 0").length, 0);
});

test("search matches stored history literally and filters attachments", (t) => {
  const store = fixture(t);
  const a = conversation("a");
  a.messages[0].text = "a literal 100%_ query with 中文";
  a.messages[0].attachments = [{ name: "file.txt" }];
  store.save(a, { immediate: true });
  store.save(conversation("b"), { immediate: true });
  unload(store);
  assert.equal(store.search("100%_")[0].id, "a");
  assert.equal(store.search("中文")[0].matchingMessageId, "a-0");
  assert.equal(store.search("Conversation b")[0].id, "b");
  assert.deepEqual(store.search("", { attachmentsOnly: true }).map((item) => item.id), ["a"]);
});

test("invalid pagination values are bounded", (t) => {
  const store = fixture(t);
  store.save(conversation("a", 150), { immediate: true });
  assert.equal(store.loadPage("a", { limit: 100000 }).messages.length, 100);
  assert.equal(store.loadPage("a", { before: -10 }).messages.length, 0);
  assert.equal(store.loadPage("missing"), null);
});

test("idle cache release preserves unsaved edits; failed flush never evicts", (t) => {
  const store = fixture(t, { cacheIdleMs: 1000 });
  const value = conversation("a");
  store.save(value, { immediate: true });
  value.messages[0].text = "edited while idle";
  store.cacheAccess.set("a", Date.now() - 2000);
  const persist = store.persist.bind(store);
  store.persist = () => { throw new Error("simulated full disk"); };
  store.pruneCache();
  assert.equal(store.cache.get("a"), value);
  store.persist = persist;
  store.pruneCache();
  assert.equal(store.cache.size, 0);
  assert.equal(store.loadPage("a").messages[0].text, "edited while idle");
});

test("message lookup respects unpersisted removals and task summaries survive cold reads", (t) => {
  const store = fixture(t);
  const value = conversation("a");
  value.messages[1].status = "running";
  value.messages[1].stream = [{ kind: "approval", status: "pending" }];
  store.save(value, { immediate: true });
  assert.equal(store.findConversationIdByMessageId("a-1"), "a");
  unload(store);
  assert.equal(store.findConversationIdByMessageId("a-1"), "a");
  assert.equal(store.listMetadata()[0].lastAssistantStatus, "running");
  assert.equal(store.listMetadata()[0].awaitingConfirmation, true);
  const cached = store.load("a");
  cached.messages = cached.messages.filter((message) => message.id !== "a-1");
  assert.equal(store.findConversationIdByMessageId("a-1"), null);
});
