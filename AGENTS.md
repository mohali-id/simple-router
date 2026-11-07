# AGENTS.md — simple-router

Panduan untuk AI coding agent (Claude Code, Codex, Cursor, dll.) yang bekerja di repo ini.

## Ringkasan proyek

**simple-router** adalah AI API router versi sederhana (terinspirasi 9router). Satu proses Node.js menerima
request berformat OpenAI / Anthropic dari client, memetakan field `model` ke **route** di `config.yaml`,
lalu meneruskannya ke provider upstream — dengan **translasi format** bila perlu dan **fallback berurutan**
bila provider gagal.

**Non-goals** (jangan dibuat kecuali diminta):
- Tidak ada UI / dashboard / web admin.
- Tidak ada database. Semua state (cooldown, statistik) cukup di memori.
- Tidak ada OAuth login ke provider, usage billing, atau load balancing round-robin.

Roadmap & status pekerjaan ada di [PLAN.md](PLAN.md). Selalu cek fase aktif di sana sebelum mulai.

## Stack

- Node.js ≥ 20 (pakai `fetch` & Web Streams bawaan), **TypeScript** strict, ESM.
- **Hono** + `@hono/node-server` untuk HTTP server.
- `yaml` untuk parse config, `zod` untuk validasi schema.
- `vitest` untuk test, `tsx` untuk dev.

## Perintah

```bash
npm install
npm run dev         # tsx watch src/index.ts
npm run build       # tsc -> dist/
npm start           # node dist/index.js
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Env var: `CONFIG_PATH` (default `./config.yaml`), `PORT`, `HOST`, `LOG_LEVEL`, `CONFIG_POLL_MS`
(>0 = hot reload pakai polling, untuk bind mount Docker). File `.env` dibaca saat startup.

Docker: `Dockerfile` (multi-stage, user `node`, healthcheck `/health`) dan `compose.yaml`
(mount `./config.yaml` read-only, secret dari `.env`, port host `ROUTER_PORT`, default `127.0.0.1:20128`).
Dari dalam container, upstream di mesin host dipanggil lewat `host.docker.internal`, bukan `localhost`.

## Struktur folder

```
src/
  index.ts              # bootstrap: load config, serve, hot reload, graceful shutdown
  app.ts                # createApp(config, deps) -> Hono app; DEFAULT_ENDPOINTS; /health, /v1/models
  context.ts            # RouterContext (config, state, logger, fetch) & tipe variabel Hono
  auth.ts               # ambil & cocokkan key client (Bearer / x-api-key, constant-time)
  errors.ts             # RouterError + body error format OpenAI / Anthropic
  http.ts               # whitelist header request/response, SSE headers
  logger.ts             # logger satu baris (LOG_LEVEL), tanpa secret
  stream-log.ts         # bungkus body SSE: log first event, tiap event (debug), stream done
  state.ts              # state in-memory: cooldown per target
  sse.ts                # parser & writer SSE
  config/
    schema.ts           # zod schema config.yaml (strict: field typo ditolak)
    interpolate.ts      # ${VAR} / ${VAR:-default}
    load.ts             # baca file, interpolasi, validasi, override HOST/PORT
    validate.ts         # validasi silang + normalisasi ke camelCase
    api-types.ts        # daftar api-type yang dikenal
  router/
    resolve.ts          # model client -> daftar target (cooldown di akhir, filter x-router-provider)
    fallback.ts         # tryTargets: coba target berurutan, klasifikasi error
    paths.ts            # path upstream per api-type
  providers/
    client.ts           # header auth per provider type, timeout sampai header, fetch
  translate/
    types.ts            # tipe hub (OpenAI Chat Completions) + TranslationError
    chat.ts             # Chat <-> hub (normalisasi)
    anthropic.ts        # Anthropic Messages <-> hub
    responses.ts        # OpenAI Responses <-> hub
    stream/             # parser upstream SSE -> chunk hub, emitter chunk hub -> SSE inbound
    index.ts            # translateRequest / translateResponse / translateStream
  routes/
    chat.ts             # /v1/chat/completions, /v1/responses, /v1/messages
    model-passthrough.ts# images, audio, embeddings, moderations (JSON & multipart)
    resources.ts        # /v1/files/**, /v1/vector_stores/** (pilih provider, passthrough stream)
tests/
  helpers.ts            # config test, mock fetch upstream, helper SSE
  *.test.ts             # per fase: config, server, passthrough, fallback, resources, translate, stream
```

Pola test: `makeApp(upstream)` membuat app dengan `fetch` palsu; panggil `app.request(path, authed({...}))`
dan periksa `calls` (request yang dikirim ke upstream). Tidak ada network sungguhan.

## Skema `config.yaml`

| Bagian | Arti |
|---|---|
| `server` | `host`, `port`, `timeout-ms` (tunggu header upstream), `cooldown-ms`, `hot-reload`, `base-path` (prefix semua endpoint; di-strip sekali di `createApp` sebelum routing, `/health` tetap juga di root). Semua opsional. |
| `application.auth[]` | API key yang boleh dipakai client (`type: api-key`, `name`, `key`). |
| `application.endpoints[]` | Endpoint inbound. `id` = format request yang diterima endpoint tsb, `url` = path, `method` = string atau list. Kosong → `DEFAULT_ENDPOINTS` (`/v1/...`). |
| `application.api-types[]` | Katalog format API (opsional). Jika diisi, endpoint & model hanya boleh memakai api-type yang terdaftar. |
| `providers[]` | Upstream: `id`, `type` (`openai`/`anthropic`, default ditebak dari base-url), `base-url`, `api-key`. |
| `models[]` | Model upstream: `id` (nama model di provider), `provider`, `api-type` (format yang dipakai saat memanggil upstream), `capabilities`. |
| `routes[]` | "Model virtual" yang dikirim client di field `model`. `models: [provider/model-id, ...]` = rantai fallback berurutan. |
| `application.resources` | Provider default untuk resource stateful yang tidak punya field `model`: `files.provider`, `vector-stores.provider`. |

Pemetaan endpoint ↔ path upstream:

| api-type | Path inbound | Path upstream |
|---|---|---|
| `openai-completions` | `/v1/chat/completions` | `{base-url}/chat/completions` |
| `openai-responses` | `/v1/responses` | `{base-url}/responses` |
| `anthropic-messages` | `/v1/messages` | `{base-url}/messages` |
| `openai-images` | `/v1/images/generations` | `{base-url}/images/generations` |
| `openai-audio` | `/v1/audio/speech`, `/v1/audio/transcriptions` | path yang sama |
| `openai-embeddings` | `/v1/embeddings` | `{base-url}/embeddings` |
| `openai-moderation` | `/v1/moderations` | `{base-url}/moderations` |
| `openai-files` / `anthropic-files` | `/v1/files`, `/v1/files/:id`, `/v1/files/:id/content` | path yang sama |
| `openai-vector-stores` | `/v1/vector_stores/**` (CRUD, `/files`, `/file_batches`, `/search`) | path yang sama |

Catatan: `openai-completions` berarti **Chat Completions**, bukan legacy `/completions`.

## Alur request

1. **Auth** — cocokkan key dengan `application.auth[]`. Gagal → 401 dalam format endpoint inbound.
2. **Resolve** — cari `routes[].id === body.model`. Jika tidak ada tapi berbentuk `provider/model-id` yang valid, pakai langsung. Jika tidak ketemu → 404 `model_not_found`.
3. **Untuk tiap target (fallback berurutan)**:
   - Format inbound == `api-type` model → **passthrough** (hanya ganti `model`).
   - Berbeda dan keduanya format chat (`openai-completions`, `openai-responses`, `anthropic-messages`) → **translasi** via hub: inbound → hub (OpenAI Chat) → upstream, dan respons sebaliknya.
   - Endpoint non-chat (images, audio, embeddings, moderation) **tidak ditranslasi**; jika api-type tidak cocok → lewati target / 400.
   - Header auth upstream: OpenAI `Authorization: Bearer`, Anthropic `x-api-key` + `anthropic-version: 2023-06-01`.
4. **Fallback** — pindah ke target berikutnya jika: network error, timeout, HTTP 408/429/5xx, api-type tidak cocok, atau fitur tidak bisa ditranslasi (`TranslationError`, mis. tool bawaan Responses / `previous_response_id`). Error 4xx lain dikembalikan langsung ke client. **Jangan fallback setelah header respons stream terkirim ke client**; error di tengah stream dikirim sebagai event error format inbound.
5. **Cooldown** — target yang gagal karena upstream (bukan karena tidak cocok) dipindah ke akhir antrean selama `cooldown-ms`.
6. Semua target gagal → error dengan ringkasan semua target, status = status terakhir.
7. Header respons: `x-router-route`, `x-router-target` (`provider/model`), `x-router-request-id`.

Batasan translasi yang disengaja: `reasoning_effort` tidak dikirim ke Anthropic (thinking butuh aturan khusus);
upstream Chat dipanggil dengan `max_completion_tokens`; blok thinking hasil translasi ke Anthropic tidak punya `signature`.

## Resource stateful: Files & Vector Stores

Files dan vector store **disimpan di provider**, jadi aturannya berbeda dari endpoint model:

- **Pemilihan provider** (tidak ada field `model`), urutan prioritas:
  1. Header `x-router-provider: <provider-id>` dari client.
  2. `application.resources.files.provider` / `application.resources.vector-stores.provider` di config.
  3. Tidak ada keduanya → 400 `provider_required`.
- **Passthrough murni**: tanpa translasi format, tanpa fallback. Retry ke provider lain tidak ada artinya karena resource hanya ada di satu provider.
- ID resource (`file-...`, `vs_...`) diteruskan apa adanya; router **tidak menyimpan mapping** (sesuai non-goal tanpa database).
- Upload `multipart/form-data` dan download `/content` di-**stream** tanpa buffering ke memori.
- Provider Anthropic (Files API beta): tambahkan header `anthropic-version` dan `anthropic-beta: files-api-2025-04-14`, lalu teruskan header `anthropic-beta` milik client jika ada. Anthropic **tidak punya vector store**; arahkan `/v1/vector_stores/**` ke provider Anthropic → 400.
- Header auth client (`Authorization` / `x-api-key`) **tidak boleh** diteruskan ke upstream. Ganti dengan key provider.
- **Batasan yang perlu didokumentasikan ke user**: request chat yang mereferensikan `file_id` / `vector_store_ids` (mis. tool `file_search` di Responses, blok `document` dengan `file_id` di Anthropic) hanya valid di provider pemilik resource. Saat resolve route, target yang provider-nya berbeda dari `x-router-provider` (jika dikirim) dilewati. Tanpa header tersebut, fallback ke provider lain bisa gagal dengan error 4xx dari upstream.

## Aturan wajib

- **Jangan pernah log API key** (client maupun provider) atau isi prompt/response. Log cukup: request id, endpoint, route, target, status, latency, flag fallback.
- Streaming SSE harus diteruskan **chunk-per-chunk** tanpa buffering seluruh respons.
- Translator adalah **fungsi murni** (input JSON → output JSON; stream = state machine kecil) agar mudah di-unit-test dengan fixture.
- Error yang dikirim ke client selalu dalam **format endpoint inbound** (OpenAI: `{error:{message,type,code}}`; Anthropic: `{type:"error",error:{type,message}}`).
- Field yang tidak dikenali saat translasi: buang dengan aman, jangan crash.
- Setiap perubahan schema config → update `src/config/schema.ts`, `config.example.yaml`, dan test.
- `config.yaml` berisi secret: jangan di-commit; gunakan `config.example.yaml` + `${ENV_VAR}`.

## Konvensi kode

- ESM, `"strict": true`, hindari `any` (pakai `unknown` + narrowing / zod).
- Fungsi kecil dan eksplisit, hindari class besar & abstraksi berlebihan — ini proyek *simple*.
- Nama file kebab/lower-case, satu tanggung jawab per file.
- Test diletakkan di `tests/` dengan nama `*.test.ts`; upstream di-mock dengan server Hono lokal atau stub `fetch`.
- Komentar & dokumentasi boleh Bahasa Indonesia atau Inggris, konsisten per file.
