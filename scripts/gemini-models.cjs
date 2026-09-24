// node --env-file=.env scripts/gemini-models.cjs
// Solo consulta metadatos de modelos. Nunca imprime la clave ni genera contenido.
async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.log('GEMINI_API_KEY no está configurada en este entorno.'); process.exitCode = 1; return; }
  const probe = process.argv.find(argument => argument.startsWith('--probe='));
  if (probe) {
    for (const model of probe.slice('--probe='.length).split(',')) {
      if (!/^[a-zA-Z0-9.-]+$/.test(model)) throw new Error('Invalid model');
      const started = Date.now();
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(20000),
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Respondé solamente OK.' }] }], generationConfig: { maxOutputTokens: 256 } }),
        });
        const body = await response.json();
        const message = typeof body.error?.message === 'string' ? body.error.message.replaceAll(key, '[REDACTED]').replace(/AIza[\w-]+/g, '[REDACTED]').slice(0, 500) : undefined;
        console.log(JSON.stringify({ model, status: response.status, ms: Date.now() - started, errorStatus: body.error?.status, message, finishReason: body.candidates?.[0]?.finishReason, hasText: !!body.candidates?.[0]?.content?.parts?.some(part => part.text && !part.thought) }));
      } catch (error) { console.log(JSON.stringify({ model, ms: Date.now() - started, error: error.name })); }
    }
    return;
  }
  let pageToken;
  do {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) { console.log(`ListModels: HTTP ${response.status}`); process.exitCode = 1; return; }
    const body = await response.json();
    for (const model of body.models ?? []) {
      if (model.supportedGenerationMethods?.includes('generateContent')) console.log(JSON.stringify({ name: model.name, displayName: model.displayName }));
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
}
main().catch(error => { console.log(`ListModels: ${error.name || 'Error'}`); process.exitCode = 1; });
