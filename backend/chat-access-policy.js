"use strict";

// Refresh a cached user's permissions without replacing active turns or their history.
function refreshChatAccess(service, options) {
  const profiles = new Set((options.allowedCodexProfiles || ["default"])
    .filter((id) => service.codexProfiles[id]));
  const sameModels = service.allowedModels === options.allowedModels;
  const changed = !sameModels || service.defaultModel !== options.defaultModel ||
    service.quotaExhausted !== options.quotaExhausted ||
    [...service.allowedCodexProfiles].join("|") !== [...profiles].join("|");
  service.allowedModels = options.allowedModels;
  service.defaultModel = options.defaultModel;
  service.quotaExhausted = options.quotaExhausted;
  service.allowedCodexProfiles = profiles;
  service.defaultCodexProfile = [...profiles][0] || "default";
  if (changed) {
    service.usageCache.clear();
    service.capabilityCache.clear();
  }
  return service;
}

module.exports = { refreshChatAccess };
