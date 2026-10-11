"use strict";
const MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
function executionPolicy(administrator, conversation = {}) {
  if (!administrator) return {
    sandbox: conversation.accessMode === "read-only" ? "read-only" : "workspace-write",
    approvalPolicy: "never",
  };
  return { sandbox: MODES.has(conversation.accessMode) ? conversation.accessMode : "danger-full-access",
    approvalPolicy: "on-request" };
}
module.exports = { executionPolicy };
