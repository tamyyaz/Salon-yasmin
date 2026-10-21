'use strict';

// Slow "rain" of drawn flowers, petals, hearts, sparkles and butterflies behind the whole app.
(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    dpr = Math.min(window.devicePixelRatio || 1, 2);
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

  let last = 0, running = false, t = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000 || 0, 0.05);
    last = now; t += dt;
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
    if (reduceMotion) { frame(0); return; }     // one static frame, no loop
    running = true;
    requestAnimationFrame((n) => { last = n; frame(n); });
  }

  addEventListener('resize', () => { resize(); if (reduceMotion) frame(0); });
  document.addEventListener('visibilitychange', () => {
    if (reduceMotion) return;
    if (document.hidden) running = false;
    else if (!running) { running = true; requestAnimationFrame((n) => { last = n; frame(n); }); }
  });
})();
