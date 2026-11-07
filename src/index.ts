import 'dotenv/config';
import { type FSWatcher, type Stats, unwatchFile, watch, watchFile } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { createApp } from './app.js';
import { type Config, ConfigError, loadConfig } from './config/index.js';
import type { AppEnv } from './context.js';
import { createLogger } from './logger.js';
import { createState } from './state.js';

const configPath = resolve(process.env.CONFIG_PATH ?? './config.yaml');
const logger = createLogger();
const state = createState();

function summary(config: Config): string {
  return (
    `${config.providers.length} provider, ${config.models.length} model, ` +
    `${config.routes.length} route, ${config.application.auth.length} client key`
  );
}

async function main(): Promise<void> {
  let config = await loadConfig(configPath);
  let app: Hono<AppEnv> = createApp(config, { logger, state });
  logger.info(`config dimuat: ${summary(config)}`, { file: configPath });

  const server = serve(
    // Delegasi ke `app` terkini agar hot reload tidak perlu restart server.
    { fetch: (req, env) => app.fetch(req, env), hostname: config.server.host, port: config.server.port },
    (info) => logger.info(`simple-router listen di http://${config.server.host}:${info.port}`),
  );

  const reload = async () => {
    try {
      const next = await loadConfig(configPath);
      if (next.server.host !== config.server.host || next.server.port !== config.server.port) {
        logger.warn('perubahan server.host/port butuh restart; nilai lama tetap dipakai');
      }
      config = next;
      app = createApp(next, { logger, state });
      logger.info(`config di-reload: ${summary(next)}`);
    } catch (err) {
      logger.error('reload config gagal, config lama tetap dipakai', {
        reason: err instanceof Error ? err.message.replaceAll('\n', ' | ') : String(err),
      });
    }
  };

  let stopWatching = () => {};
  if (config.server.hotReload) {
    const pollMs = Number(process.env.CONFIG_POLL_MS);
    if (pollMs > 0) {
      // Mode polling: untuk bind mount Docker / network share yang tidak mengirim event file.
      const listener = (curr: Stats, prev: Stats) => {
        if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) void reload();
      };
      watchFile(configPath, { interval: pollMs }, listener);
      stopWatching = () => unwatchFile(configPath, listener);
    } else {
      let timer: NodeJS.Timeout | undefined;
      const watcher: FSWatcher = watch(configPath, () => {
        clearTimeout(timer);
        timer = setTimeout(() => void reload(), 300);
      });
      stopWatching = () => watcher.close();
    }
  }

  const shutdown = (signal: string) => {
    logger.info(`menerima ${signal}, berhenti...`);
    stopWatching();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error('[simple-router] gagal start:', err);
  process.exit(1);
});
