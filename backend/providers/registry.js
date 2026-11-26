"use strict";

const stellarbit = require("../stellarbit-models");
const { sharedAppServer } = require("../app-server-client");

const DEEPSEEK_MODELS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);
const ADMIN_MODELS = new Set([
  "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", ...DEEPSEEK_MODELS,
]);
const NON_ADMIN_MODELS = new Set(["gpt-5.5", ...DEEPSEEK_MODELS]);
const ALL_MODELS = new Set([...ADMIN_MODELS, ...NON_ADMIN_MODELS]);
const QUOTA_EXHAUSTED_MESSAGE = "Your quota has been exhausted. Please try again later.";
const ALLOWED_REASONING = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

class ProviderRegistry {
  constructor(service) {
    this.service = service;
  }

  clientFor(profile, model = this.service.defaultModel, conversation = null) {
    const deepseek = DEEPSEEK_MODELS.has(model);
    const stellar = stellarbit.models(this.service.providerRuntime?.owner).some((m) => m.id === model);
    const remote = this.service.activeRemoteRuntimeFor(conversation);
    const configOverrides = ["features.default_mode_request_user_input=true"];
    if (!this.service.serverAdministrator) {
      configOverrides.push(
        'sandbox_mode="workspace-write"',
        'approval_policy="never"',
        "sandbox_workspace_write.network_access=false",
        `sandbox_workspace_write.writable_roots=${JSON.stringify([
          this.service.userWorkspaceDir,
          this.service.projectsDir,
          this.service.dataDir,
        ])}`,
      );
    }
    if (remote?.runtime?.codexConfigOverrides?.length) {
      configOverrides.push(...remote.runtime.codexConfigOverrides);
    }
    if (deepseek) {
      configOverrides.push(
        'model_provider="witt-deepseek"',
        'model_providers.witt-deepseek.name="DeepSeek through Witt"',
        'model_providers.witt-deepseek.base_url="http://127.0.0.1:33111/v1"',
        'model_providers.witt-deepseek.wire_api="responses"',
        "model_providers.witt-deepseek.request_max_retries=1",
        "model_providers.witt-deepseek.stream_max_retries=2",
        "model_providers.witt-deepseek.stream_idle_timeout_ms=300000",
      );
    }
    if (stellar) {
      configOverrides.push(
        'model_provider="witt-stellarbit"',
        'model_providers.witt-stellarbit.name="Stellarbit"',
        'model_providers.witt-stellarbit.base_url="http://127.0.0.1:33112/v1"',
        'model_providers.witt-stellarbit.wire_api="responses"',
        "model_providers.witt-stellarbit.request_max_retries=0",
        "model_providers.witt-stellarbit.stream_max_retries=0",
      );
    }
    const clientScope = remote
      ? `${this.service.clientScope}:rw:${remote.binding.workspace_id}`
      : this.service.clientScope;
    const client = profile.provider && this.service.providerRuntime && !stellar
      ? this.service.providerRuntime.client(profile)
      : sharedAppServer({
        codexBin: this.service.codexBin,
        cwd: remote ? remote.runtime.cwd : profile.workDir,
        home: "/var/lib/witt",
        codexHome: stellar ? this.service.codexProfiles.default.codexHome : profile.codexHome,
        configOverrides,
        clientScope,
      });
    if (!this.service.boundClients.has(client)) {
      this.service.boundClients.add(client);
      client.on("notification", (method, params) => {
        const active = this.service.activeForEvent(client, params);
        if (!active || active.client !== client) return;
        this.service.handleNotification(active.conversationId, active.messageId, method, params);
      });
      client.on("request", (request) => {
        const active = this.service.activeForEvent(client, request.params);
        if (!active || active.client !== client) {
          try { client.respond(request.id, { decision: "decline" }); } catch {}
          return;
        }
        this.service.handleServerRequest(active.conversationId, active.messageId, request);
      });
      client.on("closed", ({ stderr }) => {
        for (const active of [...this.service.activeTurns.values()]) {
          if (active.client === client && !active.finished) {
            this.service.failActive(stderr.trim().slice(-1200) || "Codex 服务意外停止", active.conversationId);
          }
        }
      });
      client.on("notification", (method) => {
        if (method === "skills/changed") this.service.capabilityCache.clear();
      });
    }
    return client;
  }

  defaultModelFor(profileId) {
    const profile = this.service.codexProfiles[profileId];
    return profile?.provider && this.service.providerRuntime
      ? this.service.providerRuntime.defaultModel(profile.provider)
      : this.service.defaultModel;
  }

  reasoningFor(model, profileId, effort) {
    const profile = this.service.codexProfiles[profileId];
    if (stellarbit.models(this.service.providerRuntime?.owner).some((m) => m.id === model)) return "medium";
    return profile?.provider && this.service.providerRuntime
      ? this.service.providerRuntime.reasoning(model, profile, effort)
      : ALLOWED_REASONING.has(effort) ? effort : "medium";
  }

  modelAllowed(model, profileId = this.service.defaultCodexProfile) {
    const profile = this.service.codexProfiles[profileId];
    if (stellarbit.models(this.service.providerRuntime?.owner).some((m) => m.id === model) &&
        (!profile?.provider || profile.provider === "antigravity")) return true;
    if (profile?.provider) {
      return Boolean(this.service.providerRuntime && this.service.providerRuntime.allowed(model, profile));
    }
    if (DEEPSEEK_MODELS.has(model)) {
      return this.service.deepseekEnabled &&
        (this.service.allowedModels === null || this.service.allowedModels.has(model));
    }
    const dynamic = this.service.availableModels.get(profileId);
    const policyAllows = this.service.allowedModels === null || this.service.allowedModels.has(model);
    const catalogAllows = !dynamic || dynamic.has(model) || ALL_MODELS.has(model);
    return policyAllows && catalogAllows;
  }

  async readCapabilities(res, requestedProfile = null, respond = this.service.sendJson) {
    // Older native clients cannot pass a profile. Return all authorized profiles
    // so the web UI can select locally without mixing account capabilities.
    if (requestedProfile === null) {
      const capabilitiesByProfile = {};
      await Promise.all([...this.service.allowedCodexProfiles].map(async (id) => {
        await this.service.readCapabilities(res, id, (_res, status, payload) => {
          capabilitiesByProfile[id] = status === 200 ? payload
            : {
              codexProfile: id, models: [], skills: [], mcpServers: [],
              features: [], error: payload.error,
            };
        });
      }));
      const primary = capabilitiesByProfile[this.service.defaultCodexProfile] || { models: [] };
      respond(res, 200, { ...primary, capabilitiesByProfile });
      return;
    }
    const profileId = String(requestedProfile);
    if (!this.service.allowedCodexProfiles.has(profileId) || !this.service.codexProfiles[profileId]) {
      respond(res, 403, { error: "当前用户不能使用这个 Codex 账号" });
      return;
    }
    const profile = this.service.codexProfiles[profileId];
    if (profile.provider) {
      if (!this.service.providerRuntime) {
        respond(res, 503, { error: "账号路由尚未就绪" });
        return;
      }
      try {
        const payload = await this.service.providerRuntime.capabilities(profile);
        if (profile.provider === "antigravity") {
          payload.models.push(...stellarbit.models(this.service.providerRuntime.owner));
        }
        respond(res, 200, payload);
      } catch {
        respond(res, 503, { error: "无法读取这个账号的模型列表，请检查登录状态" });
      }
      return;
    }
    const cached = this.service.capabilityCache.get(profile.id);
    if (cached && Date.now() - cached.cachedAt < 5 * 60 * 1000) {
      respond(res, 200, cached.payload);
      return;
    }
    try {
      const client = this.service.clientFor(profile);
      await client.start();
      const settled = await Promise.allSettled([
        client.request("model/list", { limit: 100, includeHidden: false }),
        client.request("skills/list", { cwds: [profile.workDir], forceReload: false }),
        client.request("mcpServerStatus/list", { limit: 100, detail: "toolsAndAuthOnly" }),
        client.request("collaborationMode/list", {}),
        client.request("experimentalFeature/list", { limit: 100 }),
      ]);
      if (settled[0].status === "rejected") throw new Error("无法读取这个账号的模型列表，请稍后重试");
      const value = (index) => (settled[index].status === "fulfilled" ? settled[index].value : {});
      const models = (value(0).data || []).filter((model) => !model.hidden &&
        (this.service.allowedModels === null || this.service.allowedModels.has(String(model.id || model.model || ""))))
        .map((model) => ({
          id: String(model.id || model.model || ""),
          displayName: String(model.displayName || model.id || model.model || ""),
          isDefault: Boolean(model.isDefault),
          inputModalities: Array.isArray(model.inputModalities)
            ? model.inputModalities.map(String) : ["text", "image"],
          defaultReasoningEffort: String(model.defaultReasoningEffort || "medium"),
          reasoningEfforts: (model.supportedReasoningEfforts || []).map((effort) => ({
            id: String(effort.reasoningEffort || ""),
            description: String(effort.description || ""),
          })).filter((effort) => effort.id),
          supportsPersonality: Boolean(model.supportsPersonality),
          upgrade: model.upgrade ? String(model.upgrade) : null,
        })).filter((model) => model.id);
      if (this.service.deepseekEnabled &&
          (this.service.allowedModels === null || [...DEEPSEEK_MODELS].some((id) => this.service.allowedModels.has(id)))) {
        const deepseekModels = [
          {
            id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", isDefault: false,
            inputModalities: ["text"], defaultReasoningEffort: "high",
            reasoningEfforts: [
              { id: "high", description: "DeepSeek 深度思考" },
              { id: "xhigh", description: "DeepSeek 最大思考" },
            ],
            supportsPersonality: false, upgrade: null, provider: "deepseek",
          },
          {
            id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", isDefault: false,
            inputModalities: ["text"], defaultReasoningEffort: "high",
            reasoningEfforts: [
              { id: "high", description: "DeepSeek 深度思考" },
              { id: "xhigh", description: "DeepSeek 最大思考" },
            ],
            supportsPersonality: false, upgrade: null, provider: "deepseek",
          },
        ].filter((model) => this.service.allowedModels === null || this.service.allowedModels.has(model.id));
        models.push(...deepseekModels);
      }
      models.push(...stellarbit.models(this.service.providerRuntime?.owner));
      this.service.availableModels.set(profile.id, new Set(models.map((model) => model.id)));
      const skillGroups = value(1).data || [];
      const skills = skillGroups.flatMap((group) => group.skills || []).map((skill) => ({
        name: String(skill.name || ""),
        description: String(skill.description || skill.interface?.shortDescription || ""),
        enabled: skill.enabled !== false,
      })).filter((skill) => skill.name);
      const mcpServers = (value(2).data || []).map((server) => ({
        name: String(server.name || server.serverName || ""),
        status: String(server.status || "unknown"),
        authStatus: String(server.authStatus || server.auth?.status || "unknown"),
        toolCount: Array.isArray(server.tools) ? server.tools.length : 0,
      })).filter((server) => server.name);
      const collaborationModes = (value(3).data || value(3).collaborationModes || [])
        .map((mode) => ({
          id: String(mode.id || mode.name || ""),
          label: String(mode.label || mode.displayName || mode.id || mode.name || ""),
        }))
        .filter((mode) => mode.id);
      const features = (value(4).data || []).map((feature) => ({
        name: String(feature.name || ""),
        stage: String(feature.stage || ""),
        enabled: Boolean(feature.enabled),
        displayName: String(feature.displayName || ""),
      })).filter((feature) => feature.name);
      const payload = {
        codexProfile: profile.id,
        models,
        skills,
        mcpServers,
        collaborationModes,
        features,
        support: { fork: true, compact: true, review: true, plans: true },
        checkedAt: new Date().toISOString(),
      };
      this.service.capabilityCache.set(profile.id, { cachedAt: Date.now(), payload });
      respond(res, 200, payload);
    } catch (error) {
      respond(res, 503, { error: error.message || "无法读取 App Server 能力" });
    }
  }
}

module.exports = {
  ProviderRegistry,
  DEEPSEEK_MODELS,
  ADMIN_MODELS,
  NON_ADMIN_MODELS,
  ALL_MODELS,
  QUOTA_EXHAUSTED_MESSAGE,
  ALLOWED_REASONING,
};
