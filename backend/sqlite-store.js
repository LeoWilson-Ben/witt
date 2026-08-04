"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

class ConversationStore {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, "conversations.sqlite");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        position INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (conversation_id, id)
      );
      CREATE INDEX IF NOT EXISTS conversations_updated_idx
        ON conversations(updated_at DESC);
      CREATE INDEX IF NOT EXISTS messages_position_idx
        ON messages(conversation_id, position);
    `);
    this.selectConversation = this.db.prepare(
      "SELECT payload_json FROM conversations WHERE id = ?");
    this.selectMessages = this.db.prepare(
      "SELECT payload_json FROM messages WHERE conversation_id = ? ORDER BY position");
    this.selectIds = this.db.prepare("SELECT id FROM conversations ORDER BY updated_at DESC");
    this.selectMessageIds = this.db.prepare(
      "SELECT id FROM messages WHERE conversation_id = ?");
    this.upsertConversation = this.db.prepare(`
      INSERT INTO conversations (id, updated_at, payload_json) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,
        payload_json=excluded.payload_json`);
    this.upsertMessage = this.db.prepare(`
      INSERT INTO messages (conversation_id, id, position, payload_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id, id) DO UPDATE SET position=excluded.position,
        payload_json=excluded.payload_json`);
    this.deleteMessage = this.db.prepare(
      "DELETE FROM messages WHERE conversation_id = ? AND id = ?");
  }

  load(id) {
    const row = this.selectConversation.get(id);
    if (!row) return null;
    try {
      const conversation = JSON.parse(row.payload_json);
      conversation.messages = this.selectMessages.all(id)
        .map((message) => JSON.parse(message.payload_json));
      return conversation;
    } catch {
      return null;
    }
  }

  save(conversation) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const metadata = { ...conversation };
    delete metadata.messages;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.upsertConversation.run(conversation.id, conversation.updatedAt || "", JSON.stringify(metadata));
      const currentIds = new Set(messages.map((message) => message.id));
      for (const row of this.selectMessageIds.all(conversation.id)) {
        if (!currentIds.has(row.id)) this.deleteMessage.run(conversation.id, row.id);
      }
      messages.forEach((message, position) => {
        this.upsertMessage.run(conversation.id, message.id, position, JSON.stringify(message));
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  all() {
    return this.selectIds.all().map((row) => this.load(row.id)).filter(Boolean);
  }

  importJsonFiles() {
    if (this.selectIds.all().length) return 0;
    let imported = 0;
    for (const name of fs.readdirSync(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        this.save(JSON.parse(fs.readFileSync(path.join(this.directory, name), "utf8")));
        imported += 1;
      } catch {}
    }
    return imported;
  }
}

class AuthStore {
  constructor(directory) {
    this.file = path.join(directory, "auth.sqlite");
    this.db = new DatabaseSync(this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS auth_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
    this.select = this.db.prepare("SELECT payload_json FROM auth_state WHERE singleton = 1");
    this.upsert = this.db.prepare(`
      INSERT INTO auth_state (singleton, updated_at, payload_json) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET updated_at=excluded.updated_at,
        payload_json=excluded.payload_json`);
  }

  load() {
    const row = this.select.get();
    if (!row) return null;
    try { return JSON.parse(row.payload_json); } catch { return null; }
  }

  save(value) {
    this.upsert.run(new Date().toISOString(), JSON.stringify(value));
  }
}

module.exports = { AuthStore, ConversationStore };
