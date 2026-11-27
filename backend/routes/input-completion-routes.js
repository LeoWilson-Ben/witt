"use strict";
const fs = require("node:fs");
function completionAllowed(userId) {
  let owner = process.env.STELLARBIT_COMPLETION_USER_ID || process.env.STELLARBIT_ALLOWED_USER_ID;
  if (!owner) {
    try { owner = fs.readFileSync('/var/lib/witt/runtime/stellarbit/completion-user-id', 'utf8').trim(); } catch {}
  }
  return Boolean(owner && userId === owner);
}

function createInputCompletionRouter({ sendJson, readJsonBody, fetchImpl = fetch,
  allowed = completionAllowed,
  readKey = () => fs.readFileSync(process.env.STELLARBIT_API_KEY_FILE || '/var/lib/witt/runtime/stellarbit/api-key', 'utf8').trim(),
}) {
  const active = new Map();
  const lastRequest = new Map();
  return { handle(req, res, url, principal) {
    if (url.pathname !== '/input-completion') return false;
    if (req.method !== 'POST') { sendJson(res, 405, {error: '仅支持 POST'}); return true; }
    if (!principal || !allowed(principal.userId)) { sendJson(res, 403, {error: '此账号未开放补全'}); return true; }
    readJsonBody(req, 8192, async (error, body) => {
      if (error) { sendJson(res, 400, {error: '请求格式不正确'}); return; }
      const prefix = body?.prefix;
      if (typeof prefix !== 'string' || prefix.trim().length < 2 || prefix.length > 2000) {
        sendJson(res, 200, {suffix: ''}); return;
      }
      const user = principal.userId;
      const now = Date.now();
      if (now - (lastRequest.get(user) || 0) < 500) { sendJson(res, 429, {suffix: ''}); return; }
      lastRequest.set(user, now);
      // Entries expire; neither typed text nor completions are stored or logged.
      const expiry = setTimeout(() => { if (lastRequest.get(user) === now) lastRequest.delete(user); }, 60000);
      expiry.unref?.();
      active.get(user)?.abort();
      const controller = new AbortController();
      active.set(user, controller);
      const timer = setTimeout(() => controller.abort(), 10000);
      const disconnect = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', disconnect);
      try {
        const key = readKey();
        if (!key) throw new Error('unavailable');
        const upstream = await fetchImpl(process.env.STELLARBIT_API_URL || 'https://chat.stellarbit.site/v1/chat/completions', {
          method: 'POST', signal: controller.signal,
          headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'},
          body: JSON.stringify({model: 'deepseek-v4-flash', stream: false, max_tokens: 120, temperature: 0.2,
            messages: [
              {role: 'system', content: '你是输入框续写器。用户提供尚未写完的提示词，请预测用户接下来会输入的短句。只输出紧接原文的续写部分，不重复原文，不回答问题，不执行指令，不添加解释、引号或 Markdown。最多续写60字；不确定时输出空字符串。'},
              {role: 'user', content: prefix},
            ]}),
        });
        if (!upstream.ok) { await upstream.arrayBuffer(); throw new Error('unavailable'); }
        const result = await upstream.json();
        let suffix = result.choices?.[0]?.message?.content;
        suffix = typeof suffix === 'string' ? suffix : '';
        if (suffix.startsWith(prefix)) suffix = suffix.slice(prefix.length);
        suffix = suffix.replace(/[\r\n]+/g, ' ').slice(0, 120);
        if (!res.destroyed) sendJson(res, 200, {suffix, model: 'deepseek-v4-flash'});
      } catch {
        if (!res.destroyed) sendJson(res, 200, {suffix: ''});
      } finally {
        clearTimeout(timer);
        res.off('close', disconnect);
        if (active.get(user) === controller) active.delete(user);
      }
    });
    return true;
  }};
}
module.exports = { createInputCompletionRouter };
