// Minimal Gemini REST client (generateContent with function calling).
// The API key goes in a header, never in the URL or the logs.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createGemini({ apiKey, model = process.env.GEMINI_MODEL || 'gemini-flash-latest', fetchImpl = fetch, retryDelayMs = 2000 }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is missing');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  /** Returns the model's `content` ({role:'model', parts:[…]}) exactly as received (keeps any thought signatures). */
  async function generate({ system, contents, tools }) {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: tools }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
    });
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body });
      if ((res.status === 429 || res.status >= 500) && attempt < 1) { await sleep(retryDelayMs); continue; }
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const content = (await res.json()).candidates?.[0]?.content;
      if (!content?.parts?.length) throw new Error('Gemini returned no content');
      return content;
    }
  }
  return { generate, model };
}
