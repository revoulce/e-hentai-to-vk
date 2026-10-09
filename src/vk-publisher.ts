import { openAsBlob, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { VkConfig } from './config.js';
import type { AssetRow } from './service.js';
import type { Role } from './shared/contracts.js';
import { PublicationError, type Publisher, type PublisherStatus, type PublishRequest, type PublishResult, type Reconciliation } from './publisher.js';

export const VK_API_VERSION = '5.199';
const REQUIRED_PERMISSIONS = 4 | 8192; // photos | wall
const id = z.number().int().safe().positive();
const ownerId = z.number().int().safe().refine(value => value !== 0);
const photoSize = z.object({ width: z.number().int().nonnegative(), height: z.number().int().nonnegative(),
  url: z.string().url().optional(), src: z.string().url().optional() });
const photo = z.object({ id, owner_id: ownerId, access_key: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  sizes: z.array(photoSize).default([]), orig_photo: photoSize.optional() });
const post = z.object({
  id, owner_id: ownerId, from_id: ownerId, text: z.string(), is_deleted: z.boolean().optional(),
  date: z.number().int().nonnegative().optional(), post_type: z.string().optional(),
  donut: z.object({ is_donut: z.boolean(), paid_duration: z.number().int().optional() }).optional(),
  attachments: z.array(z.object({ type: z.string(), photo: photo.optional() })).default([]),
});
const posts = z.object({ items: z.array(post) });
const wallPage = posts.extend({ count: z.number().int().nonnegative() });
const groupResponse = z.object({ groups: z.array(z.object({
  id, name: z.string(), screen_name: z.string().optional(), is_admin: z.number().int(), admin_level: z.number().int(),
  can_post: z.number().int().optional(), deactivated: z.string().optional(),
})).length(1) });
type VkPost = z.infer<typeof post>;
type VkPhoto = z.infer<typeof photo>;

function photoContentKeys(value: VkPhoto): Set<string> {
  const variants = [...(value.sizes ?? []), ...(value.orig_photo ? [value.orig_photo] : [])]
    .filter(size => size.width > 0 && size.height > 0 && (size.url || size.src));
  const largest = Math.max(0, ...variants.map(size => size.width * size.height));
  return new Set(variants.filter(size => size.width * size.height === largest)
    .flatMap(size => [size.url, size.src].filter((url): url is string => Boolean(url))
      .map(url => `${size.width}x${size.height}\0${url}`)));
}

/** VK can copy uploader photos into the community. Require full-size media
 * identity and a one-to-one match; thumbnails or equal dimensions alone do not prove it. */
export function vkPhotoCopiesMatch(originals: VkPhoto[], copies: VkPhoto[]): boolean {
  if (!originals.length || originals.length !== copies.length) return false;
  const originalKeys = originals.map(photoContentKeys), copyKeys = copies.map(photoContentKeys);
  const edges = originalKeys.map(keys => copyKeys.flatMap((other, index) =>
    [...keys].some(key => other.has(key)) ? [index] : []));
  const assigned = new Array<number>(copies.length).fill(-1);
  function assign(original: number, visited: Set<number>): boolean {
    for (const copy of edges[original]!) {
      if (visited.has(copy)) continue;
      visited.add(copy);
      if (assigned[copy] === -1 || assign(assigned[copy]!, visited)) { assigned[copy] = original; return true; }
    }
    return false;
  }
  return originals.every((_, index) => assign(index, new Set()));
}

// Report only JSON field types, never upload payloads, hashes or access keys.
function uploadFieldType(value: unknown): string {
  return value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}
type State = 'ready' | 'authorization_required' | 'donut_verification_required' | 'privacy_verification_required'
  | 'temporary_error' | 'verification_required' | 'group_mismatch';

/** Only the API response may supply an upload host. Never forward a VK token to that host. */
export function vkUploadUrl(raw: string): string {
  const url = new URL(raw);
  const domains = ['vk.com', 'vk.ru', 'vkuserphoto.ru', 'userapi.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)))
    throw new PublicationError('permanent', 'VK_UPLOAD_URL');
  return url.href;
}

export class VkPublisher implements Publisher {
  private state: State = 'verification_required';
  private code: string | undefined;
  private apiErrorCode: number | undefined;
  private donutReference: PublisherStatus['donutReference'];
  private group: { id: number; name: string } | undefined;
  private uploaderId: number | undefined;
  private originalPhotos = new Map<string, VkPhoto[]>();
  private lastCall = 0;
  constructor(readonly config: VkConfig, private readonly options: {
    fetch?: typeof fetch; wait?: (ms: number) => Promise<unknown>; now?: () => number; pinGroup?: (id: number) => void;
  } = {}) {}
  available() { return this.state === 'ready'; }
  status() {
    return { state: this.state, code: this.code, apiErrorCode: this.apiErrorCode, donutReference: this.donutReference, ...(this.group ? {
      groupId: this.group.id, groupName: this.group.name, groupUrl: `https://vk.com/club${this.group.id}`,
    } : {}) };
  }
  private token() {
    try {
      const token = readFileSync(this.config.tokenFile, 'utf8').trim();
      // VK tokens are not the owner's API token; their length and format differ.
      if (!/^[A-Za-z0-9_.-]{32,4096}$/.test(token)) throw new Error();
      return token;
    } catch { throw new PublicationError('authorization', 'VK_TOKEN_REQUIRED'); }
  }
  private mark(error: PublicationError) {
    if (error.kind === 'authorization') { this.state = 'authorization_required'; this.code = error.code ?? 'VK_AUTH_REQUIRED'; }
  }
  private async json(url: string, body: URLSearchParams | FormData, ambiguous = false, method?: string): Promise<unknown> {
    let response: Response;
    try {
      const transport = this.options.fetch ?? fetch;
      response = await transport(url, { method: 'POST', body, credentials: 'omit', redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs) });
    } catch { throw new PublicationError(ambiguous ? 'unknown' : 'transient', 'VK_NETWORK_ERROR', undefined, { method }); }
    if (!response.ok) {
      const details = { method, httpStatus: response.status };
      if (response.status === 429) throw new PublicationError('transient', 'VK_HTTP_ERROR', undefined, details);
      if (response.status === 401 || response.status === 403) throw new PublicationError('authorization', 'VK_HTTP_ERROR', undefined, details);
      throw new PublicationError(response.status >= 500 ? ambiguous ? 'unknown' : 'transient' : 'permanent', 'VK_HTTP_ERROR', undefined, details);
    }
    try { return await response.json(); }
    catch { throw new PublicationError(ambiguous ? 'unknown' : 'transient', 'VK_RESPONSE_INVALID', undefined, { method }); }
  }
  private async api<T>(method: string, params: Record<string, string | number>, schema: z.ZodType<T>, ambiguous = false): Promise<T> {
    try {
      const token = this.token();
      const now = this.options.now ?? Date.now;
      const remaining = 400 - (now() - this.lastCall);
      if (remaining > 0) await (this.options.wait ?? delay)(remaining);
      this.lastCall = now();
      const body = new URLSearchParams({ access_token: token, v: VK_API_VERSION });
      for (const [key, value] of Object.entries(params)) body.set(key, String(value));
      const raw = await this.json(`https://api.vk.com/method/${method}`, body, ambiguous, method);
      const envelope = z.object({ response: z.unknown().optional(), error: z.object({ error_code: z.number().int() }).optional() }).safeParse(raw);
      if (!envelope.success) throw new PublicationError(ambiguous ? 'unknown' : 'transient', 'VK_RESPONSE_INVALID', undefined, { method });
      if (envelope.data.error) {
        const code = envelope.data.error.error_code;
        this.apiErrorCode = code;
        const details = { method, apiErrorCode: code };
        if ([5, 7, 14, 15, 17, 20, 27, 28, 200, 203, 214].includes(code)) throw new PublicationError('authorization', 'VK_AUTH_REQUIRED', undefined, details);
        if ([6, 9, 29].includes(code)) throw new PublicationError('transient', 'VK_TEMPORARY', undefined, details);
        if ([1, 10].includes(code)) throw new PublicationError(ambiguous ? 'unknown' : 'transient', undefined, undefined, details);
        throw new PublicationError('permanent', 'VK_REJECTED', undefined, details);
      }
      const result = schema.safeParse(envelope.data.response);
      if (!result.success) throw new PublicationError(ambiguous ? 'unknown' : 'transient', 'VK_RESPONSE_INVALID', undefined, { method });
      return result.data;
    } catch (error) {
      const safe = error instanceof PublicationError ? error : new PublicationError(ambiguous ? 'unknown' : 'transient', undefined, undefined, { method });
      this.mark(safe); throw safe;
    }
  }
  async check(): Promise<void> {
    this.state = 'verification_required'; this.code = undefined; this.apiErrorCode = undefined; this.donutReference = undefined;
    this.uploaderId = undefined;
    this.originalPhotos.clear();
    try {
      const permissions = await this.api('account.getAppPermissions', {}, z.number().int().nonnegative());
      if ((permissions & REQUIRED_PERMISSIONS) !== REQUIRED_PERMISSIONS) throw new PublicationError('authorization', 'VK_PERMISSIONS_REQUIRED');
      const [uploader] = await this.api('users.get', {}, z.array(z.object({ id })).length(1));
      this.uploaderId = uploader!.id;
      const result = await this.api('groups.getById', { group_ids: this.config.group, fields: 'can_post' }, groupResponse);
      const group = result.groups[0]!;
      if (group.is_admin !== 1 || group.admin_level < 3 || group.can_post === 0 || group.deactivated)
        throw new PublicationError('authorization', 'VK_ADMIN_REQUIRED');
      try { this.options.pinGroup?.(group.id); }
      catch { this.state = 'group_mismatch'; this.code = 'VK_GROUP_MISMATCH'; return; }
      this.group = group;
      if (!this.config.donutReferencePost) {
        this.state = 'donut_verification_required'; this.code = 'VK_DONUT_REFERENCE_REQUIRED'; return;
      }
      this.donutReference = { postId: this.config.donutReferencePost };
      if (!this.config.donutReferencePost.startsWith(`-${group.id}_`)) {
        this.state = 'donut_verification_required'; this.code = 'VK_DONUT_REFERENCE_WRONG_GROUP'; return;
      }
      const reference = (await this.api('wall.getById', { posts: this.config.donutReferencePost }, posts)).items;
      if (reference.length !== 1 || `${reference[0]!.owner_id}_${reference[0]!.id}` !== this.config.donutReferencePost
        || reference[0]!.is_deleted) {
        this.donutReference.found = false;
        this.state = 'donut_verification_required'; this.code = 'VK_DONUT_REFERENCE_NOT_FOUND'; return;
      }
      this.donutReference = { postId: this.config.donutReferencePost, found: true,
        isDonut: reference[0]!.donut?.is_donut ?? false, paidDuration: reference[0]!.donut?.paid_duration };
      if (!this.donutReference.isDonut) {
        this.state = 'donut_verification_required'; this.code = 'VK_DONUT_REFERENCE_NOT_DONUT'; return;
      }
      if (this.donutReference.paidDuration === undefined) {
        if (this.config.donutPermanentConfirmedPost !== this.config.donutReferencePost) {
          this.state = 'donut_verification_required'; this.code = 'VK_DONUT_DURATION_UNAVAILABLE'; return;
        }
        this.donutReference.durationSource = 'owner_confirmation';
      } else if (this.donutReference.paidDuration !== -1) {
        this.state = 'donut_verification_required'; this.code = 'VK_DONUT_NOT_PERMANENT'; return;
      } else this.donutReference.durationSource = 'api';
      if (!this.config.photoPrivacyVerified) {
        this.state = 'privacy_verification_required'; this.code = 'VK_PHOTO_PRIVACY_REQUIRED'; return;
      }
      // Read-only preflight verifies access to wall photo uploads without creating a photo/post.
      const upload = await this.api('photos.getWallUploadServer', { group_id: group.id }, z.object({ upload_url: z.string() }));
      vkUploadUrl(upload.upload_url);
      this.state = 'ready';
    } catch (error) {
      const safe = error instanceof PublicationError ? error : new PublicationError('transient');
      this.state = safe.kind === 'authorization' ? 'authorization_required' : safe.kind === 'transient' ? 'temporary_error' : 'verification_required';
      this.code = safe.code ?? (safe.kind === 'authorization' ? 'VK_AUTH_REQUIRED' : safe.kind === 'transient' ? 'VK_TEMPORARY' : 'VK_REJECTED');
    }
  }
  private requireReady() {
    if (!this.available() || !this.group || !this.uploaderId) throw new PublicationError('permanent', 'VK_NOT_VERIFIED');
    return this.group.id;
  }
  async upload(asset: AssetRow, role: Role): Promise<string> {
    const groupId = this.requireReady();
    if (!asset.path || asset.role !== role || !['image/jpeg', 'image/png'].includes(asset.mime ?? ''))
      throw new PublicationError('permanent', 'VK_ASSET_INVALID');
    const server = await this.api('photos.getWallUploadServer', { group_id: groupId }, z.object({ upload_url: z.string() }));
    const url = vkUploadUrl(server.upload_url);
    const body = new FormData();
    body.append('photo', await openAsBlob(asset.path, { type: asset.mime! }), `${asset.id}.${asset.mime === 'image/png' ? 'png' : 'jpg'}`);
    const raw = await this.json(url, body, false, 'photos.upload');
    const fields = z.object({ server: z.unknown().optional(), photo: z.unknown().optional(), hash: z.unknown().optional() }).safeParse(raw);
    const details = { method: 'photos.upload', responseFields: {
      server: uploadFieldType(fields.success ? fields.data.server : undefined),
      photo: uploadFieldType(fields.success ? fields.data.photo : undefined),
      hash: uploadFieldType(fields.success ? fields.data.hash : undefined),
    } };
    const returnedPhoto = fields.success ? fields.data.photo : undefined;
    if (typeof returnedPhoto === 'string' && (!returnedPhoto.trim() || /^\[\s*\]$/.test(returnedPhoto.trim()))
      || Array.isArray(returnedPhoto) && !returnedPhoto.length) {
      throw new PublicationError('transient', 'VK_UPLOAD_EMPTY', undefined, details);
    }
    const uploaded = z.object({ server: z.number().int(), photo: z.string().min(1), hash: z.string().min(1) }).safeParse(raw);
    if (!uploaded.success) throw new PublicationError('transient', 'VK_UPLOAD_RESPONSE_INVALID', undefined, details);
    // Do not use photos.save, photos.createAlbum or any public album for the Donut set.
    const saved = await this.api('photos.saveWallPhoto', { group_id: groupId, ...uploaded.data }, z.array(photo).length(1));
    const attachment = saved[0]!;
    // A wall photo can belong to the authenticated uploader. Its owner is part
    // of the attachment ID; wall.post controls the wall and post author separately.
    const expectedOwnerId = attachment.owner_id > 0 ? this.uploaderId! : -groupId;
    if (attachment.owner_id !== expectedOwnerId) throw new PublicationError('permanent', 'VK_PHOTO_OWNER_MISMATCH', undefined,
      { method: 'photos.saveWallPhoto', expectedOwnerId, actualOwnerId: attachment.owner_id });
    return `photo${attachment.owner_id}_${attachment.id}${attachment.access_key ? `_${attachment.access_key}` : ''}`;
  }
  private validateRequest(request: PublishRequest, groupId: number) {
    if (!request.permanentDonut || !['public', 'donut'].includes(request.role) || !request.operationKey
      || (request.primaryAttachmentsMode !== undefined && !['carousel', 'grid'].includes(request.primaryAttachmentsMode))
      || request.attachments.length !== (request.role === 'public' ? 4 : 9)
      || new Set(request.attachments).size !== request.attachments.length
      || request.attachments.some(value => !new RegExp(`^photo(?:-${groupId}|${this.uploaderId})_[1-9]\\d*(?:_[A-Za-z0-9_-]+)?$`).test(value)))
      throw new PublicationError('permanent', 'VK_POST_REQUEST_INVALID');
    if (request.publishAt !== undefined && (!Number.isSafeInteger(request.publishAt) || request.publishAt <= 0))
      throw new PublicationError('permanent', 'VK_SCHEDULE_INVALID');
  }
  private result(postId: number): PublishResult {
    const full = `-${this.group!.id}_${postId}`;
    return { postId: full, url: `https://vk.com/wall${full}` };
  }
  private async matches(actual: VkPost, request: PublishRequest): Promise<boolean> {
    if (actual.owner_id !== -this.group!.id || actual.from_id !== -this.group!.id || actual.is_deleted || actual.text !== request.text) return false;
    if (request.publishAt !== undefined && (actual.date !== request.publishAt
      || !['postpone', 'post'].includes(actual.post_type ?? '')
      || (request.publishAt > Math.floor((this.options.now ?? Date.now)() / 1000) && actual.post_type !== 'postpone'))) return false;
    // wall.getById can omit paid_duration even for permanent Donut. The durable request
    // sets -1 explicitly; an observed finite duration must still reject the result.
    if (request.role === 'donut' ? actual.donut?.is_donut !== true
      || (actual.donut.paid_duration !== undefined && actual.donut.paid_duration !== -1) : actual.donut?.is_donut === true) return false;
    const wanted = request.attachments.map(value => value.match(/^photo(-?\d+_\d+)/)![1]).sort();
    const attached = actual.attachments.map(value => value.type === 'photo' && value.photo ? `${value.photo.owner_id}_${value.photo.id}` : '').sort();
    if (wanted.length !== attached.length) return false;
    if (wanted.every((value, index) => value === attached[index])) return true;
    // Only community-owned copies qualify for this fallback. Look up the exact
    // saved photo IDs, including access keys; never accept arbitrary photos by count.
    if (actual.attachments.some(value => value.type !== 'photo' || value.photo?.owner_id !== -this.group!.id)) return false;
    const key = request.attachments.join(',');
    let originals = this.originalPhotos.get(key);
    if (!originals) {
      originals = await this.api('photos.getById', { photos: request.attachments.map(value => value.slice('photo'.length)).join(',') }, z.array(photo));
      const originalIds = originals.map(value => `${value.owner_id}_${value.id}`).sort();
      if (originalIds.length !== wanted.length || !wanted.every((value, index) => value === originalIds[index])) return false;
      this.originalPhotos.set(key, originals);
    }
    return vkPhotoCopiesMatch(originals, actual.attachments.map(value => value.photo!));
  }
  async publish(request: PublishRequest): Promise<PublishResult> {
    const groupId = this.requireReady();
    this.validateRequest(request, groupId);
    if (request.publishAt !== undefined && request.publishAt <= Math.floor((this.options.now ?? Date.now)() / 1000))
      throw new PublicationError('transient', 'VK_SCHEDULE_EXPIRED');
    const params: Record<string, string | number> = { owner_id: -groupId, from_group: 1, signed: 0,
      message: request.text, attachments: request.attachments.join(','), guid: request.operationKey,
      primary_attachments_mode: request.primaryAttachmentsMode ?? 'carousel' };
    if (request.role === 'donut') params.donut_paid_duration = -1;
    if (request.publishAt !== undefined) params.publish_date = request.publishAt;
    const created = await this.api('wall.post', params, z.object({ post_id: id }), true);
    const result = this.result(created.post_id);
    try {
      const actual = (await this.api('wall.getById', { posts: result.postId }, posts)).items;
      if (actual.length !== 1 || actual[0]!.id !== created.post_id || !await this.matches(actual[0]!, request)) {
        this.state = 'verification_required'; this.code = 'VK_POST_VERIFICATION_FAILED';
        throw new PublicationError('unknown', 'VK_POST_VERIFICATION_FAILED', result);
      }
    } catch (error) {
      // A post ID has already been returned. Never classify a readback failure as safe to repeat.
      throw new PublicationError('unknown', error instanceof PublicationError ? error.code : undefined, result,
        error instanceof PublicationError ? error.details : undefined);
    }
    return result;
  }
  async reconcile(request: PublishRequest): Promise<Reconciliation> {
    const groupId = this.requireReady();
    this.validateRequest(request, groupId);
    if (request.candidatePostId) {
      if (!new RegExp(`^-${groupId}_[1-9]\\d*$`).test(request.candidatePostId)) return { status: 'unknown' };
      const found = (await this.api('wall.getById', { posts: request.candidatePostId }, posts)).items;
      return found.length === 1 && `${found[0]!.owner_id}_${found[0]!.id}` === request.candidatePostId && await this.matches(found[0]!, request)
        ? { status: 'posted', result: this.result(found[0]!.id) } : { status: 'unknown' };
    }
    const found: VkPost[] = [];
    const filters = request.publishAt === undefined ? [request.role === 'donut' ? 'donut' : 'owner']
      : ['postponed', request.role === 'donut' ? 'donut' : 'owner'];
    for (const filter of filters) {
      for (let offset = 0; offset < 1000; offset += 100) {
        const page = await this.api('wall.get', { owner_id: -groupId, filter, count: 100, offset }, wallPage);
        for (const actual of page.items) {
          if (!await this.matches(actual, request)) continue;
          if (!found.some(value => value.id === actual.id)) found.push(actual);
        }
        if (found.length > 1) return { status: 'unknown' };
        if (offset + page.items.length >= page.count || page.items.length === 0) break;
      }
    }
    // Missing from a wall listing does not prove absence: permissions, deletion and VK delays matter.
    return found.length === 1 ? { status: 'posted', result: this.result(found[0]!.id) } : { status: 'unknown' };
  }
  async scheduledTimes(): Promise<number[]> {
    const groupId = this.requireReady();
    const times: number[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.api('wall.get', { owner_id: -groupId, filter: 'postponed', count: 100, offset }, wallPage);
      if (page.items.some(actual => actual.date === undefined)) throw new PublicationError('transient', 'VK_SCHEDULE_UNAVAILABLE');
      times.push(...page.items.map(actual => actual.date! * 1000));
      if (offset + page.items.length >= page.count) return times;
      if (!page.items.length || offset >= 9900) throw new PublicationError('transient', 'VK_SCHEDULE_UNAVAILABLE');
    }
  }
}
