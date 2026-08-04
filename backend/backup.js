"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");

const sourceRoot = path.resolve(process.env.DROP_VAULT_ROOT || "/data/drop-vault");
const backupRoot = path.resolve(process.env.DROP_VAULT_BACKUP_ROOT ||
  path.join(sourceRoot, "backups", "snapshots"));

function digest(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}

function walk(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (absolute === path.join(sourceRoot, "backups")) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(absolute, output);
    else if (entry.isFile() && !/-(wal|shm)$/.test(entry.name)) output.push(absolute);
  }
  return output;
}

async function createBackup() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const destination = path.join(backupRoot, timestamp);
  const payloadRoot = path.join(destination, "data");
  fs.mkdirSync(payloadRoot, { recursive: true, mode: 0o700 });
  const manifest = { version: 1, createdAt: new Date().toISOString(), sourceRoot, files: [] };

  for (const source of walk(sourceRoot)) {
    const relative = path.relative(sourceRoot, source);
    const target = path.join(payloadRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (source.endsWith(".sqlite")) {
      const database = new DatabaseSync(source, { readOnly: true });
      await backup(database, target);
      database.close();
      fs.chmodSync(target, 0o600);
    } else {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
    }
    const stat = fs.statSync(target);
    manifest.files.push({ path: relative, size: stat.size, sha256: digest(target) });
  }
  fs.writeFileSync(path.join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(destination, "COMPLETE"), `${manifest.createdAt}\n`, { mode: 0o600 });
  process.stdout.write(`${destination}\n`);
}

function verifyBackup(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  for (const entry of manifest.files) {
    const file = path.join(directory, "data", entry.path);
    const stat = fs.statSync(file);
    if (stat.size !== entry.size || digest(file) !== entry.sha256) {
      throw new Error(`backup verification failed: ${entry.path}`);
    }
  }
  process.stdout.write(`verified ${manifest.files.length} files\n`);
}

if (process.argv[2] === "verify") verifyBackup(path.resolve(process.argv[3] || ""));
else createBackup().catch((error) => { console.error(error.message); process.exitCode = 1; });
