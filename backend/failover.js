"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function claimStandby(directory = "/home/ubuntu/.local/state/witt-failover") {
  if (!fs.existsSync(path.join(directory, "standby"))) {
    return Promise.resolve({ status: 409, body: { error: "此服务器未配置为备用服务器" } });
  }
  return new Promise((resolve) => {
    // Serialize promotion with the snapshot installation, never with chat contents.
    const child = spawn("flock", ["-x", "-w", "20", path.join(directory, "sync.lock"),
      "touch", path.join(directory, "promoted")], { stdio: "ignore" });
    child.once("error", () => resolve({ status: 503, body: { error: "备用服务器接管失败" } }));
    child.once("close", (code) => resolve(code === 0
      ? { status: 200, body: { ok: true, promoted: true } }
      : { status: 503, body: { error: "正在完成同步，请稍后重连" } }));
  });
}
module.exports = { claimStandby };
