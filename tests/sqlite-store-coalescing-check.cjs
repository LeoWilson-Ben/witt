"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConversationStore } = require("../backend/sqlite-store");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-store-check-"));
const store = new ConversationStore(directory);
let writes = 0;
const persist = store.persist.bind(store);
store.persist = (conversation) => {
  writes += 1;
  persist(conversation);
};

const conversation = {
  id: "00000000-0000-0000-0000-000000000001",
  updatedAt: new Date().toISOString(),
  messages: [{ id: "message-1", text: "first" }],
};

store.save(conversation);
conversation.messages[0].text = "latest";
store.save(conversation);
assert.equal(store.load(conversation.id).messages[0].text, "latest");

setTimeout(() => {
  assert.equal(writes, 1, "bursty saves should be coalesced into one SQLite transaction");
  const reopened = new ConversationStore(directory).load(conversation.id);
  assert.equal(reopened.messages[0].text, "latest");
  console.log("sqlite store coalescing check passed");
}, 1_200);
