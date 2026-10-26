// What the assistant knows about the salon: services/prices, general info and FAQ.
// Edited by the owner in the app (Firestore), so a price change is known to the bot within seconds.
// If no services were entered yet, the list in salon.config.js is used.
export function createKnowledge({ db, config, ttlMs = 30000, now = () => Date.now() }) {
  let cache = null;
  let loadedAt = 0;
  let live = null;      // {services, info} kept current by listeners once start() ran

  const build = (serviceDocs, infoDoc) => {
    const fromApp = serviceDocs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return { services: fromApp.length ? fromApp : config.services.map((s) => ({ note: '', ...s })), info: infoDoc.exists ? infoDoc.data() : {} };
  };

  /** Keeps the knowledge in memory and updates it the moment the owner edits something in the app. */
  function start() {
    let services = null;
    let info = null;
    const refresh = () => { if (services && info) live = build(services.docs, info); };
    const unsubs = [
      db.collection('services').onSnapshot((s) => { services = s; refresh(); }, () => {}),
      db.collection('settings').doc('salon').onSnapshot((s) => { info = s; refresh(); }, () => {}),
    ];
    return new Promise((resolve) => {
      const t = setInterval(() => { if (live) { clearInterval(t); resolve(() => unsubs.forEach((u) => u())); } }, 25);
      t.unref?.();
      setTimeout(() => { clearInterval(t); resolve(() => unsubs.forEach((u) => u())); }, 8000).unref?.();
    });
  }

  async function load() {
    if (live) return live;
    if (cache && now() - loadedAt < ttlMs) return cache;
    const [sv, st] = await Promise.all([db.collection('services').get(), db.collection('settings').doc('salon').get()]);
    cache = build(sv.docs, st);
    loadedAt = now();
    return cache;
  }

  return { load, start, invalidate: () => { cache = null; } };
}

/** The automatic assistant's name: set in the app (Services screen), else salon.config.js. */
export const assistantName = (kb, config) => kb.info?.assistant_name || config.assistantName || 'المساعدة';
