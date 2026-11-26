export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type QuotaTone = "unknown" | "healthy" | "good" | "warn" | "low" | "critical";
export type BrandKey = "openai" | "anthropic" | "google" | "deepseek" | "stellarbit" | string;

export interface ModelOption {
  id: string;
  displayName: string;
  brand: BrandKey;
}

export interface AuthStatusResponse {
  initialized: boolean;
  authenticated: boolean;
  principal?: {
    userId: string;
    deviceId: string;
    label?: string;
    admin?: boolean;
  } | null;
  serverMigration?: {
    targetUrl: string;
  } | null;
}

export interface ServerMigrationCodeResponse {
  targetUrl: string;
  code: string;
  expiresAt: string;
}

export interface ModelPickerSnapshot {
  model: string;
  modelDisplayName: string;
  reasoning: ReasoningEffort;
  efforts: ReasoningEffort[];
  models: ModelOption[];
  quotaTone: QuotaTone;
  quotaText: string;
}

export interface WittLegacyModelHandlers {
  selectReasoning: (effort: ReasoningEffort) => void;
  selectModel: (modelId: string) => void;
  resetReasoning: () => void;
  openQuota: () => void;
  closeMenu: () => void;
}

export interface WittNativeBridge {
  requestAuthStatus?: () => void;
  activateInvite?: (inviteCode: string) => void;
  requestConversations?: () => void;
  requestCapabilities?: () => void;
  requestUsage?: (conversationId?: string) => void;
  createConversation?: (model: string, reasoning: string, accessMode: string) => void;
  updateConversationSettings?: (
    id: string,
    model: string,
    reasoning: string,
    accessMode?: string,
    codexProfile?: string,
  ) => void;
  sendChatMessageWithRequestId?: (
    id: string,
    text: string,
    attachmentIdsJson: string,
    clientRequestId: string,
  ) => void;
  interruptConversation?: (id: string) => void;
  pickFiles?: () => void;
  uploadFile?: (id: string) => void;
  postMessage?: (payload: string) => void;
}

export interface WittV3Bridge {
  syncModelState: (snapshot: Partial<ModelPickerSnapshot>) => void;
  setModelMenuOpen: (open: boolean) => void;
  bindLegacyHandlers: (handlers: WittLegacyModelHandlers) => void;
  toast: (message: string, tone?: "info" | "success" | "error") => void;
}

declare global {
  interface Window {
    WittNative?: WittNativeBridge;
    DropVaultAndroid?: WittNativeBridge;
    WittV3Bridge?: WittV3Bridge;
  }
}
