'use strict';
// Only the official CLI reads its own credentials. Never return raw CLI output.
function normalizeQuota(data) {
  const groups = (Array.isArray(data?.groups) ? data.groups : []).slice(0, 12).map(group => ({
    name: String(group.name || '模型额度').slice(0, 120),
    family: /argon/i.test(group.name || '') ? 'argon' : /claude|gpt/i.test(group.name || '') ? 'third-party' : 'gemini',
    buckets: (Array.isArray(group.buckets) ? group.buckets : []).slice(0, 12).map(bucket => {
      const raw = bucket.remaining_fraction;
      const fraction = raw !== null && raw !== undefined && raw !== '' ? Number(raw) : NaN;
      const window = String(bucket.window || bucket.name || '').toLowerCase();
      const reset = bucket.reset_time;
      const date = typeof reset === 'number' ? new Date(reset < 1e12 ? reset * 1000 : reset) : new Date(String(reset || ''));
      return {
        id: String(bucket.id || '').slice(0, 120), name: String(bucket.name || '额度窗口').slice(0, 120),
        window: /week|7.?day/.test(window) ? 'weekly' : /five|5.?h/.test(window) ? '5h' : window.slice(0, 80),
        remainingPercent: Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? Math.round(fraction * 10000) / 100 : null,
        remainingAmount: Number.isFinite(bucket.remaining_amount) ? bucket.remaining_amount : null,
        disabled: bucket.disabled === true,
        resetsAt: Number.isFinite(date.getTime()) ? date.toISOString() : null,
      };
    }),
  })).filter(group => group.buckets.length);
  return { available: groups.length > 0, groups, checkedAt: new Date().toISOString(), source: 'official-cli' };
}

async function readQuota(service, owner) {
  service.quotaCache ||= new Map(); service.quotaPending ||= new Map();
  const cache = service.quotaCache.get(owner);
  if (cache && Date.now() - cache.at < 30000) return cache.value;
  if (service.quotaPending.has(owner)) return service.quotaPending.get(owner);
  const pending = new Promise(resolve => {
    let out = '', done = false, timer;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const failed = message => ({ available: false, groups: [], message, checkedAt: new Date().toISOString() });
    try {
      const env = service.env(owner);
      const child = service.spawn(service.bin, ['--log-file', '/dev/null', '-p', '/usage', '--output-format', 'json'], {
        cwd: env.HOME, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      timer = setTimeout(() => { finish(failed('额度读取超时，请稍后刷新')); child.kill(); }, 20000);
      child.stdout.on('data', chunk => {
        if (done) return;
        out += chunk.toString();
        if (out.length > 262144) { out = ''; finish(failed('额度返回异常，请稍后刷新')); child.kill(); }
      });
      child.stderr.resume();
      child.on('error', () => finish(failed('无法启动反重力额度查询，请稍后重试')));
      child.on('close', code => {
        if (done) return;
        try {
          const response = JSON.parse(out); out = '';
          if (code !== 0 || String(response.status).toUpperCase() !== 'SUCCESS' || response.command?.name !== 'usage') throw Error();
          const value = normalizeQuota(response.command.data);
          if (value.available) service.quotaCache.set(owner, { at: Date.now(), value });
          else value.message = '官方暂未返回可用额度，请确认账号已登录后刷新';
          finish(value);
        } catch { finish(failed('暂时无法读取反重力额度，请确认账号已登录后刷新')); }
      });
    } catch { finish(failed('暂时无法读取反重力额度')); }
  });
  service.quotaPending.set(owner, pending);
  try { return await pending; } finally { service.quotaPending.delete(owner); }
}
module.exports = { normalizeQuota, readQuota };
