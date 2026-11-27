'use strict';
// Only the official CLI reads its own credentials. Never return raw CLI output.
function classifyQuotaError(text) {
  const value = String(text || '');
  if (/not (?:currently )?available in your (?:location|region|country)|eligibility check failed|not eligible/i.test(value)) {
    return {
      errorCode: 'region_ineligible',
      message: '该 Google 账号归属地区暂不支持 Antigravity，请更换美区/日区/台区账号或先变更地区',
    };
  }
  if (/unauthenticated|authentication required|not (?:signed|logged) in|invalid_grant|expired.*token|login required/i.test(value)) {
    return {
      errorCode: 'unauthenticated',
      message: '账号授权已失效，请重新登录',
    };
  }
  if (/quota|resource_exhausted|rate.?limit|too many requests/i.test(value)) {
    return {
      errorCode: 'rate_limited',
      message: '账号当前触发限流，请稍后再试或切换备用席位',
    };
  }
  return {
    errorCode: 'unavailable',
    message: '暂时无法读取反重力额度，请确认账号已登录后刷新',
  };
}

function summarizeQuota(value) {
  if (!value || typeof value !== 'object') return null;
  if (!value.available) {
    return {
      available: false,
      fiveHour: null,
      weekly: null,
      errorCode: value.errorCode || 'unavailable',
      message: value.message || '',
    };
  }
  const groups = Array.isArray(value.groups) ? value.groups : [];
  const primaryGroup = groups.find((g) => g.family === 'gemini') || groups[0];
  const buckets = Array.isArray(primaryGroup?.buckets) ? primaryGroup.buckets : [];
  const fiveHourBucket = buckets.find((b) => b.window === '5h');
  const weeklyBucket = buckets.find((b) => b.window === 'weekly');
  return {
    available: true,
    fiveHour: typeof fiveHourBucket?.remainingPercent === 'number' ? Math.round(fiveHourBucket.remainingPercent) : null,
    weekly: typeof weeklyBucket?.remainingPercent === 'number' ? Math.round(weeklyBucket.remainingPercent) : null,
    errorCode: null,
    message: '',
  };
}

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
    let out = '', err = '', done = false, timer;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const failed = (message, errorCode = 'unavailable') => ({ available: false, groups: [], errorCode, message, checkedAt: new Date().toISOString() });
    try {
      const env = service.env(owner);
      const child = service.spawn(service.bin, ['--log-file', '/dev/null', '-p', '/usage', '--output-format', 'json'], {
        cwd: env.HOME, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      timer = setTimeout(() => { finish(failed('额度读取超时，请稍后刷新', 'timeout')); child.kill(); }, 20000);
      child.stdout.on('data', chunk => {
        if (done) return;
        out += chunk.toString();
        if (out.length > 262144) { out = ''; finish(failed('额度返回异常，请稍后刷新')); child.kill(); }
      });
      child.stderr.on('data', chunk => {
        if (done) return;
        if (err.length < 4096) err += chunk.toString();
      });
      child.on('error', () => finish(failed('无法启动反重力额度查询，请稍后重试')));
      child.on('close', code => {
        if (done) return;
        let parsed = null;
        try { parsed = JSON.parse(out); } catch {}
        out = '';
        if (code === 0 && parsed && String(parsed.status).toUpperCase() === 'SUCCESS' && parsed.command?.name === 'usage') {
          const value = normalizeQuota(parsed.command.data);
          if (value.available) {
            service.quotaCache.set(owner, { at: Date.now(), value });
          } else {
            value.message = '官方暂未返回可用额度，请确认账号已登录后刷新';
          }
          finish(value);
          return;
        }
        const classified = classifyQuotaError(`${parsed?.error || ''}\n${err}`);
        const value = failed(classified.message, classified.errorCode);
        if (classified.errorCode === 'region_ineligible') {
          service.quotaCache.set(owner, { at: Date.now(), value });
        }
        finish(value);
      });
    } catch { finish(failed('暂时无法读取反重力额度')); }
  });
  service.quotaPending.set(owner, pending);
  try { return await pending; } finally { service.quotaPending.delete(owner); }
}
module.exports = { normalizeQuota, readQuota, classifyQuotaError, summarizeQuota };
