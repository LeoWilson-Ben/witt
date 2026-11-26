"use strict";

const crypto = require("node:crypto");
const { AppServerClient } = require("../app-server-client");

class UsageService {
  constructor(service, { quotaExhaustedMessage = "Your quota has been exhausted. Please try again later." } = {}) {
    this.service = service;
    this.quotaExhaustedMessage = quotaExhaustedMessage;
  }

  async readAccountUsage(res, conversationId = null) {
    const providerConversation = conversationId && this.service.readConversation(conversationId);
    if (providerConversation && this.service.profileFor(providerConversation).provider) {
      const profile = this.service.profileFor(providerConversation);
      if (!this.service.profileAllowed(providerConversation)) {
        this.service.sendJson(res, 403, { error: "这个账号不可用" });
        return;
      }
      try {
        this.service.sendJson(res, 200, await this.service.providerRuntime.usage(profile));
      } catch {
        this.service.sendJson(res, 200, {
          provider: profile.provider,
          codexProfile: profile.id,
          quota: { available: false, groups: [], message: "暂时无法读取该账号额度，请稍后刷新" },
          rateLimits: null,
        });
      }
      return;
    }
    if (this.service.readConversation(conversationId)) this.service.lastUsageConversationId = conversationId;
    if (this.service.quotaExhausted) {
      this.service.sendJson(res, 200, this.withConversationUsage({
        summary: {
          lifetimeTokens: 0, peakDailyTokens: 0, longestRunningTurnSec: 0,
          currentStreakDays: 0, longestStreakDays: 0,
        },
        dailyUsageBuckets: [],
        rateLimits: {
          planType: "",
          primary: { usedPercent: 100, windowDurationMins: 0, resetsAt: 0 },
          secondary: null,
          resetCredits: 0,
        },
      }, conversationId));
      return;
    }
    const conversation = this.service.readConversation(conversationId);
    const storedProfile = this.service.profileFor(conversation);
    const profile = this.service.allowedCodexProfiles.has(storedProfile.id)
      ? storedProfile : this.service.codexProfiles[this.service.defaultCodexProfile];
    const usageCache = this.service.usageCache.get(profile.id);
    if (usageCache && Date.now() - usageCache.cachedAt < 5 * 60 * 1000) {
      this.service.sendJson(res, 200, this.withConversationUsage(usageCache.payload, conversationId));
      return;
    }
    const client = new AppServerClient({
      codexBin: this.service.codexBin,
      cwd: profile.workDir,
      home: "/var/lib/witt",
      codexHome: profile.codexHome,
    });
    try {
      await client.start();
      const usage = await client.request("account/usage/read", {});
      const summary = usage?.summary || {};
      const rate = await client.request("account/rateLimits/read", {});
      const limits = rate?.rateLimitsByLimitId?.codex || rate?.rateLimits || {};
      const window = (value) => value ? {
        usedPercent: Math.max(0, Math.min(100, Number(value.usedPercent || 0))),
        windowDurationMins: Number(value.windowDurationMins || 0),
        resetsAt: Number(value.resetsAt || 0),
      } : null;
      const payload = {
        codexProfile: profile.id,
        summary: {
          lifetimeTokens: Number(summary.lifetimeTokens || 0),
          peakDailyTokens: Number(summary.peakDailyTokens || 0),
          longestRunningTurnSec: Number(summary.longestRunningTurnSec || 0),
          currentStreakDays: Number(summary.currentStreakDays || 0),
          longestStreakDays: Number(summary.longestStreakDays || 0),
        },
        dailyUsageBuckets: Array.isArray(usage?.dailyUsageBuckets)
          ? usage.dailyUsageBuckets
            .filter((bucket) => /^\d{4}-\d{2}-\d{2}$/.test(String(bucket?.startDate || "")))
            .map((bucket) => ({
              startDate: String(bucket.startDate),
              tokens: Math.max(0, Number(bucket.tokens || 0)),
            }))
          : [],
        rateLimits: {
          planType: String(limits.planType || ""),
          primary: window(limits.primary),
          secondary: window(limits.secondary),
          resetCredits: Math.max(0, Number(rate?.rateLimitResetCredits?.availableCount || 0)),
        },
      };
      this.service.usageCache.set(profile.id, { cachedAt: Date.now(), payload });
      this.service.sendJson(res, 200, this.withConversationUsage(payload, conversationId));
    } catch (error) {
      this.service.sendJson(res, 502, {
        error: `暂时无法读取 Token 用量：${String(error.message || error).slice(0, 160)}`,
      });
    } finally {
      client.close();
    }
  }

  withConversationUsage(payload, conversationId) {
    const conversation = this.service.readConversation(conversationId);
    return {
      ...payload,
      context: this.service.quotaExhausted ? { usedTokens: 1, contextWindow: 1 } :
        (conversation?.contextUsage?.source === "last-input" ? conversation.contextUsage : null),
    };
  }

  async consumeRateLimitReset(res, conversationId = null) {
    const providerConversation = conversationId && this.service.readConversation(conversationId);
    if (providerConversation && this.service.profileFor(providerConversation).provider) {
      this.service.sendJson(res, 400, { error: "这个账号不支持 Codex 额度重置" });
      return;
    }

    if (this.service.quotaExhausted) {
      this.service.sendJson(res, 429, { error: this.quotaExhaustedMessage });
      return;
    }
    const conversation = this.service.readConversation(conversationId || this.service.lastUsageConversationId);
    const storedProfile = this.service.profileFor(conversation);
    const profile = this.service.allowedCodexProfiles.has(storedProfile.id)
      ? storedProfile : this.service.codexProfiles[this.service.defaultCodexProfile];
    const client = new AppServerClient({
      codexBin: this.service.codexBin,
      cwd: profile.workDir,
      home: "/var/lib/witt",
      codexHome: profile.codexHome,
    });
    try {
      await client.start();
      const latestLimits = await client.request("account/rateLimits/read", {});
      const resetCredits = latestLimits?.rateLimitResetCredits;
      const availableCount = Math.max(0, Number(resetCredits?.availableCount || 0));
      if (!availableCount) {
        this.service.usageCache.delete(profile.id);
        this.service.sendJson(res, 409, {
          error: "该账号当前没有可用的重置额度，额度信息已刷新",
          code: "RATE_LIMIT_RESET_UNAVAILABLE",
        });
        return;
      }
      const availableCredit = Array.isArray(resetCredits?.credits)
        ? resetCredits.credits.find((credit) => credit?.status === "available" && credit?.id)
        : null;
      const params = { idempotencyKey: crypto.randomUUID() };
      if (availableCredit) params.creditId = String(availableCredit.id);
      const result = await client.request("account/rateLimitResetCredit/consume", params);
      this.service.usageCache.delete(profile.id);
      this.service.sendJson(res, 200, {
        outcome: String(result?.outcome || "noCredit"),
        codexProfile: profile.id,
      });
    } catch (error) {
      this.service.usageCache.delete(profile.id);
      const detail = String(error.message || error);
      if (/\b429\b|Too Many Requests/i.test(detail)) {
        this.service.sendJson(res, 409, {
          error: "重置额度状态已变化或兑换暂时受限，额度信息已刷新，请稍后再试",
          code: "RATE_LIMIT_RESET_REJECTED",
        });
      } else {
        this.service.sendJson(res, 502, { error: `无法使用重置额度：${detail.slice(0, 160)}` });
      }
    } finally {
      client.close();
    }
  }
}

module.exports = { UsageService };
