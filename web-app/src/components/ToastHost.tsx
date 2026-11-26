import { useAppStore } from "../stores/app-store";

export function ToastHost() {
  const toasts = useAppStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div class="witt-v3-toast-host" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} class="witt-v3-toast" data-tone={item.tone}>
          {item.message}
        </div>
      ))}
    </div>
  );
}
