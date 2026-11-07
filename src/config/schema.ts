import { z } from 'zod';

/**
 * Schema mentah config.yaml (key kebab-case seperti di file).
 * Normalisasi ke bentuk camelCase dilakukan di load.ts.
 */

const id = z.string().trim().min(1, 'tidak boleh kosong');

const httpMethod = z
  .string()
  .trim()
  .transform((m) => m.toUpperCase())
  .pipe(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']));

const url = z
  .string()
  .trim()
  .refine((v) => URL.canParse(v), 'harus URL yang valid')
  .transform((v) => v.replace(/\/+$/, ''));

const resourceTarget = z.object({ provider: id }).strict();

export const rawConfigSchema = z
  .object({
    server: z
      .object({
        host: z.string().trim().min(1).default('127.0.0.1'),
        port: z.coerce.number().int().min(1).max(65535).default(20128),
        /** Batas waktu menunggu header respons upstream (bukan durasi stream). */
        'timeout-ms': z.coerce.number().int().positive().default(600_000),
        /** Lama target di-skip (dipindah ke akhir antrean) setelah gagal. 0 = nonaktif. */
        'cooldown-ms': z.coerce.number().int().min(0).default(60_000),
        /** Muat ulang config otomatis saat file berubah. */
        'hot-reload': z.boolean().default(true),
      })
      .strict()
      .default({ host: '127.0.0.1', port: 20128, 'timeout-ms': 600_000, 'cooldown-ms': 60_000, 'hot-reload': true }),

    application: z
      .object({
        name: z.string().default('simple-router'),
        version: z.string().optional(),
        description: z.string().optional(),
        auth: z
          .array(
            z
              .object({
                type: z.literal('api-key'),
                name: z.string().trim().min(1),
                key: z.string().trim().min(8, 'minimal 8 karakter'),
              })
              .strict(),
          )
          .min(1, 'minimal satu API key client'),
        endpoints: z
          .array(
            z
              .object({
                id,
                url: z.string().trim().startsWith('/', 'harus diawali "/"'),
                method: z.union([httpMethod, z.array(httpMethod).min(1)]),
                description: z.string().optional(),
              })
              .strict(),
          )
          .default([]),
        'api-types': z
          .array(
            z
              .object({
                id,
                name: z.string().optional(),
                description: z.string().optional(),
              })
              .strict(),
          )
          .default([]),
        resources: z
          .object({
            files: resourceTarget.optional(),
            'vector-stores': resourceTarget.optional(),
          })
          .strict()
          .default({}),
      })
      .strict(),

    providers: z
      .array(
        z
          .object({
            id: id.refine((v) => !v.includes('/'), 'tidak boleh mengandung "/"'),
            name: z.string().optional(),
            /** Gaya auth/header upstream. Default: ditebak dari base-url. */
            type: z.enum(['openai', 'anthropic']).optional(),
            'base-url': url,
            'api-key': z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1, 'minimal satu provider'),

    models: z
      .array(
        z
          .object({
            id,
            name: z.string().optional(),
            provider: id,
            'api-type': id,
            description: z.string().optional(),
            capabilities: z.array(z.string().trim()).default([]),
          })
          .strict(),
      )
      .default([]),

    routes: z
      .array(
        z
          .object({
            id,
            name: z.string().optional(),
            models: z.array(id).min(1, 'minimal satu model'),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type RawConfig = z.output<typeof rawConfigSchema>;
