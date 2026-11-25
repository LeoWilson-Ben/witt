(() => {
  const boot = document.getElementById("bootScreen");
  const canvas = document.getElementById("bootSilkCanvas");
  const lockup = document.getElementById("bootSilkLockup");
  if (!boot || !canvas || !lockup) return;

  const ctx = canvas.getContext("2d");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let start = 0;
  let w = 0;
  let h = 0;
  let cleaned = false;
  const timers = [];

  function schedule(fn, ms) {
    timers.push(setTimeout(fn, ms));
  }

  function active() {
    return (
      !cleaned &&
      boot.isConnected &&
      boot.style.visibility !== "hidden" &&
      !boot.classList.contains("leaving")
    );
  }

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    cancelAnimationFrame(frame);
    while (timers.length) clearTimeout(timers.pop());
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisibility);
  }

  function resize() {
    if (!boot.isConnected) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = boot.clientWidth || window.innerWidth;
    h = boot.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(now) {
    if (!active()) {
      if (!boot.isConnected || boot.classList.contains("leaving")) cleanup();
      return;
    }
    if (document.hidden || !ctx) return;
    if (!start) start = now;

    const elapsed = (now - start) / 1000;
    const isDark = document.documentElement.dataset.theme === "dark";
    const centerY = h * 0.5;
    const energy = 0.22 + 0.78 * Math.exp(-elapsed * 1.5);
    const fadeIn = Math.min(1, elapsed / 0.32);

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.globalCompositeOperation = isDark ? "screen" : "multiply";

    const ribbonCount = 7;
    const steps = Math.max(44, Math.floor(w / 14));
    for (let r = 0; r < ribbonCount; r++) {
      const ratio = r / (ribbonCount - 1);
      const phase = elapsed * (1.28 + r * 0.14) + r * 0.75;
      const amp = (18 + r * 11) * energy * (h < 500 ? 0.65 : 1);
      const freq = 0.0042 + r * 0.0007;

      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const x = u * w;
        const env = Math.sin(u * Math.PI);
        const env2 = env * env;
        const y =
          centerY +
          Math.sin(x * freq + phase) * amp * env2 +
          Math.cos(x * freq * 1.9 - phase * 0.8) * (amp * 0.42) * env2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      const grad = ctx.createLinearGradient(0, centerY, w, centerY);
      const centerWeight = 1 - Math.abs(ratio - 0.5) * 2;
      if (isDark) {
        const alpha = (0.14 + centerWeight * 0.24) * fadeIn;
        grad.addColorStop(0, "rgba(98, 239, 214, 0)");
        grad.addColorStop(0.28, `rgba(98, 239, 214, ${alpha})`);
        grad.addColorStop(0.5, `rgba(185, 255, 245, ${alpha * 1.25})`);
        grad.addColorStop(0.72, `rgba(111, 182, 255, ${alpha})`);
        grad.addColorStop(1, "rgba(111, 182, 255, 0)");
      } else {
        const alpha = (0.09 + centerWeight * 0.14) * fadeIn;
        grad.addColorStop(0, "rgba(20, 116, 104, 0)");
        grad.addColorStop(0.3, `rgba(20, 116, 104, ${alpha})`);
        grad.addColorStop(0.5, `rgba(38, 152, 138, ${alpha * 1.2})`);
        grad.addColorStop(0.7, `rgba(47, 115, 217, ${alpha})`);
        grad.addColorStop(1, "rgba(47, 115, 217, 0)");
      }

      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.2 + centerWeight * 1.4;
      ctx.stroke();
    }

    const glowR = Math.min(w, h) * 0.36;
    const glow = ctx.createRadialGradient(w / 2, centerY, 0, w / 2, centerY, glowR);
    if (isDark) {
      glow.addColorStop(0, `rgba(98, 239, 214, ${0.14 * fadeIn})`);
      glow.addColorStop(0.5, `rgba(111, 182, 255, ${0.05 * fadeIn})`);
      glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    } else {
      glow.addColorStop(0, `rgba(20, 116, 104, ${0.08 * fadeIn})`);
      glow.addColorStop(1, "rgba(255, 255, 255, 0)");
    }
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    frame = requestAnimationFrame(draw);
  }

  function onVisibility() {
    if (document.hidden) cancelAnimationFrame(frame);
    else if (active() && !motion.matches) frame = requestAnimationFrame(draw);
  }

  if (motion.matches) {
    lockup.classList.add("focus");
    return;
  }

  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibility);
  schedule(() => { if (active()) lockup.classList.add("focus"); }, 280);
  schedule(() => { if (active()) lockup.classList.add("sheen"); }, 780);
  frame = requestAnimationFrame(draw);
})();
