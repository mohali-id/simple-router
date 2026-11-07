# PLAN.md — Roadmap simple-router

AI API router sederhana (tanpa UI) berbasis `config.yaml`. Detail arsitektur & aturan: lihat [AGENTS.md](AGENTS.md).

## Keputusan desain

- **Stack**: TypeScript + Hono (`@hono/node-server`), `zod`, `yaml`, `vitest`.
- **Translasi format**: ya — Anthropic Messages ↔ OpenAI Chat Completions ↔ OpenAI Responses, termasuk streaming. Hub format internal = OpenAI Chat Completions.
- **Route multi-model**: fallback berurutan (429 / 5xx / timeout / network error → target berikutnya).
- **`openai-completions`** = Chat Completions (`/v1/chat/completions`).
- Endpoint non-chat (images, audio, embeddings, moderation): passthrough saja, tanpa translasi.
- **Files & Vector Stores**: passthrough ke satu provider, tanpa translasi dan tanpa fallback. Provider dipilih dari header `x-router-provider`, atau default `application.resources.*.provider`. Router tidak menyimpan mapping ID.

## Temuan pada `config.yaml` saat ini

- [ ] Route id `"gpt-6-astra "` punya trailing space → trim saat load & perbaiki di file.
- [ ] Model `gpt-6-astra` punya `name: GPT-4` (kosmetik, sebaiknya disamakan).
- [ ] API key client & provider ditulis plaintext → dukung `${ENV_VAR}` + `.env`; `config.yaml` masuk `.gitignore`, sediakan `config.example.yaml`.
- [ ] Belum ada bagian `server` → tambah `server: { host: 127.0.0.1, port: 20128, timeout-ms: 600000 }` (bisa dioverride env `HOST`/`PORT`).
- [ ] Path endpoint sebaiknya berprefix `/v1` dan sesuai OpenAI: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/images/generations`, `/v1/audio/speech`, `/v1/embeddings`, `/v1/moderations`.
- [ ] Tambah api-types & endpoints `openai-files`, `anthropic-files`, `openai-vector-stores`, plus bagian `application.resources` (lihat contoh di bawah).
- [x] Route `opus-5-5` → `openai/gpt-6-astra` (api-type `openai-responses`): client Anthropic `/v1/messages` akan butuh translasi Anthropic → Responses. Pastikan ini tercakup di Fase 6–7.

Contoh bentuk config yang dituju:

```yaml
server:
  host: 127.0.0.1
  port: 20128
application:
  auth:
    - type: api-key
      name: My API Key
      key: ${ROUTER_API_KEY}
  endpoints:
    - id: openai-completions
      url: /v1/chat/completions
      method: POST
    - id: openai-files
      url: /v1/files
      method: [GET, POST, DELETE]
    - id: openai-vector-stores
      url: /v1/vector_stores
      method: [GET, POST, DELETE]
  resources:
    files:
      provider: openai        # default jika client tidak kirim x-router-provider
    vector-stores:
      provider: openai
providers:
  - id: openai
    base-url: https://api.openai.com/v1
    api-key: ${OPENAI_API_KEY}
routes:
  - id: opus-5-5
    models:
      - anthropic/claude-opus-5-5   # dicoba pertama
      - openai/gpt-6-astra          # fallback
```

---

## Fase 0 — Scaffold

- [x] `git init`, `.gitignore` (`node_modules`, `dist`, `.env`, `config.yaml`)
- [x] `package.json` (type module, scripts: dev/build/start/typecheck/test), `tsconfig.json` strict
- [x] Install: `hono @hono/node-server yaml zod dotenv`; dev: `typescript tsx vitest @types/node`
- [x] `config.example.yaml` tanpa secret

## Fase 1 — Config

- [x] `src/config/schema.ts`: zod schema semua bagian (kebab-case key dipetakan ke camelCase)
- [x] `src/config/load.ts`: baca YAML, interpolasi `${VAR}` (error jika var kosong), trim semua id
- [x] `src/config/validate.ts`: route → `provider/model` harus ada di `models[]`; model → provider ada; id unik
- [x] Error startup yang jelas (path field + pesan), exit code ≠ 0
- [x] Test: config valid, referensi rusak, env interpolation

## Fase 2 — Server & auth

- [x] `createApp(config)` di `src/app.ts`, `src/index.ts` untuk listen
- [x] Middleware auth: `Authorization: Bearer <key>` atau `x-api-key`
- [x] `GET /health` (tanpa auth), `GET /v1/models` (list routes, format OpenAI)
- [x] Request logging: id, endpoint, route, target, status, latency (tanpa secret/prompt)
- [x] Test: 401 tanpa key, 200 dengan key, list models

## Fase 3 — Passthrough

- [x] `src/router/resolve.ts`: `model` → daftar target (route id, atau `provider/model` langsung)
- [x] `src/providers/client.ts`: URL + header per api-type (OpenAI Bearer; Anthropic `x-api-key` + `anthropic-version`)
- [x] Handler semua endpoint: ganti `model` dengan id upstream, teruskan body
- [x] Streaming SSE di-pipe langsung (tanpa buffering); multipart untuk audio/images edit diteruskan apa adanya
- [x] Test dengan upstream mock: non-stream, stream, non-chat endpoint

## Fase 4 — Fallback

- [x] `src/router/fallback.ts`: coba target berurutan
- [x] Fallback pada network error, timeout (`AbortSignal.timeout`), 429, 5xx; 4xx lain langsung dikembalikan
- [x] Tidak fallback setelah stream mulai dikirim ke client
- [x] Skip target yang api-type-nya tidak bisa melayani endpoint (mis. route chat dipanggil dari `/v1/images/...`)
- [x] Header respons `x-router-target: provider/model` untuk debugging
- [x] Test: target 1 gagal 500 → target 2 sukses; 400 tidak di-fallback

## Fase 5 — Files & Vector Stores

- [x] Schema config: `application.resources.files.provider`, `application.resources.vector-stores.provider` (validasi: provider ada)
- [x] `src/routes/resources.ts` (`selectResourceProvider`): pilih provider dari `x-router-provider` → config → 400 `provider_required`
- [x] Files: `POST /v1/files` (multipart, di-stream), `GET /v1/files`, `GET /v1/files/:id`, `DELETE /v1/files/:id`, `GET /v1/files/:id/content` (download di-stream)
- [x] Vector stores: `/v1/vector_stores` CRUD, `/:id/files`, `/:id/file_batches` (+ `/cancel`, `/files`), `/:id/search`. Query string (`limit`, `after`, `order`, `purpose`) diteruskan
- [x] Provider Anthropic: header `anthropic-version` + `anthropic-beta: files-api-2025-04-14`; vector store ke Anthropic → 400
- [x] Ganti header auth client dengan key provider; teruskan header aman lainnya (`OpenAI-Beta`, `anthropic-beta`, `content-type`)
- [x] Resolve route: jika request membawa `x-router-provider`, lewati target dari provider lain (agar `file_id` / `vector_store_ids` valid)
- [ ] (Opsional, belum) `/v1/uploads` (multipart upload besar OpenAI)
- [x] Test dengan upstream mock: upload multipart, list dengan query, download stream, provider tidak ada → 400

## Fase 6 — Translasi non-stream

Hub = OpenAI Chat Completions. Translator: `anthropic ↔ hub`, `responses ↔ hub`.

- [x] Request: system prompt, messages, content parts (text, image url/base64), `max_tokens`/`max_output_tokens`, temperature, top_p, stop, tools, tool_choice, tool calls & tool results
- [x] Response: content text, tool calls, `finish_reason` ↔ `stop_reason` ↔ `status`, usage (prompt/input, completion/output tokens)
- [x] Error mapping ke format inbound
- [x] Unit test berbasis fixture untuk setiap arah

## Fase 7 — Translasi streaming

- [x] Parser & writer SSE (`src/sse.ts`)
- [x] OpenAI chat chunk → Anthropic events (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`)
- [x] Anthropic events → OpenAI chat chunk (termasuk `[DONE]`)
- [x] Responses events (`response.output_text.delta`, `response.function_call_arguments.delta`, `response.completed`) ↔ hub
- [x] Tool call delta & usage di akhir stream
- [x] Test: replay fixture stream, bandingkan output event

## Fase 8 — Hardening

- [x] Timeout per request dari config
- [x] Cooldown target yang baru gagal (skip sementara, mis. 60 detik)
- [x] Hot reload config saat file berubah
- [x] Dockerfile + contoh `docker run`

---

## Verifikasi manual

```bash
curl http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer $ROUTER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-astra","messages":[{"role":"user","content":"halo"}]}'
```

```bash
curl -N http://127.0.0.1:20128/v1/messages \
  -H "x-api-key: $ROUTER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"opus-5-5","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"halo"}]}'
```

```bash
curl http://127.0.0.1:20128/v1/files \
  -H "Authorization: Bearer $ROUTER_API_KEY" -H "x-router-provider: openai" \
  -F purpose=assistants -F file=@./contoh.pdf
```

```bash
curl http://127.0.0.1:20128/v1/vector_stores \
  -H "Authorization: Bearer $ROUTER_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"docs","file_ids":["file-xxx"]}'
```

## Docker

Dengan compose (disarankan): butuh `.env` dan `config.yaml` di root proyek.

```bash
docker compose up -d --build
```

```bash
docker compose logs -f router
```

Tanpa compose:

```bash
docker build -t simple-router .
```

```bash
docker run -p 20128:20128 --env-file .env -e CONFIG_POLL_MS=2000 -v "$(pwd)/config.yaml:/app/config/config.yaml:ro" simple-router
```

- [x] `Dockerfile` multi-stage (deps → build → prod-deps → runtime), user non-root, healthcheck
- [x] `compose.yaml`: env dari `.env`, config read-only, filesystem read-only, hot reload via polling
- [x] Diverifikasi: container healthy, request ditranslasi, hot reload jalan, stop graceful (~1 detik)

## Out of scope

UI/dashboard, database, OAuth login ke provider, usage tracking/billing, load balancing round-robin.
