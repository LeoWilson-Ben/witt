import { useEffect, useState } from "preact/hooks";
import type { ModelPickerSnapshot, ReasoningEffort } from "../types/witt";

export interface ToastItem {
  id: number;
  message: string;
  tone: "info" | "success" | "error";
}

export interface AppState {
  modelPickerOpen: boolean;
  modelPickerView: "slider" | "list";
  modelPicker: ModelPickerSnapshot;
  toasts: ToastItem[];
}

const initialState: AppState = {
  modelPickerOpen: false,
  modelPickerView: "slider",
  modelPicker: {
    model: "gpt-6.1-sol",
    modelDisplayName: "GPT-6.1 Sol",
    reasoning: "medium",
    efforts: ["low", "medium", "high", "xhigh"],
    models: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", brand: "openai" }],
    quotaTone: "unknown",
    quotaText: "当前账号额度",
  },
  toasts: [],
};

type Listener = (state: AppState) => void;

class AppStore {
  private state: AppState = initialState;
  private listeners = new Set<Listener>();
  private nextToastId = 1;

  getState(): AppState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(next: AppState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  setModelPickerOpen(open: boolean): void {
    const nextOpen = Boolean(open);
    if (this.state.modelPickerOpen === nextOpen && (!nextOpen || this.state.modelPickerView === "slider")) {
      return;
    }
    this.emit({
      ...this.state,
      modelPickerOpen: nextOpen,
      modelPickerView: nextOpen ? "slider" : this.state.modelPickerView,
    });
  }

  setModelPickerView(view: "slider" | "list"): void {
    if (this.state.modelPickerView === view) return;
    this.emit({ ...this.state, modelPickerView: view });
  }

  syncModelState(snapshot: Partial<ModelPickerSnapshot>): void {
    const prev = this.state.modelPicker;
    const efforts = Array.isArray(snapshot.efforts) && snapshot.efforts.length
      ? snapshot.efforts
      : prev.efforts;
    const reasoning: ReasoningEffort = snapshot.reasoning && efforts.includes(snapshot.reasoning)
      ? snapshot.reasoning
      : prev.reasoning;
    this.emit({
      ...this.state,
      modelPicker: {
        ...prev,
        ...snapshot,
        efforts,
        reasoning,
        models: Array.isArray(snapshot.models) && snapshot.models.length ? snapshot.models : prev.models,
      },
    });
  }

  pushToast(message: string, tone: "info" | "success" | "error" = "info", durationMs = 2600): number {
    const id = this.nextToastId++;
    this.emit({
      ...this.state,
      toasts: [...this.state.toasts, { id, message, tone }],
    });
    if (durationMs > 0) {
      setTimeout(() => this.dismissToast(id), durationMs);
    }
    return id;
  }

  dismissToast(id: number): void {
    const filtered = this.state.toasts.filter((t) => t.id !== id);
    if (filtered.length === this.state.toasts.length) return;
    this.emit({ ...this.state, toasts: filtered });
  }

  resetForTest(): void {
    this.state = initialState;
    this.listeners.clear();
  }
}

export const appStore = new AppStore();

export function useAppStore<T>(selector: (state: AppState) => T): T {
  const [slice, setSlice] = useState<T>(() => selector(appStore.getState()));
  useEffect(() => {
    setSlice(selector(appStore.getState()));
    return appStore.subscribe((state) => {
      setSlice(selector(state));
    });
  }, []);
  return slice;
}
