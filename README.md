# simple-router

AI API router sederhana untuk **OpenAI** dan **Anthropic**: satu endpoint untuk banyak provider, dengan
**translasi format** dan **fallback otomatis**. Semua pengaturan ada di satu file `config.yaml`, **tanpa UI**
dan tanpa database. Terinspirasi oleh 9router.

```
client (Claude Code, OpenAI SDK, Cursor, ...)
        │  model: "opus-5-5"
        ▼
  simple-router ── route "opus-5-5" ──► 1. anthropic/claude-opus-5-5   (gagal 529)
                                        2. openai/gpt-6-astra          (dipakai, ditranslasi)
```

## Fitur

- **Satu API, banyak provider** — client mengirim nama *route* di field `model`; router memilih model upstream.
- **Translasi format** — Anthropic Messages ↔ OpenAI Chat Completions ↔ OpenAI Responses, termasuk
  **streaming SSE**, tool calls, gambar/file, reasoning, dan usage. Contoh: Claude Code (format Anthropic)
  bisa memakai model OpenAI.
- **Fallback berurutan** — pindah ke model berikutnya saat 408/429/5xx, timeout, atau network error.
  Target yang baru gagal di-*cooldown* sementara.
- **Passthrough** — images, audio, embeddings, moderations (JSON & multipart).
- **Files & Vector Stores** — diteruskan (streaming) ke satu provider yang dipilih lewat config atau header.
- **Hot reload** config tanpa restart, **Docker** + compose siap pakai.
- Aman secara default: key client dicek constant-time, key/prompt tidak pernah masuk log, container non-root.

## Mulai cepat

Butuh Node.js ≥ 20.

```bash
npm install
```

```bash
cp config.example.yaml config.yaml
```

```bash
cp .env.example .env
```

Isi `.env` (key client router + key provider), sesuaikan `config.yaml`, lalu jalankan:

```bash
npm run dev
```

Router listen di `http://127.0.0.1:20128`. Cek:

```bash
curl http://127.0.0.1:20128/health
```

### Dengan Docker

```bash
docker compose up -d --build
```

```bash
docker compose logs -f router
```

Compose me-mount `./config.yaml` (read-only) dan membaca secret dari `.env`. Port host bisa diganti dengan
`ROUTER_PORT` di `.env`. Hot reload di container memakai polling (`CONFIG_POLL_MS`).

## Konfigurasi

Contoh lengkap ada di [config.example.yaml](config.example.yaml). Nilai `${VAR}` diambil dari environment
(`${VAR:-default}` untuk default), jadi secret cukup disimpan di `.env`.

```yaml
server:
  port: 20128
  timeout-ms: 600000      # batas tunggu header respons upstream (stream tidak dipotong)
  cooldown-ms: 60000      # target gagal dipindah ke akhir antrean selama ini

application:
  auth:
    - { type: api-key, name: default, key: "${ROUTER_API_KEY}" }   # key untuk client router
  resources:
    files: { provider: openai }           # provider default untuk /v1/files
    vector-stores: { provider: openai }   # provider default untuk /v1/vector_stores

providers:
  - { id: openai, base-url: https://api.openai.com/v1, api-key: "${OPENAI_API_KEY}" }
  - { id: anthropic, type: anthropic, base-url: https://api.anthropic.com/v1, api-key: "${ANTHROPIC_API_KEY}" }

models:                                   # model di provider + format API-nya
  - { id: gpt-6-astra, provider: openai, api-type: openai-responses }
  - { id: claude-opus-5-5, provider: anthropic, api-type: anthropic-messages }

routes:                                   # nama yang dikirim client di field `model`
  - id: opus-5-5
    models: [anthropic/claude-opus-5-5, openai/gpt-6-astra]   # rantai fallback
```

| Bagian | Isi |
|---|---|
| `server` | `host`, `port`, `timeout-ms`, `cooldown-ms`, `hot-reload` (semua opsional) |
| `application.auth` | API key yang boleh dipakai client |
| `application.endpoints` | Endpoint yang dibuka (opsional; default semua endpoint `/v1/...` di bawah) |
| `application.resources` | Provider default untuk Files / Vector Stores |
| `providers` | Upstream: `base-url`, `api-key`, `type` (`openai`/`anthropic`, ditebak dari URL bila kosong) |
| `models` | Model upstream: `id`, `provider`, `api-type` |
| `routes` | Model virtual → daftar `provider/model` berurutan |

Config divalidasi saat start (field salah ketik, referensi yang tidak ada, env yang belum di-set) dengan
pesan error yang menunjuk field-nya. Client juga boleh memanggil model langsung sebagai `provider/model-id`.

**Environment variable:** `CONFIG_PATH` (default `./config.yaml`), `HOST`, `PORT`, `LOG_LEVEL`
(`debug`/`info`/`warn`/`error`/`silent`), `CONFIG_POLL_MS`.

## Memakai router

Auth ke router: `Authorization: Bearer <key>` **atau** `x-api-key: <key>`.

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:20128
export ANTHROPIC_AUTH_TOKEN=<ROUTER_API_KEY>
export ANTHROPIC_MODEL=opus-5-5
claude
```

Jika route mengarah ke model OpenAI, request ditranslasi otomatis. Peringatan *"Model isn't recognized"*
dari Claude Code hanya berarti nama route tidak ada di daftar model bawaannya, dan aman diabaikan.

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:20128/v1", api_key="<ROUTER_API_KEY>")
reply = client.chat.completions.create(model="opus-5-5", messages=[{"role": "user", "content": "halo"}])
print(reply.choices[0].message.content)
```

### curl

```bash
curl -N http://127.0.0.1:20128/v1/messages \
  -H "x-api-key: $ROUTER_API_KEY" -H "content-type: application/json" \
  -d '{"model":"opus-5-5","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"halo"}]}'
```

## Endpoint

| Endpoint | Keterangan |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions — translasi & fallback |
| `POST /v1/responses` | OpenAI Responses — translasi & fallback |
| `POST /v1/messages` | Anthropic Messages — translasi & fallback |
| `POST /v1/images/generations`, `/v1/images/edits` | Passthrough + fallback |
| `POST /v1/audio/speech`, `/transcriptions`, `/translations` | Passthrough + fallback (multipart didukung) |
| `POST /v1/embeddings`, `/v1/moderations` | Passthrough + fallback |
| `/v1/files/**` | Files API, passthrough ke satu provider |
| `/v1/vector_stores/**` | Vector Stores API, passthrough ke satu provider (OpenAI) |
| `GET /v1/models`, `/v1/models/:id` | Daftar route (format OpenAI & Anthropic sekaligus) |
| `GET /health`, `GET\|HEAD /api/hello` | Publik, tanpa auth |

Header respons: `x-router-route`, `x-router-target` (model yang dipakai), `x-router-request-id`.

### Fallback

1. Target dicoba berurutan sesuai `routes[].models`.
2. Lanjut ke target berikutnya bila: HTTP 408/429/5xx, timeout, network error, api-type tidak cocok dengan
   endpoint, atau fitur tidak bisa ditranslasi (mis. tool bawaan Responses seperti `web_search`).
3. Error 4xx lain (mis. 400 request salah) langsung dikembalikan tanpa fallback.
4. Setelah header stream terkirim ke client tidak ada fallback lagi; error di tengah stream dikirim sebagai
   event error dalam format client.

### Files & Vector Stores

File dan vector store hanya ada di provider tempat ia dibuat, jadi **tidak ada translasi dan fallback**.
Provider dipilih dari header `x-router-provider: <provider-id>`, atau dari `application.resources`.

```bash
curl http://127.0.0.1:20128/v1/files -H "Authorization: Bearer $ROUTER_API_KEY" \
  -F purpose=assistants -F file=@./dokumen.pdf
```

Request chat yang memakai `file_id` / `vector_store_ids` sebaiknya juga mengirim `x-router-provider`, agar
router hanya memakai target di provider pemilik file tersebut.

## Batasan

- Translasi mencakup fitur umum chat; fitur khusus provider (tool bawaan Responses, `previous_response_id`)
  hanya jalan bila upstream memakai format yang sama.
- `reasoning_effort` tidak diteruskan ke Anthropic; blok thinking hasil translasi tidak punya `signature`.
- Upstream Chat Completions dipanggil dengan `max_completion_tokens`; provider "OpenAI-compatible" yang hanya
  mengenal `max_tokens` bisa menolaknya.
- `user_id` yang lebih dari 64 karakter (mis. dari Claude Code) di-hash sebelum dikirim ke OpenAI.
- Tanpa UI, database, load balancing, atau usage tracking (sengaja).

## Pengembangan

```bash
npm run dev         # jalankan dengan auto-reload
npm run typecheck   # tsc --noEmit
npm test            # vitest (tanpa network: upstream di-mock)
npm run build       # compile ke dist/
```

Struktur kode, aturan, dan alur request ada di [AGENTS.md](AGENTS.md); roadmap di [PLAN.md](PLAN.md).
