import { afterEach, describe, expect, it } from "vitest";
import {
  pointerRatioFromClientX,
  reasoningIndexAndRatio,
  stepReasoningIndex,
} from "../src/components/CodexModelPopover";
import {
  parseMigrationHash,
  shouldPromptServerMigration,
} from "../src/components/MigrationModal";
import { ensureBrowserDeviceId } from "../src/bridge/witt-bridge";
import { appStore } from "../src/stores/app-store";

describe("Migration helpers", () => {
  it("parses and decodes #migrate hash parameters", () => {
    expect(parseMigrationHash("#migrate=abc%2F123.xyz")).toBe("abc/123.xyz");
    expect(parseMigrationHash("#other=1")).toBe("");
    expect(parseMigrationHash("")).toBe("");
  });

  it("prompts server migration only when authenticated and target origin differs", () => {
    expect(shouldPromptServerMigration(false, "https://new.example.com/vault/index.html", "https://old.example.com")).toBe(false);
    expect(shouldPromptServerMigration(true, undefined, "https://old.example.com")).toBe(false);
    expect(shouldPromptServerMigration(true, "https://old.example.com/vault/index.html", "https://old.example.com")).toBe(false);
    expect(shouldPromptServerMigration(true, "https://new.example.com/vault/index.html", "https://old.example.com")).toBe(true);
  });

  it("generates a valid UUID v4 browser device id", () => {
    const id = ensureBrowserDeviceId();
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
  });
});

describe("AppStore", () => {
  afterEach(() => {
    appStore.resetForTest();
  });

  it("notifies subscribers on model state sync and cleans up on unsubscribe", () => {
    const seen: string[] = [];
    const unsub = appStore.subscribe((state) => {
      seen.push(`${state.modelPicker.model}:${state.modelPicker.reasoning}:${state.modelPickerOpen}`);
    });

    appStore.setModelPickerOpen(true);
    appStore.syncModelState({
      model: "gpt-6-astra",
      modelDisplayName: "GPT-6 Astra",
      reasoning: "xhigh",
      efforts: ["low", "medium", "high", "xhigh"],
    });
    unsub();
    appStore.setModelPickerOpen(false);

    expect(seen).toEqual([
      "gpt-6.1-sol:medium:true",
      "gpt-6-astra:xhigh:true",
    ]);
  });

  it("resets popover view back to slider when reopened", () => {
    appStore.setModelPickerOpen(true);
    appStore.setModelPickerView("list");
    appStore.setModelPickerOpen(false);
    appStore.setModelPickerOpen(true);
    expect(appStore.getState().modelPickerView).toBe("slider");
  });
});

describe("CodexModelPopover reasoning math", () => {
  const efforts = ["low", "medium", "high", "xhigh"] as const;

  it("computes index and ratio accurately across bounds", () => {
    expect(reasoningIndexAndRatio([...efforts], "low")).toEqual({ index: 0, ratio: 0 });
    expect(reasoningIndexAndRatio([...efforts], "xhigh")).toEqual({ index: 3, ratio: 1 });
    expect(reasoningIndexAndRatio(["medium"], "medium")).toEqual({ index: 0, ratio: 0 });
  });

  it("clamps stepReasoningIndex within [0, efforts.length - 1]", () => {
    expect(stepReasoningIndex([...efforts], "low", -1)).toBe("low");
    expect(stepReasoningIndex([...efforts], "low", 2)).toBe("high");
    expect(stepReasoningIndex([...efforts], "xhigh", 1)).toBe("xhigh");
  });

  it("maps pointer clientX positions onto discrete effort stops", () => {
    expect(pointerRatioFromClientX(10, 0, 240, [...efforts])).toBe("low");
    expect(pointerRatioFromClientX(230, 0, 240, [...efforts])).toBe("xhigh");
    expect(pointerRatioFromClientX(85, 0, 240, [...efforts])).toBe("medium");
    expect(pointerRatioFromClientX(156, 0, 240, [...efforts])).toBe("high");
  });
});
