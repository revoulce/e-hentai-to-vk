import Fastify, { LogController } from 'fastify';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { z, ZodError } from 'zod';
import { API_PREFIX } from './shared/contracts.js';
import { readToken, type Config } from './config.js';
import { Store } from './database.js';
import { Service } from './service.js';
import { Storage, INPUT_FORMATS } from './storage.js';
import { Worker } from './worker.js';
import { BlockedPublisher, type Publisher } from './publisher.js';
import { VkPublisher } from './vk-publisher.js';
import { AppError, fail } from './errors.js';

const idSchema = z.object({ id: z.string().uuid() });
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  galleryUrl: z.string().max(200).optional(),
  state: z.enum(['queued','publishing','retry_wait','partial','needs_attention','scheduled','completed','cancelled']).optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
}).strict();

export async function buildApp(config: Config, options: {
  now?: () => Date; publisher?: Publisher; logger?: boolean; wait?: (ms: number) => Promise<unknown>;
  beforeClose?: () => Promise<void>;
  autoDispatch?: boolean;
} = {}) {
  // Fail startup before opening persistent state if the owner secret is invalid.
  readToken(config.tokenFile);
  const store = new Store(join(config.dataDir, 'state.sqlite'));
  const service = new Service(store, config, options.now);
  const storage = new Storage(service);
  const publisher: Publisher = options.publisher ?? (config.vk ? new VkPublisher(config.vk, {
    pinGroup: groupId => store.transaction(() => {
      const saved = store.db.prepare('SELECT group_id FROM vk_target WHERE singleton = 1').get();
      if (saved && saved.group_id !== groupId) throw new Error('VK_GROUP_MISMATCH');
      if (!saved) store.db.prepare('INSERT INTO vk_target VALUES (1, ?)').run(groupId);
    }),
  }) : new BlockedPublisher());
  const worker = new Worker(service, publisher, options.wait);
  try { await storage.init(); worker.recover(); await storage.cleanup(); await publisher.check?.(); }
  catch (error) { store.close(); throw error; }
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    logController: new LogController({ disableRequestLogging: true }), genReqId: () => randomUUID(), requestIdHeader: false,
    bodyLimit: 64 * 1024, requestTimeout: 120_000, connectionTimeout: 10_000,
  });
  const dispatches = new Set<Promise<void>>();
  let closing = false;
  const dispatch = () => {
    if (options.autoDispatch === false || closing) return;
    const task = new Promise<void>(resolve => setImmediate(resolve)).then(() => worker.tick())
      .catch(() => app.log.error('VK scheduling failed'));
    dispatches.add(task);
    void task.then(() => dispatches.delete(task));
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (['/ehvk/health/live', '/ehvk/health/ready'].includes(request.url.split('?')[0]!)) return;
    let expected: string;
    try { expected = readToken(config.tokenFile); }
    catch { fail('AUTH_UNAVAILABLE', 'Серверный секрет недоступен.', 503, true); }
    const provided = request.headers.authorization ?? '';
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(provided), digest(`Bearer ${expected}`))) {
      reply.header('WWW-Authenticate', 'Bearer');
      fail('UNAUTHORIZED', 'Требуется API-токен владельца.', 401);
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    app.log.info({ request_id: request.id, method: request.method, route: request.routeOptions.url,
      status: reply.statusCode }, 'request');
  });
  app.setErrorHandler((error, request, reply) => {
    let safe: AppError;
    if (error instanceof AppError) safe = error;
    else if (error instanceof ZodError) safe = new AppError('VALIDATION_ERROR', 'Недопустимые параметры запроса.');
    else if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500)
      safe = new AppError('INVALID_REQUEST', 'Некорректный HTTP-запрос.', error.statusCode);
    else {
      safe = new AppError('INTERNAL_ERROR', 'Внутренняя ошибка сервера.', 500, true);
      app.log.error({ request_id: request.id, error_type: error instanceof Error ? error.name : 'unknown' }, 'request failed');
    }
    reply.code(safe.status).send({ code: safe.code, message: safe.message, retryable: safe.retryable, request_id: request.id });
  });
  app.setNotFoundHandler((_request, _reply) => fail('NOT_FOUND', 'Маршрут не найден.', 404));
  app.get('/ehvk/health/live', async () => ({ status: 'ok' }));
  app.get('/ehvk/health/ready', async (_request, reply) => {
    try { store.db.prepare('SELECT 1').get(); await storage.ready(); return { status: 'ok' }; }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
  });
  const status = async () => ({
    version: '0.1.0', queuePaused: service.settings().paused,
    storageReady: await storage.ready().then(() => true, () => false),
    vk: { ...publisher.status?.(), verified: publisher.available() && !worker.authBlocked, authorizationBlocked: worker.authBlocked,
      state: worker.authBlocked ? 'authorization_required' : publisher.status?.().state ?? (publisher.available() ? 'ready' : 'integration_required') },
    nextSlots: worker.forecast(),
    limits: { maxFileBytes: config.maxFileBytes, maxPixels: config.maxPixels, quotaBytes: config.quotaBytes,
      acceptedFormats: INPUT_FORMATS, outputFormats: ['image/jpeg', 'image/png'] },
  });
  app.get(`${API_PREFIX}/status`, status);
  app.post(`${API_PREFIX}/vk/check`, async () => { await worker.checkPublisher(); return status(); });
  app.get(`${API_PREFIX}/settings`, async () => service.settings());
  app.patch(`${API_PREFIX}/settings`, async request => {
    const settings = service.updateSettings(request.body); dispatch(); return settings;
  });
  app.post(`${API_PREFIX}/drafts`, async (request, reply) => reply.code(201).send(service.createDraft(request.body)));
  app.get(`${API_PREFIX}/drafts/:id`, async request => service.draft(idSchema.parse(request.params).id));
  app.patch(`${API_PREFIX}/drafts/:id`, async request => service.patchDraft(idSchema.parse(request.params).id, request.body));
  app.post(`${API_PREFIX}/drafts/:id/confirm`, async request => {
    const key = request.headers['idempotency-key'];
    const job = await service.confirm(idSchema.parse(request.params).id, request.body, typeof key === 'string' ? key : '');
    dispatch(); return job;
  });
  app.register(async uploads => {
    uploads.addContentTypeParser(['application/octet-stream', ...INPUT_FORMATS],
      (_request, payload, done) => done(null, payload));
    uploads.put(`${API_PREFIX}/drafts/:id/assets/:assetId`, async request => {
      const params = z.object({ id: z.string().uuid(), assetId: z.string().uuid() }).parse(request.params);
      const rawVersion = request.headers['if-match'];
      if (typeof rawVersion !== 'string' || !/^"[1-9]\d*"$/.test(rawVersion)) fail('VERSION_REQUIRED', 'Нужна версия предпросмотра в If-Match: "1".');
      const version = z.coerce.number().int().positive().parse(rawVersion.slice(1, -1));
      const rawLength = request.headers['content-length'];
      const bytes = rawLength === undefined ? undefined : z.coerce.number().int().nonnegative().parse(rawLength);
      return storage.upload(params.id, params.assetId, version, request.body as Readable,
        String(request.headers['x-source-kind'] ?? 'page'), bytes);
    });
  });
  app.get(`${API_PREFIX}/assets/:id/preview`, async (request, reply) => {
    const preview = storage.preview(idSchema.parse(request.params).id);
    return reply.type(preview.mime).send(preview.stream);
  });
  app.get(`${API_PREFIX}/jobs`, async request => ({
    ...service.listJobs(pageSchema.parse(request.query)), nextSlots: worker.forecast(),
  }));
  app.get(`${API_PREFIX}/history`, async request => service.listJobs(pageSchema.parse(request.query), true));
  app.get(`${API_PREFIX}/jobs/:id`, async request => service.job(idSchema.parse(request.params).id));
  app.post(`${API_PREFIX}/jobs/:id/cancel`, async request => service.cancel(idSchema.parse(request.params).id));
  app.post(`${API_PREFIX}/jobs/:id/retry`, async request => {
    const result = service.retry(idSchema.parse(request.params).id); worker.authBlocked = false; dispatch(); return result;
  });
  app.post(`${API_PREFIX}/jobs/:id/reconcile`, async request => {
    const job = await worker.reconcileJob(idSchema.parse(request.params).id); dispatch(); return job;
  });
  for (const [action, paused] of [['pause', true], ['resume', false]] as const) {
    app.post(`${API_PREFIX}/queue/${action}`, async () => {
      const settings = service.pause(paused); if (!paused) dispatch(); return settings;
    });
  }
  app.addHook('preClose', async () => { closing = true; await Promise.all([...dispatches]); await options.beforeClose?.(); });
  app.addHook('onClose', async () => store.close());
  await app.ready();
  return { app, service, storage, worker };
}
