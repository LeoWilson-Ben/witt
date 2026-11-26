import type {
  AuthStatusResponse,
  ServerMigrationCodeResponse,
} from "../types/witt";

const API_BASE = "/vault-api/";
const DEVICE_ID_KEY = "witt_web_device_id";
const UUID_RE = /^[a-f0-9-]{36}$/;

export function isAndroidWebView(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.WittNative || window.DropVaultAndroid);
}

export function ensureBrowserDeviceId(): string {
  let id = "";
  try {
    id = localStorage.getItem(DEVICE_ID_KEY) || "";
  } catch {
    id = "";
  }
  if (!UUID_RE.test(id)) {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      id = crypto.randomUUID();
    } else {
      id = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
    }
    try {
      localStorage.setItem(DEVICE_ID_KEY, id);
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }
  return id;
}

export async function fetchApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  headers.set("X-Witt-Client", "browser");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  const resp = await fetch(`${API_BASE}${path.replace(/^\/+/, "")}`, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const text = await resp.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }
  if (!resp.ok) {
    const msg = typeof data.error === "string" ? data.error : `请求失败（${resp.status}）`;
    throw new Error(msg);
  }
  return data as T;
}

export function fetchAuthStatus(): Promise<AuthStatusResponse> {
  return fetchApi<AuthStatusResponse>("auth/status");
}

export function requestServerMigrationCode(): Promise<ServerMigrationCodeResponse> {
  return fetchApi<ServerMigrationCodeResponse>("auth/server-migration-code", {
    method: "POST",
    body: "{}",
  });
}

export function activateBrowserInvite(inviteCode: string): Promise<Record<string, unknown>> {
  return fetchApi<Record<string, unknown>>("auth/activate", {
    method: "POST",
    body: JSON.stringify({
      inviteCode: inviteCode.trim(),
      deviceId: ensureBrowserDeviceId(),
      deviceName: `${typeof navigator !== "undefined" ? navigator.platform || "浏览器" : "浏览器"} · Web`,
    }),
  });
}
