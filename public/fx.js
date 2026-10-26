'use strict';

// Slow "rain" of drawn flowers, petals, hearts, sparkles and butterflies behind the whole app.
(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get: () => { try { return localStorage.getItem('fx'); } catch { return null; } },
    set: (v) => { try { localStorage.setItem('fx', v); } catch { /* private mode */ } },
  };
  let enabled = store.get() !== 'off';
  const canvas = document.createElement('canvas');
  canvas.id = 'fx';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');

  // [name, weight]
  const KINDS = [['blossom', 5], ['petal', 4], ['daisy', 3], ['rose', 2], ['heart', 2], ['sparkle', 3], ['butterfly', 1]];
  const bag = KINDS.flatMap(([k, n]) => Array(n).fill(k));
  const sprites = {};
  let loaded = 0;
  for (const [name] of KINDS) {
    const img = new Image();
    img.src = `/art/${name}.svg`;
    img.onload = () => { if (++loaded === KINDS.length) start(); };
    sprites[name] = img;
  }

  let W = 0, H = 0, dpr = 1, parts = [];
  const rand = (a, b) => a + Math.random() * (b - a);

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);   // tablets are high-DPI; the flowers are soft anyway
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function make(initial) {
    const kind = bag[(Math.random() * bag.length) | 0];
    const depth = Math.random();                 // 0 = far, 1 = near
    const size = (kind === 'sparkle' ? rand(12, 26) : rand(18, 34)) + depth * (kind === 'rose' ? 28 : 24);
    return {
      kind, size, depth,
      baseX: rand(-20, W + 20),
      y: initial ? rand(-size, H) : -size - rand(0, 120),
      vy: rand(14, 24) + depth * 14,             // px/s — slow
      amp: rand(14, 46), freq: rand(0.25, 0.6), phase: rand(0, 6.28),
      rot: rand(0, 6.28), vrot: rand(-0.35, 0.35),
      flip: rand(0.5, 1.2),
      alpha: 0.38 + depth * 0.4,
      push: 0,                                  // horizontal nudge from the pointer
    };
  }

  function draw(p, t) {
    const img = sprites[p.kind];
    const sway = Math.sin(t * p.freq + p.phase);
    let x = p.baseX + sway * p.amp + p.push;
    let angle = p.rot, sx = 1, a = p.alpha;

    if (p.kind === 'heart') angle = sway * 0.35;                          // cute side-to-side tilt
    else if (p.kind === 'butterfly') { angle = sway * 0.25; sx = 0.55 + 0.45 * Math.abs(Math.sin(t * 7 + p.phase)); } // wing flap
    else if (p.kind === 'sparkle') { a *= 0.55 + 0.45 * Math.sin(t * 2.2 + p.phase); angle = p.rot * 0.3; }
    else sx = 0.35 + 0.65 * Math.abs(Math.cos(t * p.flip + p.phase));      // petal flutter / turning

    ctx.globalAlpha = Math.max(0, a);
    ctx.save();
    ctx.translate(x, p.y);
    ctx.rotate(angle);
    ctx.scale(sx, 1);
    ctx.drawImage(img, -p.size / 2, -p.size / 2, p.size, p.size);
    ctx.restore();
  }

  // On a slow tablet, drop half the flowers (then all of them) rather than lag the UI.
  let last = 0, running = false, t = 0, sampleSum = 0, sampleN = 0, tier = 0;
  function watchPerformance(rawDt) {
    if (tier >= 2 || rawDt > 0.25) return;       // ignore tab-switch gaps
    sampleSum += rawDt; sampleN += 1;
    if (sampleN < 90) return;
    const avg = sampleSum / sampleN;
    sampleSum = 0; sampleN = 0;
    if (avg > 0.034) {
      tier += 1;
      if (tier === 1) parts.length = Math.ceil(parts.length / 2);
      else { parts = []; ctx.clearRect(0, 0, W, H); running = false; }
    }
  }

  function frame(now) {
    const rawDt = (now - last) / 1000 || 0;
    const dt = Math.min(rawDt, 0.05);
    last = now; t += dt;
    if (running) watchPerformance(rawDt);
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;
      p.push *= Math.pow(0.35, dt);              // ease back after being nudged
      if (p.y - p.size > H) Object.assign(p, make(false), { baseX: rand(-20, W + 20) });
      draw(p, t);
    }
    if (running) requestAnimationFrame(frame);
  }

  function play() {
    if (running || !enabled || reduceMotion || tier >= 2 || !parts.length) return;
    running = true;
    requestAnimationFrame((n) => { last = n; frame(n); });
  }

  // flowers drift gently away from the pointer / finger
  addEventListener('pointermove', (e) => {
    for (const p of parts) {
      const dx = p.baseX + Math.sin(t * p.freq + p.phase) * p.amp + p.push - e.clientX;
      const dy = p.y - e.clientY;
      const d2 = dx * dx + dy * dy;
      if (d2 < 110 * 110) p.push += Math.sign(dx || 1) * (1 - Math.sqrt(d2) / 110) * 5;
    }
  }, { passive: true });

  function start() {
    resize();
    const count = Math.round(Math.min(Math.max(W / 55, 12), 30));
    parts = Array.from({ length: count }, () => make(true));
    canvas.hidden = !enabled;
    if (reduceMotion) { if (enabled) frame(0); return; }   // one static frame, no loop
    play();
  }

  addEventListener('resize', () => { resize(); if (reduceMotion) frame(0); });
  document.addEventListener('visibilitychange', () => {
    if (reduceMotion) return;
    if (document.hidden) running = false; else play();
  });

  // lets the app's flower button switch the rain on/off
  window.salonFx = {
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = on; store.set(on ? 'on' : 'off');
      canvas.hidden = !on;
      if (!on) { running = false; ctx.clearRect(0, 0, W, H); } else if (reduceMotion) frame(0); else play();
    },
  };
})();
