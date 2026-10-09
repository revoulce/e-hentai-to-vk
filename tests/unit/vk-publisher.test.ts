import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { VkPublisher, vkUploadUrl, VK_API_VERSION } from '../../src/vk-publisher.js';
import { loadConfig, vkGroup, vkPost, type VkConfig } from '../../src/config.js';
import type { AssetRow } from '../../src/service.js';
import type { PublishRequest } from '../../src/publisher.js';

const TOKEN = 'vk1.synthetic_token_for_tests_0123456789';
const request = (role: 'public' | 'donut' = 'donut'): PublishRequest => ({ role, text: 'Synthetic text', permanentDonut: true,
  operationKey: `stable-${role}`, attachments: Array.from({ length: role === 'public' ? 4 : 9 }, (_, i) => `photo-55_${i + 1}_key`) });
function actual(req: PublishRequest, id = 100) {
  return { id, owner_id: -55, from_id: -55, text: req.text,
    ...(req.publishAt !== undefined ? { date: req.publishAt, post_type: 'postpone' } : {}),
    ...(req.role === 'donut' ? { donut: { is_donut: true, paid_duration: -1 } } : {}),
    attachments: req.attachments.map(value => { const parts = value.match(/^photo(-?\d+)_(\d+)/)!;
      return { type: 'photo', photo: { owner_id: Number(parts[1]), id: Number(parts[2]) } }; }) };
}
async function setup(t: TestContext, overrides: Partial<VkConfig> = {}) {
  const directory = await mkdtemp(join(process.cwd(), '.ehvk-test-vk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, 'vk-token');
  await writeFile(tokenFile, TOKEN);
  const config: VkConfig = { tokenFile, group: 'quetzalcoatl_cosplay', donutReferencePost: '-55_77', photoPrivacyVerified: true, timeoutMs: 1000, ...overrides };
  const calls: { url: string; init: RequestInit; body: URLSearchParams | FormData }[] = [];
  const handlers = new Map<string, (body: URLSearchParams) => unknown | Promise<unknown>>();
  const published = new Map<string, ReturnType<typeof actual>>();
  let uploadResponse: unknown = { server: 42, photo: '["upload"]', hash: 'hash' };
  let nextPost = 100;
  let pinned: number | undefined;
  const transport: typeof fetch = async (input, init) => {
    const url = String(input); const body = init!.body as URLSearchParams | FormData;
    calls.push({ url, init: init!, body });
    if (url.startsWith('https://pu.vk.com/')) return uploadResponse instanceof Response ? uploadResponse : Response.json(uploadResponse);
    const method = new URL(url).pathname.replace('/method/', '');
    const params = body as URLSearchParams;
    if (handlers.has(method)) {
      const response = await handlers.get(method)!(params);
      return response instanceof Response ? response : Response.json({ response });
    }
    let response: unknown;
    if (method === 'account.getAppPermissions') response = 8196;
    else if (method === 'users.get') response = [{ id: 123 }];
    else if (method === 'groups.getById') response = { groups: [{ id: 55, name: 'Synthetic community', is_admin: 1, admin_level: 3, can_post: 1 }] };
    else if (method === 'photos.getWallUploadServer') response = { upload_url: 'https://pu.vk.com/upload' };
    else if (method === 'photos.saveWallPhoto') response = [{ id: 1, owner_id: -55, access_key: 'key' }];
    else if (method === 'wall.post') {
      const req: PublishRequest = { role: params.has('donut_paid_duration') ? 'donut' : 'public', text: params.get('message')!,
        attachments: params.get('attachments')!.split(','), operationKey: params.get('guid')!, permanentDonut: true,
        ...(params.has('publish_date') ? { publishAt: Number(params.get('publish_date')) } : {}) };
      published.set(`-55_${nextPost}`, actual(req, nextPost)); response = { post_id: nextPost++ };
    } else if (method === 'wall.getById') response = { items: params.get('posts') === '-55_77'
      ? [{ id: 77, owner_id: -55, from_id: -55, text: '', donut: { is_donut: true, paid_duration: -1 } }]
      : [...published.values()].filter(value => `-55_${value.id}` === params.get('posts')) };
    else if (method === 'wall.get') response = { count: 0, items: [] };
    else throw new Error(`Unexpected API call: ${method}`);
    return Response.json({ response });
  };
  const publisher = new VkPublisher(config, { fetch: transport, wait: async () => {}, now: () => Date.parse('2026-10-08T04:59:00Z'), pinGroup: group => {
    if (pinned && pinned !== group) throw new Error('Group changed'); pinned = group;
  } });
  return { publisher, config, directory, tokenFile, calls, handlers, published, transport,
    setUploadResponse(value: unknown) { uploadResponse = value; } };
}

test('VK configuration accepts the supplied group link and keeps credentials in a file', () => {
  assert.equal(vkGroup('https://vk.ru/quetzalcoatl_cosplay'), 'quetzalcoatl_cosplay');
  assert.equal(vkGroup('https://vk.com/club55/'), '55');
  assert.equal(vkGroup('-55'), '55');
  assert.equal(vkPost('https://vk.ru/wall-55_77'), '-55_77');
  assert.equal(loadConfig({ API_TOKEN_FILE: 'owner-token', VK_TOKEN_FILE: 'vk-token',
    VK_DONUT_PERMANENT_CONFIRMED_POST: 'https://vk.ru/wall-55_77' }).vk!.donutPermanentConfirmedPost, '-55_77');
  for (const value of ['http://vk.com/club55', 'https://vk.com.evil.test/club55', 'https://vk.com/club55?x=1', '0']) assert.throws(() => vkGroup(value));
  for (const value of ['55_77', 'https://evil.test/wall-55_77']) assert.throws(() => vkPost(value));
  const config = loadConfig({ API_TOKEN_FILE: 'owner-token', VK_TOKEN_FILE: 'vk-token', VK_PHOTO_PRIVACY_VERIFIED: 'false' });
  assert.equal(config.vk!.group, 'quetzalcoatl_cosplay'); assert.equal(config.vk!.photoPrivacyVerified, false);
  assert.equal(loadConfig({ API_TOKEN_FILE: 'owner-token' }).vk, undefined);
  assert.throws(() => loadConfig({ API_TOKEN_FILE: 'owner-token', VK_TOKEN_FILE: 'vk-token', VK_PHOTO_PRIVACY_VERIFIED: 'yes' }));
});

test('preflight verifies user permissions, administrator, permanent reference and wall upload access without writes', async t => {
  const h = await setup(t); await h.publisher.check();
  assert.equal(h.publisher.available(), true);
  assert.equal(h.publisher.status().groupId, 55);
  assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), ['/method/account.getAppPermissions', '/method/users.get', '/method/groups.getById', '/method/wall.getById', '/method/photos.getWallUploadServer']);
  for (const call of h.calls) {
    assert.equal(new URL(call.url).search, ''); assert.equal(call.init.credentials, 'omit'); assert.equal(call.init.redirect, 'error');
    assert.equal((call.body as URLSearchParams).get('access_token'), TOKEN); assert.equal((call.body as URLSearchParams).get('v'), VK_API_VERSION);
  }
  assert.ok(!JSON.stringify(h.publisher.status()).includes(TOKEN));
});

test('missing token, rights or reference and unverified photo privacy block all publication', async t => {
  const h = await setup(t);
  await writeFile(h.tokenFile, 'invalid'); await h.publisher.check();
  assert.equal(h.publisher.status().code, 'VK_TOKEN_REQUIRED'); assert.equal(h.calls.length, 0);
  await writeFile(h.tokenFile, TOKEN);
  h.handlers.set('account.getAppPermissions', () => 4); await h.publisher.check();
  assert.equal(h.publisher.status().code, 'VK_PERMISSIONS_REQUIRED');
  h.handlers.delete('account.getAppPermissions'); h.config.donutReferencePost = '-99_77'; await h.publisher.check();
  assert.equal(h.publisher.status().state, 'donut_verification_required');
  h.config.donutReferencePost = '-55_77'; h.config.photoPrivacyVerified = false; await h.publisher.check();
  assert.equal(h.publisher.status().state, 'privacy_verification_required');
  await assert.rejects(h.publisher.publish(request('public')), { kind: 'permanent' });
  assert.ok(h.calls.every(call => !call.url.endsWith('wall.post') && !call.url.endsWith('photos.saveWallPhoto')));
});

test('finite Donut, non-administrator and changed group cannot pass preflight', async t => {
  const h = await setup(t); await h.publisher.check();
  h.handlers.set('wall.getById', () => ({ items: [{ ...actual(request(), 77), donut: { is_donut: true, paid_duration: 86400 } }] }));
  await h.publisher.check(); assert.equal(h.publisher.available(), false); assert.equal(h.publisher.status().code, 'VK_DONUT_NOT_PERMANENT');
  assert.equal(h.publisher.status().donutReference?.paidDuration, 86400);
  h.handlers.delete('wall.getById');
  h.handlers.set('groups.getById', () => ({ groups: [{ id: 55, name: 'Group', is_admin: 1, admin_level: 2 }] }));
  await h.publisher.check(); assert.equal(h.publisher.status().code, 'VK_ADMIN_REQUIRED');
  h.handlers.set('groups.getById', () => ({ groups: [{ id: 56, name: 'Other group', is_admin: 1, admin_level: 3 }] }));
  await h.publisher.check(); assert.equal(h.publisher.status().code, 'VK_GROUP_MISMATCH');
});

test('wall photo upload sends multipart file without a token and saves only to the configured wall', async t => {
  const h = await setup(t); await h.publisher.check();
  const path = join(h.directory, 'synthetic.png'); const bytes = Buffer.from('synthetic test image bytes'); await writeFile(path, bytes);
  const asset = { id: 'asset', path, mime: 'image/png', role: 'donut' } as AssetRow;
  assert.equal(await h.publisher.upload(asset, 'donut'), 'photo-55_1_key');
  const upload = h.calls.find(call => call.url.startsWith('https://pu.vk.com/'))!;
  assert.ok(upload.body instanceof FormData); assert.equal(upload.body.has('access_token'), false);
  assert.equal(new Headers(upload.init.headers).has('authorization'), false);
  const file = upload.body.get('photo') as File; assert.equal(file.name, 'asset.png'); assert.equal(file.type, 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  const save = h.calls.find(call => call.url.endsWith('photos.saveWallPhoto'))!;
  assert.equal((save.body as URLSearchParams).get('group_id'), '55'); assert.equal((save.body as URLSearchParams).has('album_id'), false);
  await assert.rejects(h.publisher.upload(asset, 'public'), { kind: 'permanent' });
});

test('reference diagnostics distinguish missing configuration, wrong group, absent post, public post and unavailable duration', async t => {
  const h = await setup(t);
  h.config.donutReferencePost = undefined; await h.publisher.check();
  assert.equal(h.publisher.status().code, 'VK_DONUT_REFERENCE_REQUIRED'); assert.equal(h.publisher.status().donutReference, undefined);
  h.config.donutReferencePost = '-99_77'; await h.publisher.check();
  assert.equal(h.publisher.status().code, 'VK_DONUT_REFERENCE_WRONG_GROUP'); assert.equal(h.publisher.status().donutReference?.postId, '-99_77');
  h.config.donutReferencePost = '-55_77'; h.handlers.set('wall.getById', () => ({ items: [] })); await h.publisher.check();
  assert.equal(h.publisher.status().code, 'VK_DONUT_REFERENCE_NOT_FOUND'); assert.equal(h.publisher.status().donutReference?.found, false);
  h.handlers.set('wall.getById', () => ({ items: [actual(request('public'), 77)] })); await h.publisher.check();
  assert.equal(h.publisher.status().code, 'VK_DONUT_REFERENCE_NOT_DONUT'); assert.equal(h.publisher.status().donutReference?.isDonut, false);
  h.handlers.set('wall.getById', () => ({ items: [{ ...actual(request(), 77), donut: { is_donut: true } }] })); await h.publisher.check();
  assert.equal(h.publisher.status().code, 'VK_DONUT_DURATION_UNAVAILABLE'); assert.equal(h.publisher.status().donutReference?.isDonut, true);
  assert.equal(h.publisher.available(), false);
  h.handlers.set('account.getAppPermissions', () => Response.json({ error: { error_code: 5, error_msg: TOKEN, request_params: [{ value: TOKEN }] } }));
  await h.publisher.check();
  assert.equal(h.publisher.status().apiErrorCode, 5); assert.equal(h.publisher.status().donutReference, undefined);
  assert.ok(!JSON.stringify(h.publisher.status()).includes(TOKEN));
});

test('upload URLs reject credentials, HTTP, ports, foreign hosts and VK-looking suffixes', () => {
  assert.equal(vkUploadUrl('https://pu.vkuserphoto.ru/upload'), 'https://pu.vkuserphoto.ru/upload');
  for (const url of ['http://pu.vk.com/upload', 'https://vk.com.evil.test/upload', 'https://evilvk.com/upload', 'https://user:pass@pu.vk.com/upload', 'https://127.0.0.1/upload', 'https://pu.vk.com:8443/upload']) assert.throws(() => vkUploadUrl(url));
});

test('owner confirmation accepts an omitted duration only for the exact configured reference and never overrides a finite duration', async t => {
  const h = await setup(t);
  h.handlers.set('wall.getById', () => ({ items: [{ ...actual(request(), 77), donut: { is_donut: true } }] }));
  await h.publisher.check(); assert.equal(h.publisher.status().code, 'VK_DONUT_DURATION_UNAVAILABLE');
  h.config.donutPermanentConfirmedPost = '-55_78'; await h.publisher.check();
  assert.equal(h.publisher.available(), false);
  h.config.donutPermanentConfirmedPost = '-55_77'; await h.publisher.check();
  assert.equal(h.publisher.available(), true); assert.equal(h.publisher.status().donutReference?.durationSource, 'owner_confirmation');
  assert.equal(h.publisher.status().donutReference?.paidDuration, undefined);
  h.handlers.set('wall.getById', () => ({ items: [{ ...actual(request(), 77), donut: { is_donut: true, paid_duration: 86400 } }] }));
  await h.publisher.check(); assert.equal(h.publisher.status().code, 'VK_DONUT_NOT_PERMANENT'); assert.equal(h.publisher.available(), false);
  h.handlers.set('wall.getById', () => ({ items: [actual(request('public'), 77)] }));
  await h.publisher.check(); assert.equal(h.publisher.status().code, 'VK_DONUT_REFERENCE_NOT_DONUT');
});

test('a permanent Donut request verifies and reconciles when VK omits paid_duration in the created post', async t => {
  const h = await setup(t); await h.publisher.check();
  assert.equal(h.publisher.status().donutReference?.durationSource, 'api');
  h.handlers.set('wall.getById', body => ({ items: [{ ...actual(request(), Number(body.get('posts')!.split('_')[1])), donut: { is_donut: true } }] }));
  const result = await h.publisher.publish(request()); assert.equal(result.postId, '-55_100');
  const call = h.calls.find(call => call.url.endsWith('wall.post'))!;
  assert.equal((call.body as URLSearchParams).get('donut_paid_duration'), '-1');
  assert.equal((await h.publisher.reconcile({ ...request(), candidatePostId: result.postId })).status, 'posted');
  h.handlers.set('wall.get', () => ({ count: 1, items: [{ ...actual(request()), donut: { is_donut: true } }] }));
  assert.equal((await h.publisher.reconcile(request())).status, 'posted');
  h.handlers.set('wall.getById', () => ({ items: [{ ...actual(request()), donut: { is_donut: true, paid_duration: 86400 } }] }));
  assert.equal((await h.publisher.reconcile({ ...request(), candidatePostId: result.postId })).status, 'unknown');
});

test('publication preserves 4/9 attachments, community authorship, stable guid and permanent Donut', async t => {
  const h = await setup(t); await h.publisher.check();
  const publicResult = await h.publisher.publish(request('public'));
  const donutResult = await h.publisher.publish(request());
  assert.equal(publicResult.url, 'https://vk.com/wall-55_100'); assert.equal(donutResult.postId, '-55_101');
  const calls = h.calls.filter(call => call.url.endsWith('wall.post')).map(call => call.body as URLSearchParams);
  assert.equal(calls[0]!.has('donut_paid_duration'), false); assert.equal(calls[1]!.get('donut_paid_duration'), '-1');
  for (const [i, role] of (['public', 'donut'] as const).entries()) {
    assert.equal(calls[i]!.get('owner_id'), '-55'); assert.equal(calls[i]!.get('from_group'), '1');
    assert.equal(calls[i]!.get('guid'), `stable-${role}`); assert.equal(calls[i]!.get('attachments'), request(role).attachments.join(','));
    assert.equal(calls[i]!.get('primary_attachments_mode'), 'carousel');
  }
  await assert.rejects(h.publisher.publish({ ...request(), attachments: ['photo-99_1'] }), { kind: 'permanent' });
});

test('attachment display mode reaches wall.post for both audiences and scheduled posts', async t => {
  const h = await setup(t); await h.publisher.check();
  for (const mode of ['carousel', 'grid'] as const) for (const role of ['public', 'donut'] as const) {
    for (const publishAt of [undefined, Date.parse('2026-10-08T15:00:00Z') / 1000]) {
      await h.publisher.publish({ ...request(role), primaryAttachmentsMode: mode, publishAt });
      const body = h.calls.filter(call => call.url.endsWith('wall.post')).at(-1)!.body as URLSearchParams;
      assert.equal(body.get('primary_attachments_mode'), mode);
      assert.equal(body.get('publish_date'), publishAt === undefined ? null : String(publishAt));
      assert.equal(body.get('donut_paid_duration'), role === 'donut' ? '-1' : null);
    }
  }
  const count = h.calls.length;
  await assert.rejects(h.publisher.publish({ ...request(), primaryAttachmentsMode: 'invalid' } as unknown as PublishRequest),
    { kind: 'permanent', code: 'VK_POST_REQUEST_INVALID' });
  assert.equal(h.calls.length, count);
});

test('lost wall.post response, HTTP failures and malformed success become unknown; explicit rate limiting can retry', async t => {
  const h = await setup(t); await h.publisher.check();
  for (const response of [new Response('upstream error', { status: 503 }), new Response('not JSON'), Response.json({ response: {} }), Response.json({ error: { error_code: 10 } })]) {
    h.handlers.set('wall.post', () => response);
    await assert.rejects(h.publisher.publish(request()), { kind: 'unknown' });
  }
  h.handlers.set('wall.post', () => { throw new Error(`Secret ${TOKEN}`); });
  await assert.rejects(h.publisher.publish(request()), error => {
    assert.equal((error as { kind: string }).kind, 'unknown'); assert.ok(!String(error).includes(TOKEN)); return true;
  });
  h.handlers.set('wall.post', () => Response.json({ error: { error_code: 6, error_msg: TOKEN } }));
  await assert.rejects(h.publisher.publish(request()), { kind: 'transient' });
  h.handlers.set('wall.post', () => Response.json({ error: { error_code: 5, error_msg: TOKEN } }));
  await assert.rejects(h.publisher.publish(request()), { kind: 'authorization' }); assert.equal(h.publisher.available(), false);
});

test('readback failure preserves the returned post ID and cannot be treated as safe to publish again', async t => {
  const h = await setup(t); await h.publisher.check();
  h.handlers.set('wall.getById', () => { throw new Error('Readback lost'); });
  await assert.rejects(h.publisher.publish(request()), error => {
    const value = error as { kind: string; result: { postId: string } };
    assert.equal(value.kind, 'unknown'); assert.equal(value.result.postId, '-55_100'); return true;
  });
  h.handlers.set('wall.getById', () => ({ items: [{ ...actual(request(), 101), donut: { is_donut: false } }] }));
  await assert.rejects(h.publisher.publish(request()), { kind: 'unknown', code: 'VK_POST_VERIFICATION_FAILED' });
  assert.equal(h.publisher.available(), false);
});

test('reconciliation needs exact text, photo IDs, author and Donut; an empty list never proves absence', async t => {
  const h = await setup(t); await h.publisher.check(); const req = request();
  h.handlers.set('wall.get', () => ({ count: 1, items: [actual(req)] }));
  assert.equal((await h.publisher.reconcile(req)).status, 'posted');
  for (const value of [ { ...actual(req), text: 'Other text' }, { ...actual(req), from_id: 7 }, { ...actual(req), attachments: [] },
    { ...actual(req), donut: { is_donut: true, paid_duration: 86400 } } ]) {
    h.handlers.set('wall.get', () => ({ count: 1, items: [value] })); assert.equal((await h.publisher.reconcile(req)).status, 'unknown');
  }
  h.handlers.set('wall.get', () => ({ count: 0, items: [] })); assert.equal((await h.publisher.reconcile(req)).status, 'unknown');
  h.handlers.set('wall.get', () => ({ count: 2, items: [actual(req), actual(req, 101)] })); assert.equal((await h.publisher.reconcile(req)).status, 'unknown');
  h.handlers.set('wall.getById', () => ({ items: [actual(req)] }));
  assert.equal((await h.publisher.reconcile({ ...req, candidatePostId: '-55_100' })).status, 'posted');
  assert.equal((await h.publisher.reconcile({ ...req, candidatePostId: '-99_100' })).status, 'unknown');
});

test('reconciliation follows wall pagination instead of duplicating a post older than the latest page', async t => {
  const h = await setup(t); await h.publisher.check(); const req = request();
  h.handlers.set('wall.get', body => Number(body.get('offset')) === 0
    ? { count: 101, items: Array.from({ length: 100 }, (_, i) => ({ ...actual(req, i + 200), text: 'Other text' })) }
    : { count: 101, items: [actual(req)] });
  assert.equal((await h.publisher.reconcile(req)).status, 'posted');
  assert.deepEqual(h.calls.filter(call => call.url.endsWith('wall.get')).map(call => (call.body as URLSearchParams).get('offset')), ['0', '100']);
});

test('native scheduling sends publish_date for both audiences and verifies their times', async t => {
  const h = await setup(t); await h.publisher.check();
  for (const [index, role] of (['public','donut'] as const).entries()) {
    const req = { ...request(role), publishAt: Date.parse('2026-10-08T15:00:00Z') / 1000 + index * 60 };
    const result = await h.publisher.publish(req);
    assert.equal((await h.publisher.reconcile({ ...req, candidatePostId: result.postId })).status, 'posted');
    const body = h.calls.filter(call => call.url.endsWith('wall.post')).at(-1)!.body as URLSearchParams;
    assert.equal(body.get('publish_date'), String(req.publishAt));
    assert.equal(body.get('donut_paid_duration'), role === 'donut' ? '-1' : null);
    assert.equal(h.published.get(result.postId)!.date, req.publishAt);
  }
});

test('wrong scheduled date or immediate publication cannot pass readback; expired times never reach wall.post', async t => {
  const h = await setup(t); await h.publisher.check();
  const req = { ...request(), publishAt: Date.parse('2026-10-08T15:00:00Z') / 1000 };
  for (const changed of [{ date: req.publishAt + 60 }, { post_type: 'post' }]) {
    h.handlers.set('wall.getById', () => ({ items: [{ ...actual(req), ...changed }] }));
    await assert.rejects(h.publisher.publish(req), { kind: 'unknown', code: 'VK_POST_VERIFICATION_FAILED' });
    h.handlers.delete('wall.getById'); await h.publisher.check();
  }
  const calls = h.calls.filter(call => call.url.endsWith('wall.post')).length;
  await assert.rejects(h.publisher.publish({ ...req, publishAt: Date.parse('2026-10-08T04:59:00Z') / 1000 }),
    { kind: 'transient', code: 'VK_SCHEDULE_EXPIRED' });
  assert.equal(h.calls.filter(call => call.url.endsWith('wall.post')).length, calls);
});

test('scheduled reconciliation searches postponed and published lists without double counting one post', async t => {
  const h = await setup(t); await h.publisher.check();
  const req = { ...request(), publishAt: Date.parse('2026-10-08T15:00:00Z') / 1000 };
  h.handlers.set('wall.get', () => ({ count: 1, items: [actual(req)] }));
  assert.equal((await h.publisher.reconcile(req)).status, 'posted');
  assert.deepEqual(h.calls.filter(call => call.url.endsWith('wall.get')).map(call => (call.body as URLSearchParams).get('filter')),
    ['postponed','donut']);
});

test('existing VK schedule is read across pages and missing dates block new reservations', async t => {
  const h = await setup(t); await h.publisher.check();
  const req = { ...request('public'), publishAt: Date.parse('2026-10-08T15:00:00Z') / 1000 };
  h.handlers.set('wall.get', params => Number(params.get('offset')) === 0
    ? { count: 101, items: Array.from({ length: 100 }, (_, i) => actual({ ...req, publishAt: req.publishAt + i * 60 }, i + 100)) }
    : { count: 101, items: [actual({ ...req, publishAt: req.publishAt + 100 * 60 }, 200)] });
  assert.equal((await h.publisher.scheduledTimes()).length, 101);
  assert.deepEqual(h.calls.filter(call => call.url.endsWith('wall.get')).map(call => (call.body as URLSearchParams).get('offset')), ['0','100']);
  h.handlers.set('wall.get', () => ({ count: 1, items: [actual(request())] }));
  await assert.rejects(h.publisher.scheduledTimes(), { kind: 'transient', code: 'VK_SCHEDULE_UNAVAILABLE' });
});

test('a rejected photo save retains method and VK code while discarding external messages and token parameters', async t => {
  const h = await setup(t); await h.publisher.check();
  const path = join(h.directory, 'synthetic.png'); await writeFile(path, Buffer.from([1,2,3]));
  h.handlers.set('photos.saveWallPhoto', () => Response.json({ error: { error_code: 100, error_msg: TOKEN,
    request_params: [{ key: 'access_token', value: TOKEN }] } }));
  await assert.rejects(h.publisher.upload({ id: 'synthetic', path, mime: 'image/png', role: 'public' } as AssetRow, 'public'), error => {
    const value = error as import('../../src/publisher.js').PublicationError;
    assert.equal(value.kind, 'permanent'); assert.equal(value.code, 'VK_REJECTED');
    assert.deepEqual(value.details, { method: 'photos.saveWallPhoto', apiErrorCode: 100 });
    assert.ok(!JSON.stringify(value).includes(TOKEN)); return true;
  });
});

test('photo owner verification rejects another uploader or community without claiming an API rejection', async t => {
  const h = await setup(t); await h.publisher.check();
  const path = join(h.directory, 'synthetic.png'); await writeFile(path, Buffer.from([1,2,3]));
  for (const ownerId of [999, -99]) {
    h.handlers.set('photos.saveWallPhoto', () => [{ id: 1, owner_id: ownerId }]);
    await assert.rejects(h.publisher.upload({ id: 'synthetic', path, mime: 'image/png', role: 'public' } as AssetRow, 'public'), error => {
      const value = error as import('../../src/publisher.js').PublicationError;
      assert.equal(value.kind, 'permanent'); assert.equal(value.code, 'VK_PHOTO_OWNER_MISMATCH');
      assert.deepEqual(value.details, { method: 'photos.saveWallPhoto', expectedOwnerId: ownerId > 0 ? 123 : -55, actualOwnerId: ownerId });
      assert.equal(h.publisher.status().apiErrorCode, undefined); return true;
    });
  }
  assert.equal(h.calls.some(call => call.url.endsWith('wall.post')), false);
});

test('uploader-owned photos keep their real attachment IDs while both scheduled posts are authored by the community', async t => {
  const h = await setup(t); await h.publisher.check();
  const path = join(h.directory, 'synthetic.png'); await writeFile(path, Buffer.from([1,2,3]));
  let nextPhoto = 1;
  h.handlers.set('photos.saveWallPhoto', () => [{ id: nextPhoto++, owner_id: 123, access_key: 'real_key' }]);
  for (const [index, role] of (['public','donut'] as const).entries()) {
    const attachments: string[] = [];
    for (let i = 0; i < (role === 'public' ? 4 : 9); i++) {
      attachments.push(await h.publisher.upload({ id: `synthetic-${role}-${i}`, path, mime: 'image/png', role } as AssetRow, role));
    }
    const req = { ...request(role), attachments, publishAt: Date.parse('2026-10-08T15:00:00Z') / 1000 + index * 60 };
    const result = await h.publisher.publish(req);
    assert.ok(attachments.every(attachment => /^photo123_\d+_real_key$/.test(attachment)));
    const body = h.calls.filter(call => call.url.endsWith('wall.post')).at(-1)!.body as URLSearchParams;
    assert.equal(body.get('owner_id'), '-55'); assert.equal(body.get('from_group'), '1'); assert.equal(body.get('signed'), '0');
    assert.equal(body.get('attachments'), attachments.join(','));
    assert.equal(body.get('publish_date'), String(req.publishAt));
    assert.equal(body.get('donut_paid_duration'), role === 'donut' ? '-1' : null);
    assert.equal(h.published.get(result.postId)!.from_id, -55);
    assert.equal((await h.publisher.reconcile({ ...req, candidatePostId: result.postId })).status, 'posted');
  }
  assert.ok(h.calls.filter(call => call.url.endsWith('photos.saveWallPhoto')).every(call => (call.body as URLSearchParams).get('group_id') === '55'));
});

test('accepting uploader photos never accepts a post authored by the user', async t => {
  const h = await setup(t); await h.publisher.check();
  const req = { ...request('public'), attachments: ['photo123_1','photo123_2','photo123_3','photo123_4'] };
  h.handlers.set('wall.getById', () => ({ items: [{ ...actual(req), from_id: 123 }] }));
  await assert.rejects(h.publisher.publish(req), { kind: 'unknown', code: 'VK_POST_VERIFICATION_FAILED' });
  assert.equal(h.publisher.available(), false);
  h.handlers.delete('wall.getById'); await h.publisher.check();
  for (const ownerId of [999, -99]) {
    await assert.rejects(h.publisher.publish({ ...req, attachments: req.attachments.map((_, i) => `photo${ownerId}_${i + 1}`) }),
      { kind: 'permanent', code: 'VK_POST_REQUEST_INVALID' });
  }
  assert.equal(h.calls.filter(call => call.url.endsWith('wall.post')).length, 1);
});

test('failed readback keeps its method and HTTP status alongside the known post ID', async t => {
  const h = await setup(t); await h.publisher.check();
  h.handlers.set('wall.getById', () => new Response('private upstream text', { status: 503 }));
  await assert.rejects(h.publisher.publish(request()), error => {
    const value = error as import('../../src/publisher.js').PublicationError;
    assert.equal(value.kind, 'unknown'); assert.equal(value.result!.postId, '-55_100');
    assert.deepEqual(value.details, { method: 'wall.getById', httpStatus: 503 });
    assert.ok(!JSON.stringify(value).includes('private upstream text')); return true;
  });
});

test('empty wall upload results are retryable and never sent to photos.saveWallPhoto', async t => {
  const h = await setup(t); await h.publisher.check();
  const path = join(h.directory, 'synthetic.png'); await writeFile(path, Buffer.from([1,2,3]));
  const asset = { id: 'synthetic', path, mime: 'image/png', role: 'public' } as AssetRow;
  for (const photo of ['', '[]', ' [ \n ] ', []]) {
    h.setUploadResponse({ server: 42, photo, hash: TOKEN });
    await assert.rejects(h.publisher.upload(asset, 'public'), error => {
      const value = error as import('../../src/publisher.js').PublicationError;
      assert.equal(value.kind, 'transient'); assert.equal(value.code, 'VK_UPLOAD_EMPTY');
      assert.deepEqual(value.details, { method: 'photos.upload', responseFields: {
        server: 'number', photo: typeof photo === 'string' ? 'string' : 'array', hash: 'string',
      } });
      assert.ok(!JSON.stringify(value).includes(TOKEN)); return true;
    });
  }
  assert.equal(h.calls.some(call => call.url.endsWith('photos.saveWallPhoto')), false);
  assert.equal(h.calls.some(call => call.url.endsWith('wall.post')), false);
});

test('an invalid upload result exposes only field types; an upstream 504 remains retryable', async t => {
  const h = await setup(t); await h.publisher.check();
  const path = join(h.directory, 'synthetic.png'); await writeFile(path, Buffer.from([1,2,3]));
  const asset = { id: 'synthetic', path, mime: 'image/png', role: 'public' } as AssetRow;
  h.setUploadResponse({ server: '42', photo: TOKEN, hash: null, private_payload: TOKEN });
  await assert.rejects(h.publisher.upload(asset, 'public'), error => {
    const value = error as import('../../src/publisher.js').PublicationError;
    assert.equal(value.code, 'VK_UPLOAD_RESPONSE_INVALID');
    assert.deepEqual(value.details, { method: 'photos.upload', responseFields: { server: 'string', photo: 'string', hash: 'null' } });
    assert.ok(!JSON.stringify(value).includes(TOKEN)); return true;
  });
  h.setUploadResponse(new Response(TOKEN, { status: 504 }));
  await assert.rejects(h.publisher.upload(asset, 'public'), error => {
    const value = error as import('../../src/publisher.js').PublicationError;
    assert.equal(value.kind, 'transient'); assert.equal(value.code, 'VK_HTTP_ERROR');
    assert.deepEqual(value.details, { method: 'photos.upload', httpStatus: 504 });
    assert.ok(!JSON.stringify(value).includes(TOKEN)); return true;
  });
  assert.equal(h.calls.some(call => call.url.endsWith('photos.saveWallPhoto')), false);
});

function copiedPhotoFixture(role: 'public' | 'donut') {
  const req = { ...request(role), attachments: request(role).attachments.map(value => value.replace('photo-55_', 'photo123_')),
    publishAt: Date.parse('2026-10-08T15:00:00Z') / 1000 };
  const originals = req.attachments.map((_, i) => ({ id: i + 1, owner_id: 123, sizes: [
    { width: 72, height: 108, url: `https://cdn.example.test/thumb-${i}.jpg` },
    { width: 1280, height: 1920, url: `https://cdn.example.test/full-${i}.jpg` },
  ] }));
  const copies = originals.map((value, i) => ({ ...value, owner_id: -55, id: i + 400 }));
  const copied = { ...actual(req), attachments: copies.map(value => ({ type: 'photo', photo: value })) };
  return { req, originals, copies, copied };
}

test('VK community copies verify both audiences by original full-size media while retaining distinct photo IDs', async t => {
  for (const role of ['public','donut'] as const) {
    const h = await setup(t); await h.publisher.check(); const fixture = copiedPhotoFixture(role);
    h.handlers.set('photos.getById', params => {
      assert.equal(params.get('photos'), fixture.req.attachments.map(value => value.slice('photo'.length)).join(','));
      return fixture.originals;
    });
    h.handlers.set('wall.getById', () => ({ items: [fixture.copied] }));
    const result = await h.publisher.publish(fixture.req);
    assert.equal(result.postId, '-55_100');
    assert.equal((await h.publisher.reconcile({ ...fixture.req, candidatePostId: result.postId })).status, 'posted');
    h.handlers.set('wall.get', () => ({ count: 1, items: [fixture.copied] }));
    assert.equal((await h.publisher.reconcile(fixture.req)).status, 'posted');
    assert.equal(h.calls.filter(call => call.url.endsWith('wall.post')).length, 1);
    assert.equal(h.calls.filter(call => call.url.endsWith('photos.getById')).length, 1);
  }
});

test('copy verification rejects replacements, thumbnail-only matches, duplicate copies and incorrect authorship', async t => {
  const h = await setup(t); await h.publisher.check(); const fixture = copiedPhotoFixture('public');
  h.handlers.set('photos.getById', () => fixture.originals);
  const req = { ...fixture.req, candidatePostId: '-55_100' };
  h.handlers.set('wall.getById', () => ({ items: [{ ...fixture.copied, attachments: [...fixture.copied.attachments].reverse() }] }));
  assert.equal((await h.publisher.reconcile(req)).status, 'posted');
  const replaced = fixture.copied.attachments.map((value, index) => index ? value : { ...value, photo: {
    ...value.photo, sizes: [value.photo.sizes[0]!, { ...value.photo.sizes[1]!, url: 'https://cdn.example.test/replacement.jpg' }],
  } });
  for (const changed of [
    { ...fixture.copied, attachments: replaced },
    { ...fixture.copied, attachments: fixture.copied.attachments.map(() => fixture.copied.attachments[0]!) },
    { ...fixture.copied, from_id: 123 },
    { ...fixture.copied, owner_id: -99 },
    { ...fixture.copied, date: fixture.req.publishAt + 60 },
    { ...fixture.copied, donut: { is_donut: true } },
  ]) {
    h.handlers.set('wall.getById', () => ({ items: [changed] }));
    assert.equal((await h.publisher.reconcile(req)).status, 'unknown');
  }
});

test('unavailable original metadata after creating a community copy preserves the post ID and requires reconciliation', async t => {
  const h = await setup(t); await h.publisher.check(); const fixture = copiedPhotoFixture('public');
  h.handlers.set('wall.getById', () => ({ items: [fixture.copied] }));
  h.handlers.set('photos.getById', () => new Response('private upstream text', { status: 503 }));
  await assert.rejects(h.publisher.publish(fixture.req), error => {
    const value = error as import('../../src/publisher.js').PublicationError;
    assert.equal(value.kind, 'unknown'); assert.equal(value.result!.postId, '-55_100');
    assert.deepEqual(value.details, { method: 'photos.getById', httpStatus: 503 });
    assert.ok(!JSON.stringify(value).includes('private upstream text')); return true;
  });
  h.handlers.set('photos.getById', () => []);
  assert.equal((await h.publisher.reconcile({ ...fixture.req, candidatePostId: '-55_100' })).status, 'unknown');
  assert.equal(h.calls.filter(call => call.url.endsWith('wall.post')).length, 1);
});
