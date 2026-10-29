"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
function latestTurn(conversation) {
  const messages = conversation.messages || [];
  const start = messages.findLastIndex((m) => m.role === "user" && !m.steeredInto);
  const offset = start >= 0 ? start : Math.max(0, messages.length - 1);
  return { ...conversation, messages: messages.slice(offset),
    messageOffset: (conversation.messageOffset || 0) + offset,
    totalMessages: conversation.totalMessages ?? messages.length,
    historyBefore: messages[offset]?.createdAt || conversation.createdAt || new Date().toISOString(),
  };
}
module.exports = { DAY_MS, latestTurn };
