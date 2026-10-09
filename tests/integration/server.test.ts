import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile, readdir, cp } from 'node:fs/promises';
import { DatabaseSync, backup } from 'node:sqlite';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { join } from 'node:path';
import sharp from 'sharp';
import { API_PREFIX, type Role } from '../../src/shared/contracts.js';
import { buildApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { PublicationError, type Publisher, type PublishRequest, type PublishResult, type Reconciliation } from '../../src/publisher.js';
import type { AssetRow } from '../../src/service.js';

const TOKEN = 'test_owner_token_0123456789_abcdefghijklmnop';
const auth = { authorization: `Bearer ${TOKEN}` };
const fixture = (pageCount = 14, id = 123) => ({ galleryUrl: `https://e-hentai.org/g/${id}/abcdef1234/`,
  title: 'Synthetic test gallery', pageCount, tags: { parody: ['Kill la Kill'], character: ['Ryuko Matoi'], cosplayer: ['Test Model'] } });

class FakePublisher implements Publisher {
  calls: PublishRequest[] = [];
  uploads: { id: string; role: Role }[] = [];
  failures: ('transient' | 'authorization' | 'unknown' | 'generic' | 'verification')[] = [];
  failRole: Role = 'donut';
  uploadFailures = 0;
  enabled = true;
  reconciliation: Reconciliation = { status: 'unknown' };
  reconciliations: PublishRequest[] = [];
  check?: () => Promise<void>;
  times: number[] = [];
  available() { return this.enabled; }
  async scheduledTimes() { return this.times; }
  async upload(asset: AssetRow, role: Role) {
    this.uploads.push({ id: asset.id, role });
    if (this.uploadFailures-- > 0) throw new PublicationError('transient');
    return `photo-1_${asset.page}`;
  }
  async publish(request: PublishRequest): Promise<PublishResult> {
    this.calls.push(request);
    if (request.role === this.failRole && this.failures.length) {
      const kind = this.failures.shift()!;
      if (kind === 'generic') throw new Error(`Do not expose ${TOKEN}`);
      if (kind === 'verification') throw new PublicationError('unknown', 'VK_POST_VERIFICATION_FAILED',
        { postId: '-1_2', url: 'https://vk.com/wall-1_2' });
      throw new PublicationError(kind);
    }
    return { postId: `-${request.role === 'public' ? 1 : 2}`, url: `https://vk.com/wall-1_${request.role === 'public' ? 1 : 2}` };
  }
  async reconcile(request: PublishRequest) { this.reconciliations.push(request); return this.reconciliation; }
}

async function setup(t: TestContext, publisher?: Publisher, overrides: Partial<Config> = {}, autoDispatch = false) {
  const directory = await mkdtemp(join(process.cwd(), '.ehvk-test-'));
  const tokenFile = join(directory, 'owner-token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  const config: Config = { host: '127.0.0.1', port: 3000, dataDir: join(directory, 'data'), tokenFile,
    maxFileBytes: 50 * 1024 ** 2, maxPixels: 40_000_000, quotaBytes: 10 * 1024 ** 3, minFreeBytes: 1,
    draftTtlMs: 24 * 3_600_000, completedTtlMs: 72 * 3_600_000, cancelledTtlMs: 24 * 3_600_000, ...overrides };
  let date = new Date('2026-10-08T04:59:00Z');
  let runtime = await buildApp(config, { logger: false, now: () => date, publisher, wait: async () => {}, autoDispatch });
  t.after(async () => { await runtime.app.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get runtime() { return runtime; }, config, directory,
    at(value: string) { date = new Date(value); },
    async restart() { await runtime.app.close(); runtime = await buildApp(config, { logger: false, now: () => date, publisher, wait: async () => {}, autoDispatch }); },
    async request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, payload?: object | Buffer, headers: Record<string,string> = {}) {
      return runtime.app.inject({ method, url: `${API_PREFIX}${path}`, headers: { ...auth, ...headers }, payload });
    },
  };
}
type Harness = Awaited<ReturnType<typeof setup>>;
type Draft = ReturnType<Harness['runtime']['service']['draft']>;

async function png(index: number) {
  return sharp({ create: { width: 8 + index, height: 8, channels: 3, background: { r: index, g: 20, b: 30 } } }).png().toBuffer();
}
async function readyDraft(h: Harness, id = 123) {
  let draft = (await h.request('POST', '/drafts', fixture(14, id))).json<Draft>();
  for (const [i, asset] of draft.assets.entries()) {
    const response = await h.request('PUT', `/drafts/${draft.id}/assets/${asset.id}`, await png(i), {
      'content-type': 'application/octet-stream', 'if-match': `"${draft.version}"`,
    });
    assert.equal(response.statusCode, 200, response.body);
    draft = response.json<Draft>();
  }
  assert.equal(draft.state, 'ready');
  return draft;
}
async function queued(h: Harness, id = 123) {
  const draft = await readyDraft(h, id);
  const response = await h.request('POST', `/drafts/${draft.id}/confirm`, { version: draft.version }, { 'idempotency-key': `test-confirm-${id}` });
  assert.equal(response.statusCode, 200, response.body);
  return { draft, job: response.json<ReturnType<Harness['runtime']['service']['job']>>() };
}

test('configured VK with a missing token reports a safe actionable state; checks require owner authorization', async t => {
  const h = await setup(t, undefined, { vk: { group: 'quetzalcoatl_cosplay', tokenFile: join(process.cwd(), '.missing-vk-token'),
    photoPrivacyVerified: false, timeoutMs: 1000 } });
  const status = (await h.request('GET', '/status')).json();
  assert.equal(status.vk.state, 'authorization_required'); assert.equal(status.vk.code, 'VK_TOKEN_REQUIRED');
  assert.equal(status.vk.verified, false); assert.ok(!JSON.stringify(status).includes('.missing-vk-token'));
  assert.equal((await h.runtime.app.inject({ method: 'POST', url: `${API_PREFIX}/vk/check` })).statusCode, 401);
  assert.equal((await h.request('POST', '/vk/check')).json().vk.verified, false);
});

test('a successful read-only VK check clears authorization blocking without publishing or immediately running a slot', async t => {
  const publisher = new FakePublisher(); const h = await setup(t, publisher);
  publisher.enabled = false; h.runtime.worker.authBlocked = true;
  publisher.check = async () => { publisher.enabled = true; };
  const status = (await h.request('POST', '/vk/check')).json();
  assert.equal(status.vk.verified, true); assert.equal(status.vk.authorizationBlocked, false);
  assert.equal(publisher.calls.length, 0); assert.equal(publisher.uploads.length, 0);
  h.runtime.worker.busy = true;
  assert.equal((await h.request('POST', '/vk/check')).json().code, 'WORKER_BUSY'); h.runtime.worker.busy = false;
});

test('a known VK post ID survives a failed readback and restart; reconciliation completes only the remaining post', async t => {
  const publisher = new FakePublisher(); publisher.failures = ['verification']; const h = await setup(t, publisher);
  const { job } = await queued(h, 990); h.at('2026-10-08T05:00:00Z'); await h.runtime.worker.tick();
  const donut = h.runtime.service.posts(job.id).find(post => post.role === 'donut')!;
  assert.equal(donut.state, 'unknown'); assert.equal(donut.post_id, '-1_2'); assert.equal(donut.post_url, 'https://vk.com/wall-1_2');
  assert.equal(h.runtime.service.job(job.id).last_error, 'VK_POST_VERIFICATION_FAILED');
  assert.equal((await h.request('POST', `/jobs/${job.id}/retry`)).statusCode, 409);
  await h.restart(); publisher.reconciliation = { status: 'posted', result: { postId: '-1_2', url: 'https://vk.com/wall-1_2' } };
  assert.equal((await h.request('POST', `/jobs/${job.id}/reconcile`)).json().state, 'scheduled');
  assert.equal(publisher.reconciliations[0]!.candidatePostId, '-1_2');
  h.at('2026-10-08T07:00:00Z'); await h.runtime.worker.tick();
  assert.deepEqual(publisher.calls.map(call => call.role), ['public', 'donut']);
});

test('health is public; drafts, queue, files and unknown routes require the owner token', async t => {
  const h = await setup(t);
  assert.equal((await h.runtime.app.inject('/ehvk/health/live')).statusCode, 200);
  assert.equal((await h.runtime.app.inject('/ehvk/health/ready')).statusCode, 200);
  for (const path of ['/jobs', '/settings', '/assets/abcd/preview', '/not-found']) {
    const response = await h.runtime.app.inject(`${API_PREFIX}${path}`);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(Object.keys(response.json()).sort(), ['code','message','request_id','retryable']);
    assert.ok(!response.body.includes(TOKEN));
  }
  assert.equal((await h.request('GET', '/status')).json().vk.state, 'integration_required');
  await writeFile(h.config.tokenFile, `${TOKEN}_rotated`);
  assert.equal((await h.request('GET', '/settings')).statusCode, 401);
  assert.equal((await h.request('GET', '/settings', undefined, { authorization: `Bearer ${TOKEN}_rotated` })).statusCode, 200);
});

test('server chooses 4/9 unique pages, enforces versions, rejects 12 pages and URL downloads', async t => {
  const h = await setup(t);
  assert.equal((await h.request('POST', '/drafts', fixture(12))).statusCode, 400);
  assert.equal((await h.request('POST', '/drafts', { ...fixture(), imageUrl: 'http://localhost/private' })).statusCode, 400);
  const response = await h.request('POST', '/drafts', fixture());
  const draft = response.json<Draft>();
  assert.equal(response.statusCode, 201);
  assert.equal(draft.assets.filter(a => a.role === 'public').length, 4);
  assert.equal(draft.assets.filter(a => a.role === 'donut').length, 9);
  assert.equal(new Set(draft.assets.map(a => a.page)).size, 13);
  const replaced = (await h.request('PATCH', `/drafts/${draft.id}`, { version: draft.version, replaceAssetId: draft.assets[0]!.id })).json<Draft>();
  const newAsset = replaced.assets.find(a => !draft.assets.some(old => old.id === a.id))!;
  assert.ok(!draft.assets.some(a => a.page === newAsset.page));
  assert.equal((await h.request('PATCH', `/drafts/${draft.id}`, { version: 1, fields: draft.fields })).statusCode, 409);
  const exact = (await h.request('POST', '/drafts', fixture(13, 124))).json<Draft>();
  assert.equal((await h.request('PATCH', `/drafts/${exact.id}`, { version: 1, replaceAssetId: exact.assets[0]!.id })).json().code, 'NO_REPLACEMENT');
  assert.equal((await h.request('POST', `/drafts/${draft.id}/confirm`, { version: replaced.version }, { 'idempotency-key': 'incomplete-confirm' })).json().code, 'INCOMPLETE_SET');
});

test('upload validates actual file bytes, rejects identical files and protects preview paths', async t => {
  const h = await setup(t);
  const draft = (await h.request('POST', '/drafts', fixture())).json<Draft>();
  const upload = (asset: string, version: number, body: Buffer) => h.request('PUT', `/drafts/${draft.id}/assets/${asset}`, body,
    { 'content-type': 'image/png', 'if-match': `"${version}"` });
  assert.equal((await upload(draft.assets[0]!.id, 1, Buffer.from('not an image'))).json().code, 'INVALID_IMAGE');
  const body = await png(1);
  const firstResponse = await upload(draft.assets[0]!.id, 1, body);
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  const first = firstResponse.json<Draft>();
  assert.equal((await upload(draft.assets[1]!.id, first.version, body)).json().code, 'DUPLICATE_IMAGE');
  assert.equal((await upload(draft.assets[1]!.id, 1, await png(2))).json().code, 'VERSION_CONFLICT');
  const preview = await h.request('GET', `/assets/${draft.assets[0]!.id}/preview`);
  assert.deepEqual(preview.rawPayload, body);
  assert.equal(preview.headers['cache-control'], 'no-store');
  assert.ok(!JSON.stringify(first).includes(h.config.dataDir));
  assert.equal((await readdir(h.runtime.storage.directory)).filter(v => v.endsWith('.part')).length, 0);
});

test('file size, pixel and disk quota limits leave no ready or partial file', async t => {
  for (const [limits, expected, body] of [
    [{ maxFileBytes: 10 }, 'FILE_TOO_LARGE', await png(1)],
    [{ maxPixels: 4 }, 'INVALID_IMAGE', await png(1)],
    [{ quotaBytes: 10 }, 'STORAGE_QUOTA', await png(1)],
  ] as const) {
    const h = await setup(t, undefined, limits);
    const draft = (await h.request('POST', '/drafts', fixture())).json<Draft>();
    const response = await h.request('PUT', `/drafts/${draft.id}/assets/${draft.assets[0]!.id}`, body,
      { 'content-type': 'application/octet-stream', 'if-match': '"1"' });
    assert.equal(response.json().code, expected, response.body);
    assert.equal(h.runtime.service.draft(draft.id).assets[0]!.state, 'pending');
    assert.equal((await readdir(h.runtime.storage.directory)).length, 0);
  }
});

test('concurrent confirmations produce one immutable job; keys cannot be reused for other drafts', async t => {
  const h = await setup(t);
  const draft = await readyDraft(h);
  const responses = await Promise.all(['one', 'two'].map(key => h.request('POST', `/drafts/${draft.id}/confirm`,
    { version: draft.version }, { 'idempotency-key': `concurrent-${key}` })));
  assert.ok(responses.every(r => r.statusCode === 200), responses.map(r=>r.body).join('\n'));
  assert.equal(responses[0]!.json().id, responses[1]!.json().id);
  assert.equal(h.runtime.service.listJobs({ limit: 20, offset: 0 }).total, 1);
  assert.equal((await h.request('PATCH', `/drafts/${draft.id}`, { version: draft.version, fields: draft.fields })).json().code, 'DRAFT_CONFIRMED');
  assert.equal((await h.request('PUT', `/drafts/${draft.id}/assets/${draft.assets[0]!.id}`, await png(20),
    { 'content-type': 'image/png', 'if-match': `"${draft.version}"` })).json().code, 'DRAFT_CONFIRMED');
  const settings = (await h.request('GET', '/settings')).json();
  await h.request('PATCH', '/settings', { version: settings.version, includeModel: false });
  assert.ok(responses[0]!.json().snapshot.texts.public.includes('Модель:'));
  const next = await readyDraft(h, 125);
  assert.equal((await h.request('POST', `/drafts/${next.id}/confirm`, { version: next.version }, { 'idempotency-key': 'concurrent-two' })).json().code, 'IDEMPOTENCY_CONFLICT');
});

test('repeat gallery requires explicit approval again at confirmation; lost file cannot be confirmed', async t => {
  const h = await setup(t);
  await queued(h);
  const draft = await readyDraft(h);
  assert.equal(draft.duplicates.length, 1);
  const headers = { 'idempotency-key': 'repeat-confirm-key' };
  assert.equal((await h.request('POST', `/drafts/${draft.id}/confirm`, { version: draft.version }, headers)).json().code, 'REPEAT_CONFIRMATION_REQUIRED');
  assert.equal((await h.request('POST', `/drafts/${draft.id}/confirm`, { version: draft.version, repeatConfirmed: true }, headers)).statusCode, 200);
  const missing = await readyDraft(h, 129);
  await rm(h.runtime.service.assets(missing.id)[0]!.path!);
  assert.equal((await h.request('POST', `/drafts/${missing.id}/confirm`, { version: missing.version }, { 'idempotency-key': 'missing-confirm-key' })).json().code, 'ASSET_LOST');
});

test('partial Donut failure resumes only Donut in a later slot and survives restart', async t => {
  const publisher = new FakePublisher(); publisher.failures = ['transient'];
  const h = await setup(t, publisher);
  const { job } = await queued(h);
  h.at('2026-10-08T05:00:00Z'); await h.runtime.worker.tick();
  assert.equal(h.runtime.service.job(job.id).state, 'partial');
  assert.equal(h.runtime.service.posts(job.id)[0]!.state, 'scheduled');
  const savedPublic = h.runtime.service.posts(job.id)[0]!.post_id;
  await h.restart();
  h.at('2026-10-08T07:00:00Z'); await h.runtime.worker.tick();
  assert.equal(h.runtime.service.job(job.id).state, 'scheduled');
  assert.equal(h.runtime.service.posts(job.id)[0]!.post_id, savedPublic);
  assert.deepEqual(publisher.calls.map(c => c.role), ['public','donut','donut']);
  assert.equal(publisher.uploads.filter(a => a.role === 'public').length, 4);
  assert.equal(publisher.uploads.filter(a => a.role === 'donut').length, 9);
  assert.ok(publisher.calls.every(c => c.permanentDonut === true));
  assert.deepEqual(publisher.calls[1]!.attachments, publisher.calls[2]!.attachments);
  assert.equal(h.runtime.service.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE operation = 'publish'").get()!.n, 3);
});

test('unknown publication is blocked until reconciliation, without blind retry or cancellation', async t => {
  const publisher = new FakePublisher(); publisher.failures = ['generic'];
  const h = await setup(t, publisher);
  const { job } = await queued(h);
  h.at('2026-10-08T05:00:00Z'); await h.runtime.worker.tick();
  assert.equal(h.runtime.service.job(job.id).state, 'needs_attention');
  assert.equal(h.runtime.service.posts(job.id)[1]!.state, 'unknown');
  assert.equal((await h.request('POST', `/jobs/${job.id}/retry`)).json().code, 'RESULT_UNKNOWN');
  assert.equal((await h.request('POST', `/jobs/${job.id}/cancel`)).json().code, 'RESULT_UNKNOWN');
  assert.equal((await h.request('POST', `/jobs/${job.id}/reconcile`)).json().code, 'RESULT_UNKNOWN');
  h.at('2026-10-08T07:00:00Z'); await h.runtime.worker.tick();
  assert.equal(publisher.calls.length, 2);
  publisher.reconciliation = { status: 'posted', result: { postId: 'found', url: 'https://vk.com/wall-1_88' } };
  assert.equal((await h.request('POST', `/jobs/${job.id}/reconcile`)).json().state, 'scheduled');
  const bytes = await readFile(h.runtime.service.store.path);
  assert.ok(!bytes.includes(Buffer.from(TOKEN)));
  assert.ok(!JSON.stringify(h.runtime.service.job(job.id)).includes(TOKEN));
});

test('recovery of sending intent becomes unknown; confirmed absence allows only remaining post', async t => {
  const publisher = new FakePublisher();
  const h = await setup(t, publisher);
  const { job } = await queued(h);
  const [publicPost, donutPost] = h.runtime.service.posts(job.id);
  h.runtime.service.db.prepare("UPDATE posts SET state = 'posted', post_id = 'known' WHERE id = ?").run(publicPost!.id);
  h.runtime.service.db.prepare("UPDATE posts SET state = 'sending', attachments = ? WHERE id = ?")
    .run(JSON.stringify(Array.from({ length: 9 }, (_, i) => `photo-1_${i}`)), donutPost!.id);
  h.runtime.service.db.prepare("UPDATE jobs SET state = 'publishing' WHERE id = ?").run(job.id);
  await h.restart();
  assert.equal(h.runtime.service.posts(job.id)[1]!.state, 'unknown');
  publisher.reconciliation = { status: 'absent' };
  await h.request('POST', `/jobs/${job.id}/reconcile`);
  h.at('2026-10-08T05:00:00Z'); await h.runtime.worker.tick();
  assert.deepEqual(publisher.calls.map(c => c.role), ['donut']);
  assert.equal(h.runtime.service.job(job.id).state, 'scheduled');
});

test('pause blocks transmission; resume schedules future VK posts immediately and restart never duplicates them', async t => {
  const publisher = new FakePublisher();
  const h = await setup(t, publisher);
  const { job } = await queued(h);
  await h.request('POST', '/queue/pause');
  h.at('2026-10-08T05:00:00Z'); await h.runtime.worker.tick();
  assert.equal(publisher.calls.length, 0);
  h.at('2026-10-08T13:15:00Z'); await h.runtime.worker.tick();
  assert.equal(publisher.calls.length, 0);
  await h.request('POST', '/queue/resume');
  await Promise.all([h.runtime.worker.tick(), h.runtime.worker.tick()]);
  assert.equal(publisher.calls.length, 2);
  assert.equal(publisher.calls[0]!.publishAt, Date.parse('2026-10-08T15:00:00Z') / 1000);
  assert.equal(publisher.calls[1]!.publishAt, Date.parse('2026-10-08T15:01:00Z') / 1000);
  assert.equal(h.runtime.service.job(job.id).state, 'scheduled');
  await h.restart(); h.at('2026-10-09T15:00:00Z');
  await h.runtime.worker.tick();
  assert.equal(publisher.calls.length, 2);
});

test('pairs are transmitted ahead of time; partial jobs take priority and late confirmations receive future times', async t => {
  const publisher = new FakePublisher(); publisher.failures = ['transient'];
  const h = await setup(t, publisher);
  const partial = await queued(h, 130);
  h.at('2026-10-08T05:00:00Z'); await h.runtime.worker.tick();
  const fresh = await queued(h, 131);
  h.at('2026-10-08T07:00:00Z'); await h.runtime.worker.tick();
  assert.equal(h.runtime.service.job(partial.job.id).state, 'scheduled');
  assert.equal(h.runtime.service.job(fresh.job.id).state, 'scheduled');
  assert.deepEqual(publisher.calls.map(call => call.role), ['public','donut','donut','public','donut']);
  assert.equal(publisher.calls[3]!.publishAt! + 60, publisher.calls[4]!.publishAt);
  h.at('2026-10-08T09:00:01Z');
  assert.equal((await h.request('POST', `/jobs/${fresh.job.id}/cancel`)).json().code, 'JOB_IN_VK');
  const late = await queued(h, 132);
  h.at('2026-10-08T09:00:15Z'); await h.runtime.worker.tick();
  assert.equal(h.runtime.service.job(late.job.id).state, 'scheduled');
  assert.equal(publisher.calls[5]!.publishAt, Date.parse('2026-10-08T11:00:00Z') / 1000);
  h.at('2026-10-08T11:00:00Z'); await h.runtime.worker.tick();
  assert.equal(h.runtime.service.job(late.job.id).state, 'scheduled');
});

test('authorization failure halts other jobs until explicit retry; cancelled remainder preserves public post', async t => {
  const publisher = new FakePublisher(); publisher.failures = ['authorization'];
  const h = await setup(t, publisher);
  const first = await queued(h, 133);
  const second = await queued(h, 134);
  h.at('2026-10-08T05:00:00Z'); await h.runtime.worker.tick();
  assert.equal(h.runtime.worker.authBlocked, true);
  await h.restart();
  assert.equal(h.runtime.worker.authBlocked, true);
  h.at('2026-10-08T07:00:00Z'); await h.runtime.worker.tick();
  assert.equal(h.runtime.service.job(second.job.id).state, 'queued');
  assert.equal(publisher.calls.length, 2);
  const cancelled = (await h.request('POST', `/jobs/${first.job.id}/cancel`)).json();
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.posts[0].state, 'scheduled');
  assert.equal((await h.request('POST', `/jobs/${first.job.id}/retry`)).json().code, 'RETRY_NOT_ALLOWED');
});

test('uploads retry at most three times; permanent-Donut capability gate stops even the public post', async t => {
  const publisher = new FakePublisher(); publisher.enabled = false;
  const h = await setup(t, publisher);
  const { job } = await queued(h);
  h.at('2026-10-08T05:00:00Z'); await h.runtime.worker.tick();
  assert.equal(publisher.calls.length, 0);
  assert.equal(h.runtime.service.job(job.id).state, 'queued');
  publisher.enabled = true; publisher.uploadFailures = 3;
  h.at('2026-10-08T07:00:00Z'); await h.runtime.worker.tick();
  assert.equal(publisher.uploads.length, 3);
  assert.equal(h.runtime.service.job(job.id).state, 'retry_wait');
  assert.equal(publisher.calls.length, 0);
});

test('native VK scheduling skips manually occupied minutes and assigns separate times to every pair', async t => {
  const publisher = new FakePublisher(); const h = await setup(t, publisher);
  h.at('2026-10-08T14:00:00Z');
  publisher.times = [Date.parse('2026-10-08T15:01:20Z')];
  const first = await queued(h, 150); const second = await queued(h, 151);
  await h.runtime.worker.tick();
  assert.deepEqual(publisher.calls.map(call => call.publishAt), [
    Date.parse('2026-10-08T17:00:00Z') / 1000, Date.parse('2026-10-08T17:01:00Z') / 1000,
    Date.parse('2026-10-09T05:00:00Z') / 1000, Date.parse('2026-10-09T05:01:00Z') / 1000,
  ]);
  for (const id of [first.job.id, second.job.id]) {
    assert.equal(h.runtime.service.job(id).state, 'scheduled');
    assert.ok(h.runtime.service.posts(id).every(post => post.publish_at && post.state === 'scheduled'));
  }
  assert.equal((await h.request('GET', '/history?state=scheduled')).json().total, 2);
  assert.equal((await h.request('POST', `/jobs/${first.job.id}/cancel`)).json().code, 'JOB_IN_VK');
});

test('confirmation starts background scheduling without waiting for a slot or a timer', async t => {
  const publisher = new FakePublisher(); const h = await setup(t, publisher, {}, true);
  const { job } = await queued(h, 152);
  for (let attempt = 0; attempt < 500 && h.runtime.service.job(job.id).state !== 'scheduled'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(h.runtime.service.job(job.id).state, 'scheduled');
  assert.equal(publisher.calls[0]!.publishAt, Date.parse('2026-10-08T05:00:00Z') / 1000);
  assert.equal(publisher.calls[1]!.publishAt, Date.parse('2026-10-08T05:01:00Z') / 1000);
  await h.restart(); await h.runtime.worker.tick();
  assert.equal(publisher.calls.length, 2);
});

test('slow photo uploads choose times after uploading; pause preserves an accepted VK schedule', async t => {
  const publisher = new FakePublisher(); const h = await setup(t, publisher);
  const { job } = await queued(h, 153);
  const upload = publisher.upload.bind(publisher);
  publisher.upload = async (asset, role) => { h.at('2026-10-08T04:59:45Z'); return upload(asset, role); };
  await h.runtime.worker.tick();
  assert.equal(publisher.calls[0]!.publishAt, Date.parse('2026-10-08T07:00:00Z') / 1000);
  assert.equal(publisher.calls[1]!.publishAt, Date.parse('2026-10-08T07:01:00Z') / 1000);
  await h.request('POST', '/queue/pause');
  assert.equal(h.runtime.service.job(job.id).state, 'scheduled');
  assert.equal(h.runtime.service.posts(job.id)[0]!.publish_at, '2026-10-08T07:00:00.000Z');
  assert.deepEqual(h.runtime.worker.forecast(), []);
});

test('task diagnostics survive a successful VK check and restart; retry clears only the current failure', async t => {
  const publisher = new FakePublisher(); const h = await setup(t, publisher);
  const { job } = await queued(h, 154);
  const upload = publisher.upload.bind(publisher);
  publisher.upload = async () => { throw new PublicationError('permanent', 'VK_REJECTED', undefined,
    { method: 'photos.saveWallPhoto', apiErrorCode: 100 }); };
  await h.runtime.worker.tick();
  const details = { method: 'photos.saveWallPhoto', apiErrorCode: 100 };
  assert.equal(h.runtime.service.job(job.id).state, 'needs_attention');
  assert.deepEqual((await h.request('GET', `/jobs/${job.id}`)).json().posts[0].last_error_details, details);
  publisher.check = async () => {}; await h.request('POST', '/vk/check');
  await h.restart();
  assert.deepEqual((await h.request('GET', `/jobs/${job.id}`)).json().posts[0].last_error_details, details);
  const attempt = h.runtime.service.db.prepare("SELECT result FROM attempts WHERE state = 'failed'").get()!;
  assert.deepEqual(JSON.parse(attempt.result as string).details, details);
  publisher.upload = upload; await h.request('POST', `/jobs/${job.id}/retry`);
  assert.equal((await h.request('GET', `/jobs/${job.id}`)).json().posts[0].last_error_details, null);
  await h.runtime.worker.tick();
  assert.equal(h.runtime.service.job(job.id).state, 'scheduled');
  assert.ok(h.runtime.service.posts(job.id).every(post => post.last_error_details === null));
});

test('automatic upload retry clears the old failure and preserves already saved photos', async t => {
  const publisher = new FakePublisher(); const h = await setup(t, publisher);
  const { job } = await queued(h, 155);
  const upload = publisher.upload.bind(publisher);
  let failNext = true;
  publisher.upload = async (asset, role) => {
    if (role === 'donut' && failNext) throw new PublicationError('transient', 'VK_UPLOAD_EMPTY', undefined, { method: 'photos.upload' });
    return upload(asset, role);
  };
  await h.runtime.worker.tick();
  assert.equal(h.runtime.service.job(job.id).last_error, 'VK_UPLOAD_EMPTY');
  assert.equal(h.runtime.service.posts(job.id)[0]!.state, 'ready');
  assert.equal(publisher.uploads.filter(asset => asset.role === 'public').length, 4);
  assert.equal(publisher.calls.length, 0);
  failNext = false;
  publisher.upload = async (asset, role) => {
    const active = h.runtime.service.job(job.id);
    assert.equal(active.state, 'publishing'); assert.equal(active.last_error, null);
    assert.equal(active.posts.find(post => post.role === role)!.last_error, null);
    assert.equal(active.posts.find(post => post.role === role)!.last_error_details, null);
    return upload(asset, role);
  };
  h.at('2026-10-08T05:00:00Z'); await h.runtime.worker.tick();
  assert.equal(h.runtime.service.job(job.id).state, 'scheduled');
  assert.equal(publisher.uploads.filter(asset => asset.role === 'public').length, 4);
  assert.equal(publisher.uploads.filter(asset => asset.role === 'donut').length, 9);
  assert.equal(publisher.calls.length, 2);
  assert.ok(h.runtime.service.db.prepare("SELECT 1 FROM attempts WHERE state = 'failed' AND result LIKE '%VK_UPLOAD_EMPTY%'").get());
});

test('expired and completed files are cleaned; active queue and history survive retention', async t => {
  const publisher = new FakePublisher();
  const h = await setup(t, publisher);
  const completed = await queued(h, 136);
  await h.runtime.worker.tick();
  await h.request('POST', '/queue/pause');
  const active = await queued(h, 137);
  const stale = await readyDraft(h, 138);
  h.at('2026-10-08T05:00:00Z'); await h.runtime.worker.tick();
  h.at('2026-10-12T04:00:00Z'); await h.runtime.storage.cleanup();
  assert.equal(h.runtime.service.draft(stale.id).state, 'expired');
  assert.equal(h.runtime.service.job(completed.job.id).state, 'scheduled');
  assert.equal(h.runtime.service.job(active.job.id).state, 'queued');
  assert.equal((await readdir(h.runtime.storage.directory)).length, 13);
  assert.equal((await h.request('GET', '/history?limit=1&offset=0')).json().total, 1);
  await h.restart();
  assert.equal(h.runtime.service.job(active.job.id).snapshot.assets.length, 13);
});

test('streamed uploads enforce limits without Content-Length and remove interrupted bytes', async t => {
  const h = await setup(t, undefined, { maxFileBytes: 10 });
  const draft = h.runtime.service.createDraft(fixture());
  await assert.rejects(h.runtime.storage.upload(draft.id, draft.assets[0]!.id, 1,
    Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), 'page'), { code: 'FILE_TOO_LARGE' });
  const interrupted = Readable.from((async function* () {
    yield Buffer.from('123'); throw new Error('Disconnected');
  })());
  await assert.rejects(h.runtime.storage.upload(draft.id, draft.assets[0]!.id, 1, interrupted, 'page'));
  assert.equal((await readdir(h.runtime.storage.directory)).length, 0);
  assert.equal(h.runtime.service.draft(draft.id).version, 1);
  assert.equal(h.runtime.storage.busy, false);
});

test('editing during a stream upload rejects the unviewed version and removes its file', async t => {
  const h = await setup(t);
  const draft = h.runtime.service.createDraft(fixture());
  const body = await png(1);
  const input = Readable.from((async function* () {
    yield body.subarray(0, 20);
    h.runtime.service.patchDraft(draft.id, { version: 1, fields: { ...draft.fields, includeModel: false } });
    yield body.subarray(20);
  })());
  await assert.rejects(h.runtime.storage.upload(draft.id, draft.assets[0]!.id, 1, input, 'page'), { code: 'VERSION_CONFLICT' });
  assert.equal((await readdir(h.runtime.storage.directory)).length, 0);
  assert.equal(h.runtime.service.draft(draft.id).version, 2);
});

test('SQLite backup with files restores the accepted queue and settings at the same data path', async t => {
  const h = await setup(t);
  const { job } = await queued(h);
  h.runtime.service.pause(true);
  await h.runtime.app.close();
  const destination = join(h.directory, 'backup');
  await cp(h.config.dataDir, destination, { recursive: true, filter: path => !path.endsWith('state.sqlite') && !path.endsWith('-wal') && !path.endsWith('-shm') });
  const db = new DatabaseSync(join(h.config.dataDir, 'state.sqlite'));
  await backup(db, join(destination, 'state.sqlite'));
  db.close();
  await rm(h.config.dataDir, { recursive: true, force: true });
  await cp(destination, h.config.dataDir, { recursive: true });
  await h.restart();
  assert.equal(h.runtime.service.settings().paused, true);
  assert.equal(h.runtime.service.job(job.id).state, 'queued');
  await h.runtime.service.verifyFiles(h.runtime.service.assets(job.draft_id));
});

test('HTTP server starts on loopback and supports a real streamed file upload', async t => {
  const h = await setup(t);
  const address = await h.runtime.app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await fetch(`${address}/ehvk/health/ready`)).status, 200);
  const draft = h.runtime.service.createDraft(fixture());
  const response = await fetch(`${address}${API_PREFIX}/drafts/${draft.id}/assets/${draft.assets[0]!.id}`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream', 'if-match': '"1"' },
    body: new Uint8Array(await png(1)),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(((await response.json()) as Draft).version, 2);
});

test('JPEG bytes are preserved and animated PNG is refused before a single frame can be selected', async t => {
  const h = await setup(t);
  const draft = h.runtime.service.createDraft(fixture());
  const jpeg = await sharp(await png(1)).jpeg().toBuffer();
  await h.runtime.storage.upload(draft.id, draft.assets[0]!.id, 1, Readable.from(jpeg), 'free_original');
  assert.deepEqual(await readFile(h.runtime.service.assets(draft.id)[0]!.path!), jpeg);
  const base = await png(1);
  const chunk = (type: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0); result.write(type, 4, 4, 'ascii'); data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
    return result;
  };
  const control = Buffer.alloc(8); control.writeUInt32BE(1, 0);
  const frame = Buffer.alloc(26);
  frame.writeUInt32BE(9, 4); frame.writeUInt32BE(8, 8); frame.writeUInt16BE(1, 20); frame.writeUInt16BE(1, 22);
  const animated = Buffer.concat([base.subarray(0, 33), chunk('acTL', control), chunk('fcTL', frame), base.subarray(33)]);
  await assert.rejects(h.runtime.storage.upload(draft.id, draft.assets[1]!.id, 2, Readable.from(animated), 'page'),
    { code: 'ANIMATION_UNSUPPORTED' });
  assert.equal(h.runtime.service.draft(draft.id).version, 2);
});

test('static WebP, GIF and AVIF become PNG previews with separate source hashes and retained originals', async t => {
  const h = await setup(t);
  let draft = h.runtime.service.createDraft(fixture());
  for (const [index, format] of (['webp', 'gif', 'avif'] as const).entries()) {
    const input = await sharp(await png(index + 30))[format]().toBuffer();
    const response = await h.request('PUT', `/drafts/${draft.id}/assets/${draft.assets[index]!.id}`, input,
      { 'content-type': `image/${format}`, 'if-match': `"${draft.version}"` });
    assert.equal(response.statusCode, 200, response.body);
    draft = response.json<Draft>();
    const asset = draft.assets[index]!;
    assert.equal(asset.transformed, true);
    assert.equal(asset.source_mime, `image/${format}`);
    assert.equal(asset.source_bytes, input.length);
    assert.equal(asset.source_sha256, createHash('sha256').update(input).digest('hex'));
    assert.equal(asset.mime, 'image/png');
    assert.equal('source_path' in asset, false);
    assert.equal('path' in asset, false);
    const preview = await h.request('GET', `/assets/${asset.id}/preview`);
    assert.equal(preview.headers['content-type'], 'image/png');
    assert.equal(asset.bytes, preview.rawPayload.length);
    assert.equal(asset.final_sha256, createHash('sha256').update(preview.rawPayload).digest('hex'));
    assert.deepEqual(await sharp(preview.rawPayload).raw().toBuffer(), await sharp(input).raw().toBuffer());
    const row = h.runtime.service.assets(draft.id)[index]!;
    assert.deepEqual(await readFile(row.source_path!), input);
  }
  assert.equal((await readdir(h.runtime.storage.directory)).length, 6);
  await h.restart(); // Startup cleanup must retain the source and the final file.
  await h.runtime.storage.cleanup();
  assert.equal((await readdir(h.runtime.storage.directory)).length, 6);
  assert.equal(h.runtime.service.draft(draft.id).assets[0]!.transformed, true);
  h.at('2026-10-09T05:00:00Z'); await h.runtime.storage.cleanup();
  assert.equal((await readdir(h.runtime.storage.directory)).length, 0);
  assert.equal(h.runtime.service.draft(draft.id).assets[0]!.fileAvailable, false);
});

test('animated GIF and WebP are refused, leaving the draft and storage unchanged', async t => {
  const h = await setup(t);
  const draft = h.runtime.service.createDraft(fixture());
  const frames = await Promise.all([1, 9].map(index => sharp({create:{width:16,height:16,channels:3,
    background:{r:index * 20,g:50,b:80}}}).png().toBuffer()));
  for (const format of ['gif', 'webp'] as const) {
    const input = await sharp(frames, { join: { animated: true } })[format]().toBuffer();
    assert.equal((await sharp(input).metadata()).pages, 2);
    await assert.rejects(h.runtime.storage.upload(draft.id, draft.assets[0]!.id, 1, Readable.from(input), 'page'),
      {code:'ANIMATION_UNSUPPORTED'});
    assert.equal(h.runtime.service.draft(draft.id).version, 1);
    assert.equal((await readdir(h.runtime.storage.directory)).length, 0);
    assert.equal(h.runtime.storage.busy, false);
  }
});

test('AVIF sequence brands are refused even when the decoder reports a single primary image', async t => {
  const h = await setup(t);
  const draft = h.runtime.service.createDraft(fixture());
  const input = await sharp(await png(35)).avif().toBuffer();
  assert.equal(input.toString('ascii', 4, 8), 'ftyp');
  const size = input.readUInt32BE(0);
  const sequence = Buffer.alloc(4); sequence.write('avis');
  const declaredSequence = Buffer.concat([input.subarray(0, size), sequence, input.subarray(size)]);
  declaredSequence.writeUInt32BE(size + 4, 0);
  assert.equal((await sharp(declaredSequence).metadata()).pages, 1);
  await assert.rejects(h.runtime.storage.upload(draft.id, draft.assets[0]!.id, 1, Readable.from(declaredSequence), 'page'),
    {code:'ANIMATION_UNSUPPORTED'});
  assert.equal((await readdir(h.runtime.storage.directory)).length, 0);
  assert.equal(h.runtime.service.draft(draft.id).version, 1);
});

test('PNG expansion respects file and disk limits including the original, and failures remove both temporary files', async t => {
  const raw = Buffer.alloc(128 * 128 * 3);
  let seed = 1;
  for (let i = 0; i < raw.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; raw[i] = seed >>> 24; }
  const input = await sharp(raw, {raw:{width:128,height:128,channels:3}}).webp({quality:10}).toBuffer();
  const output = await sharp(input).autoOrient().keepIccProfile().png().toBuffer();
  assert.ok(output.length > input.length);
  for (const [limits, code] of [
    [{maxFileBytes:input.length}, 'FILE_TOO_LARGE'],
    [{quotaBytes:input.length + output.length - 1}, 'STORAGE_QUOTA'],
  ] as const) {
    const h = await setup(t, undefined, limits);
    const draft = h.runtime.service.createDraft(fixture());
    await assert.rejects(h.runtime.storage.upload(draft.id, draft.assets[0]!.id, 1, Readable.from(input), 'page'), {code});
    assert.equal(h.runtime.service.draft(draft.id).version, 1);
    assert.equal((await readdir(h.runtime.storage.directory)).length, 0);
    assert.equal(h.runtime.storage.busy, false);
  }
});

test('duplicate final pixels encoded as different source formats cannot enter the pair twice', async t => {
  const h = await setup(t);
  const draft = h.runtime.service.createDraft(fixture());
  const pixels = await png(40);
  const webp = await sharp(pixels).webp({lossless:true}).toBuffer();
  const first = await h.runtime.storage.upload(draft.id, draft.assets[0]!.id, 1, Readable.from(webp), 'page');
  const final = await readFile(h.runtime.service.assets(draft.id)[0]!.path!);
  assert.notEqual(createHash('sha256').update(webp).digest('hex'), createHash('sha256').update(final).digest('hex'));
  await assert.rejects(h.runtime.storage.upload(draft.id, draft.assets[1]!.id, first.version, Readable.from(final), 'page'),
    {code:'DUPLICATE_IMAGE'});
  assert.equal((await readdir(h.runtime.storage.directory)).length, 2);
  assert.equal(h.runtime.service.draft(draft.id).version, first.version);
});

test('oriented WebP converts before confirmation and the immutable snapshot retains the exact PNG', async t => {
  const h = await setup(t, new FakePublisher());
  let draft = await readyDraft(h);
  const input = await sharp(await png(45)).withMetadata({orientation:6}).webp({lossless:true}).toBuffer();
  draft = await h.runtime.storage.upload(draft.id, draft.assets[0]!.id, draft.version, Readable.from(input), 'page');
  assert.equal(draft.assets[0]!.source_width, 53);
  assert.equal(draft.assets[0]!.source_height, 8);
  assert.equal(draft.assets[0]!.width, 8);
  assert.equal(draft.assets[0]!.height, 53);
  const response = await h.request('POST', `/drafts/${draft.id}/confirm`, {version:draft.version}, {'idempotency-key':'converted-confirm-key'});
  assert.equal(response.statusCode, 200, response.body);
  const job = response.json<ReturnType<Harness['runtime']['service']['job']>>();
  assert.equal(job.snapshot.assets[0]!.transformed, true);
  assert.equal(job.snapshot.assets[0]!.final_sha256, draft.assets[0]!.final_sha256);
  await h.restart(); await h.runtime.storage.cleanup();
  await h.runtime.service.verifyFiles(h.runtime.service.assets(draft.id));
  assert.equal(h.runtime.service.job(job.id).snapshot.assets[0]!.transformed, true);
});
