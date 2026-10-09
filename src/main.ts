import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  const tasks = new Set<Promise<unknown>>();
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  const { app, worker, storage } = await buildApp(config, { beforeClose: async () => {
    clearInterval(tickTimer); clearInterval(cleanupTimer);
    await Promise.all([...tasks]);
  } });
  try { await app.listen({ host: config.host, port: config.port }); }
  catch (error) { await app.close(); throw error; }
  app.log.info({ publishing_enabled: worker.publisher.available(), vk_state: worker.publisher.status?.().state ?? 'integration_required' }, 'Server started');
  let stopping = false;
  function track(task: Promise<unknown>) {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  }
  track(worker.tick().catch(() => app.log.error('VK scheduling failed')));
  tickTimer = setInterval(() => {
    track(worker.tick().catch(() => app.log.error('Queue check failed')));
  }, 15_000);
  cleanupTimer = setInterval(() => {
    track(storage.cleanup().catch(() => app.log.error('Storage cleanup failed')));
  }, 60_000);
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(tickTimer); clearInterval(cleanupTimer);
    await app.close();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}
main().catch(() => { process.stderr.write('Сервер не запущен. Проверьте конфигурацию, секрет и каталог данных.\n'); process.exitCode = 1; });
