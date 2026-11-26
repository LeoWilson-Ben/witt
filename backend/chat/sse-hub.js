"use strict";

class ConversationSseHub {
  constructor(service) {
    this.service = service;
    this.subscribers = new Map();
    this.broadcasts = new Map();
  }

  scheduleConversationEvent(conversationId) {
    if (!this.subscribers.get(conversationId)?.size ||
        this.broadcasts.has(conversationId)) return;
    const timer = setTimeout(() => {
      this.broadcasts.delete(conversationId);
      const conversation = this.service.readConversation(conversationId);
      if (!conversation || conversation.archived) return;
      this.broadcastConversationEvent(
        conversationId, "delta", this.service.publicConversationDelta(conversation));
    }, 180);
    timer.unref();
    this.broadcasts.set(conversationId, timer);
  }

  writeConversationEvent(res, event, payload) {
    if (res.destroyed || res.writableEnded) return false;
    if (res.writableLength > 1024 * 1024) {
      res.destroy();
      return false;
    }
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  broadcastConversationEvent(conversationId, event, payload) {
    const subscribers = this.subscribers.get(conversationId);
    if (!subscribers) return;
    for (const subscriber of [...subscribers]) {
      if (!this.writeConversationEvent(subscriber.res, event, payload)) {
        subscriber.close();
      }
    }
  }

  subscribeConversation(req, res, conversationId, limit = null) {
    const conversation = limit === "latest" ? this.service.store.loadLatest(conversationId)
      : limit === null ? this.service.readConversation(conversationId)
        : this.service.store.loadPage(conversationId, { limit });
    if (!conversation || conversation.archived) {
      this.service.sendJson(res, 404, { error: "对话不存在" });
      return;
    }
    res.writeHead(200, {
      "Cache-Control": "no-store, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    res.flushHeaders?.();
    res.write("retry: 1500\n\n");

    const subscribers = this.subscribers.get(conversationId) || new Set();
    this.subscribers.set(conversationId, subscribers);
    let closed = false;
    const subscriber = {
      res,
      close: () => {
        if (closed) return;
        closed = true;
        clearInterval(subscriber.heartbeat);
        subscribers.delete(subscriber);
        if (!subscribers.size) this.subscribers.delete(conversationId);
        if (!res.writableEnded) res.end();
      },
    };
    subscriber.heartbeat = setInterval(() => {
      if (res.destroyed || res.writableEnded) subscriber.close();
      else res.write(": keep-alive\n\n");
    }, 25_000);
    subscriber.heartbeat.unref();
    subscribers.add(subscriber);
    req.on("aborted", subscriber.close);
    req.on("close", subscriber.close);
    res.on("close", subscriber.close);
    this.writeConversationEvent(res, "snapshot", {
      conversation: this.service.publicConversation(conversation),
    });
  }
}

module.exports = { ConversationSseHub };
