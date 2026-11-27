(() => {
  "use strict";

  // Faithful, zero-dependency port of Google Antigravity's oauth-callback ring particle field
  // (Poisson-distributed micro-capsules, double-ring breathing wave, multi-scale organic flow,
  // radial orientation toward cursor/orbit center, and official light/dark color palettes).

  const LIGHT_COLORS = [
    [44, 100, 237],  // #2c64ed
    [248, 66, 66],   // #f84242
    [255, 207, 3],   // #ffcf03
  ];
  const DARK_COLORS = [
    [113, 137, 255], // #7189ff
    [48, 116, 249],  // #3074f9
    [155, 114, 203], // #9b72cb
  ];

  // Fast 2D smooth value noise (used as lightweight 3D simplex approximation)
  function hash2(ix, iy) {
    let n = (ix * 374761393 + iy * 668265263) | 0;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  }

  function smoothNoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy);
    const b = hash2(ix + 1, iy);
    const c = hash2(ix, iy + 1);
    const d = hash2(ix + 1, iy + 1);
    return (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy) * 2 - 1;
  }

  function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  function mix3(c1, c2, c3, progress) {
    const h = 0.78;
    let r, g, b;
    if (progress < h) {
      const k = progress / h;
      r = c1[0] + (c2[0] - c1[0]) * k;
      g = c1[1] + (c2[1] - c1[1]) * k;
      b = c1[2] + (c2[2] - c1[2]) * k;
    } else {
      const k = (progress - h) / (1 - h);
      r = c2[0] + (c3[0] - c2[0]) * k;
      g = c2[1] + (c3[1] - c2[1]) * k;
      b = c2[2] + (c3[2] - c2[2]) * k;
    }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  function init() {
    const shell = document.querySelector(".app-shell");
    if (!shell || document.querySelector("#antigravityParticlesBg")) return;

    const canvas = document.createElement("canvas");
    canvas.id = "antigravityParticlesBg";
    canvas.className = "antigravity-bg-canvas";
    canvas.setAttribute("aria-hidden", "true");
    shell.insertBefore(canvas, shell.firstChild);

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let particles = [];
    let isDark = document.documentElement.dataset.theme === "dark";

    // Ring center in normalized [-1, 1] coordinates (aspect-corrected in physics)
    let ringX = 0;
    let ringY = -0.06;
    let targetX = 0;
    let targetY = -0.06;
    let lastPointerAt = 0;

    function rebuildParticles() {
      const area = Math.max(1, width * height);
      const isCompact = width < 680;
      const targetCount = reducedMotion
        ? Math.min(260, Math.round(area / 5000))
        : Math.max(420, Math.min(isCompact ? 620 : 1250, Math.round(area / (isCompact ? 1150 : 1280))));
      const cols = Math.max(16, Math.round(Math.sqrt(targetCount * (width / Math.max(1, height)))));
      const rows = Math.max(12, Math.round(targetCount / cols));
      const cellW = 2 / cols;
      const cellH = 2 / rows;
      const list = [];
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          // Jittered Poisson-like grid so capsules stay evenly spaced with organic feel
          const rx = -1 + (c + 0.15 + Math.random() * 0.7) * cellW;
          const ry = -1 + (r + 0.15 + Math.random() * 0.7) * cellH;
          list.push({
            rx,
            ry,
            px: rx,
            py: ry,
            scale: 0.25,
            seed: Math.random() * 6.28318,
          });
        }
      }
      particles = list;
    }

    function resize() {
      const rect = shell.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rebuildParticles();
    }

    const syncTheme = () => {
      isDark = document.documentElement.dataset.theme === "dark";
    };
    new MutationObserver(syncTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-mode"],
    });

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => resize()).observe(shell);
    }
    window.addEventListener("resize", resize, { passive: true });

    window.addEventListener("pointermove", (event) => {
      const rect = shell.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = ((event.clientY - rect.top) / rect.height) * 2 - 1;
      if (nx >= -1.1 && nx <= 1.1 && ny >= -1.1 && ny <= 1.1) {
        targetX = Math.max(-0.85, Math.min(0.85, nx));
        targetY = Math.max(-0.85, Math.min(0.85, ny));
        lastPointerAt = performance.now();
      }
    }, { passive: true });

    resize();

    let rafId = 0;
    let startAt = performance.now();

    function drawFrame(now) {
      rafId = 0;
      if (document.hidden) return;

      const tSec = (now - startAt) * 0.001;
      const time = tSec * 0.5;

      // Idle organic Lissajous orbit when pointer hasn't moved recently
      if (now - lastPointerAt > 2400) {
        targetX = Math.sin(tSec * 0.28) * 0.32 + Math.cos(tSec * 0.17) * 0.12;
        targetY = Math.cos(tSec * 0.23) * 0.24 + Math.sin(tSec * 0.14) * 0.10;
      }

      // Smooth spring inertia for ring center
      ringX += (targetX - ringX) * 0.045;
      ringY += (targetY - ringY) * 0.045;

      ctx.clearRect(0, 0, width, height);

      const aspect = width / Math.max(1, height);
      const halfW = width * 0.5;
      const halfH = height * 0.5;
      const ringRadius = 0.34 + Math.sin(tSec * 0.7) * 0.045;
      const ringWidth = 0.055;
      const ringWidth2 = 0.145;
      const ringDisplacement = 0.52;
      const baseScale = Math.max(0.75, Math.min(1.25, Math.min(width, height) / 860));
      const palette = isDark ? DARK_COLORS : LIGHT_COLORS;
      const maxAlpha = isDark ? 0.58 : 0.62;

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        const dx = (p.rx - ringX) * aspect;
        const dy = p.ry - ringY;
        const dist = Math.hypot(dx, dy);

        const n0 = smoothNoise(p.rx * 1.4 + 18.49 + time * 0.22, p.ry * 1.4 + 72.97 - time * 0.18);
        const dist1 = dist + n0 * 0.02;

        let t1 = smoothstep(ringRadius - ringWidth * 2, ringRadius, dist) -
          smoothstep(ringRadius, ringRadius + ringWidth, dist1);
        let t2 = smoothstep(ringRadius - ringWidth2 * 2, ringRadius, dist) -
          smoothstep(ringRadius, ringRadius + ringWidth2, dist1);
        const t3 = smoothstep(ringRadius + ringWidth2, ringRadius, dist);

        t1 = t1 * t1;
        t2 = t2 * t2 * t2;

        let targetScale = t1 + t2 * 2.6 + t3 * 0.36;
        const nS = smoothNoise(p.rx * 2.2 + 11.4 + time * 0.32, p.ry * 2.2 + 12.9 + time * 0.24);
        targetScale += Math.pow((nS + 1.35) * 0.5, 2) * 0.42;

        p.scale += (targetScale - p.scale) * 0.18;

        const alpha = smoothstep(0.14, 0.34, p.scale) * maxAlpha;
        if (alpha < 0.025) continue;

        // Multi-scale organic drift + sin/cos wave + ring radial displacement
        const n1 = smoothNoise(p.rx * 3.4 + 88.49 + time * 0.28, p.ry * 3.4 + 32.43);
        const n2 = smoothNoise(p.rx * 3.4 + 50.90, p.ry * 3.4 + 120.94 + time * 0.28);
        const waveX = Math.sin(p.rx * 10 + time * 2.4) * 0.012 * Math.min(1, dist);
        const waveY = Math.cos(p.ry * 10 + time * 1.9) * 0.012 * Math.min(1, dist);
        const push = Math.pow(Math.max(0, t2), 0.75) * ringDisplacement * 0.24;

        const fx = p.rx + n1 * 0.024 + waveX - (ringX - p.rx) * push;
        const fy = p.ry + n2 * 0.024 + waveY - (ringY - p.ry) * push;

        const sx = halfW + fx * halfW;
        const sy = halfH + fy * halfH;

        // Radial orientation toward ring center + organic wobble
        const nAngle = smoothNoise(p.rx * 5 + 18.49 + time * 0.45, p.ry * 5 + 72.97);
        const angle = Math.atan2(fy - ringY, (fx - ringX) * aspect) + nAngle * 0.45;

        // 3-color gradient driven by noise field
        const nCol = (smoothNoise(p.rx * 1.8 + 74.66 + time * 0.3, p.ry * 1.8 + 91.55 - time * 0.25) + 1) * 0.5;
        const colorProgress = smoothstep(0, 0.78, nCol * nCol);

        const len = Math.max(2.6, Math.min(11.5, p.scale * 4.4 * baseScale));
        const thick = Math.max(1.3, len * 0.36);

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(angle);
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.fillStyle = mix3(palette[0], palette[1], palette[2], colorProgress);
        ctx.beginPath();
        const r = thick * 0.5;
        ctx.roundRect(-len * 0.5, -r, len, thick, r);
        ctx.fill();
        ctx.restore();
      }

      if (!reducedMotion) {
        rafId = requestAnimationFrame(drawFrame);
      }
    }

    const startLoop = () => {
      if (!rafId) rafId = requestAnimationFrame(drawFrame);
    };

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      } else {
        startLoop();
      }
    });

    startLoop();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
