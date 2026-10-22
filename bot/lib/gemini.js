// Minimal Gemini REST client (generateContent with function calling).
// The API key goes in a header, never in the URL or the logs.
//
// The free tier sometimes answers 503 ("high demand") or 429 for a while, so: retry with a growing pause,
// then fall back to a lighter model, before giving up.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 'https://generativelanguage.googleapis.com/v1beta/models';

export function createGemini({
  apiKey, model = process.env.GEMINI_MODEL || 'gemini-flash-latest',
  fallbackModels = (process.env.GEMINI_FALLBACK_MODEL ?? 'gemini-flash-lite-latest').split(',').map((m) => m.trim()).filter(Boolean),
  fetchImpl = fetch, retryDelayMs = 2000, retriesPerModel = 2,
}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is missing');
  const overloaded = (status) => status === 429 || status >= 500;

  /** Returns the model's `content` ({role:'model', parts:[…]}) exactly as received (keeps any thought signatures). */
  async function generate({ system, contents, tools }) {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: tools }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
    });
    let lastError;
    for (const name of [model, ...fallbackModels.filter((m) => m !== model)]) {
      for (let attempt = 0; attempt <= retriesPerModel; attempt += 1) {
        const res = await fetchImpl(`${base}/${name}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body });
        if (res.ok) {
          const content = (await res.json()).candidates?.[0]?.content;
          if (!content?.parts?.length) throw new Error('Gemini returned no content');
          return content;
        }
        lastError = new Error(`Gemini ${res.status} (${name}): ${(await res.text()).slice(0, 160)}`);
        if (!overloaded(res.status)) throw lastError;          // a bad request/key won't improve by retrying
        if (attempt < retriesPerModel) await sleep(retryDelayMs * (attempt + 1));
      }
    }
    throw lastError;
  }
  return { generate, model };
}
