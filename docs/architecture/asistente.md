# Referencia técnica: asistente

### Assistant (Gemini)

`src/assistant/` is an operator-facing chat (`POST /assistant/chat`, plus an SSE `chat/stream` that still buffers
the whole answer before emitting it). The Google key stays server-side. The model gets **read-only tools only** —
no SQL, no mutations — and every tool execution re-checks the tenant scope. `knowledge.ts` is versioned product
guidance that must be updated when screens, rules or permissions change. History and rate limits (8
questions/minute, one concurrent per user/playa) are per-process in memory; multiple instances would need shared
storage. Each question (text, topic from `temas.ts`, answered or not — never the answer) is also persisted in the
playa-scoped `assistant_preguntas` table, which feeds the super admin's metrics screen. `gemini-request.ts` owns retries and fallback models within a 65s budget. See `src/assistant/README.md`.
