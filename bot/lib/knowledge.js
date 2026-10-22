// What the assistant knows about the salon: services/prices, general info and FAQ.
// Edited by the owner in the app (Firestore), so a price change is known to the bot within seconds.
// If no services were entered yet, the list in salon.config.js is used.
export function createKnowledge({ db, config, ttlMs = 30000, now = () => Date.now() }) {
  let cache = null;
  let loadedAt = 0;

  async function load() {
    if (cache && now() - loadedAt < ttlMs) return cache;
    const [sv, st] = await Promise.all([db.collection('services').get(), db.collection('settings').doc('salon').get()]);
    const fromApp = sv.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    cache = {
      services: fromApp.length ? fromApp : config.services.map((s) => ({ note: '', ...s })),
      info: st.exists ? st.data() : {},
    };
    loadedAt = now();
    return cache;
  }

  return { load, invalidate: () => { cache = null; } };
}

/** The knowledge as prompt text (Arabic). Only what the owner wrote — nothing is invented here. */
export function knowledgeText(kb, config) {
  const { services, info } = kb;
  const price = (s) => (s.price != null ? `${s.price} ${config.currency}` : 'السعر بيتحدد بالصالون');
  const lines = [`الخدمات والأسعار:\n${services.map((s) => `- ${s.name}: ${price(s)}${s.note ? ` (${s.note})` : ''}`).join('\n')}`];
  const facts = [['نبذة', info.about], ['العنوان', info.address], ['رابط الموقع على الخريطة', info.maps_url], ['ساعات الدوام', info.hours_text],
    ['طرق الدفع', info.payment], ['سياسة الإلغاء والمواعيد', info.policies]].filter(([, v]) => v);
  if (facts.length) lines.push(`معلومات الصالون:\n${facts.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`);
  if (info.faq?.length) lines.push(`أسئلة شائعة (جاوبي بنفس المعنى):\n${info.faq.map((f) => `- س: ${f.q}\n  ج: ${f.a}`).join('\n')}`);
  return lines.join('\n\n');
}
