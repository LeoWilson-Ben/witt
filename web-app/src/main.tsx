import "./styles/tokens.css";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { CodexModelPopover } from "./components/CodexModelPopover";
import { MigrationModal } from "./components/MigrationModal";
import { ToastHost } from "./components/ToastHost";
import { appStore } from "./stores/app-store";
import type { WittLegacyModelHandlers } from "./types/witt";

let registeredHandlers: WittLegacyModelHandlers | null = null;
const handlerListeners = new Set<(handlers: WittLegacyModelHandlers | null) => void>();

window.WittV3Bridge = {
  syncModelState(snapshot) {
    appStore.syncModelState(snapshot);
  },
  setModelMenuOpen(open) {
    appStore.setModelPickerOpen(open);
  },
  bindLegacyHandlers(handlers) {
    registeredHandlers = handlers;
    document.body.classList.add("witt-v3-model-popover");
    for (const listener of handlerListeners) listener(handlers);
  },
  toast(message, tone = "info") {
    appStore.pushToast(message, tone);
  },
};

function App() {
  const [handlers, setHandlers] = useState<WittLegacyModelHandlers | null>(() => registeredHandlers);

  useEffect(() => {
    setHandlers(registeredHandlers);
    handlerListeners.add(setHandlers);
    return () => {
      handlerListeners.delete(setHandlers);
    };
  }, []);

  return (
    <>
      <MigrationModal />
      <CodexModelPopover handlers={handlers} />
      <ToastHost />
    </>
  );
}

function mount() {
  document.body.classList.add("witt-v3-ready");
  let root = document.getElementById("witt-v3-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "witt-v3-root";
    document.body.appendChild(root);
  }
  render(<App />, root);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
