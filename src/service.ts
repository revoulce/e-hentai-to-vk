import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  createDraftSchema, patchDraftSchema, confirmSchema, settingsPatchSchema, renderTexts, samplePages,
  API_PREFIX, ROLES, type Role, type TextFields,
} from './shared/contracts.js';
import type { Config } from './config.js';
import { Store } from './database.js';
import { fail } from './errors.js';

export interface AssetRow {
  id: string; draft_id: string; page: number; state: string; role: Role; position: number;
  source_kind: string | null; mime: string | null; width: number | null; height: number | null;
  bytes: number | null; source_sha256: string | null; final_sha256: string | null; path: string | null;
  source_mime?: string | null; source_bytes?: number | null; source_width?: number | null;
  source_height?: number | null; source_path?: string | null;
}
interface DraftRow {
  id: string; gallery_id: string; version: number; fields: string; state: string;
  created_at: string; updated_at: string; expires_at: string;
}
export interface Snapshot {
  gallery: GalleryRow; version: number; fields: TextFields; texts: Record<Role, string>;
  assets: AssetRow[]; permanentDonut: true;
}
interface GalleryRow { id: string; url: string; title: string; page_count: number; tags: string }
export interface JobRow {
  id: string; draft_id: string; gallery_id: string; snapshot: string; state: string;
  confirmed_at: string; updated_at: string; last_error: string | null;
}
export interface PostRow {
  id: string; job_id: string; role: Role; state: string; attachments: string; operation_key: string;
  post_id: string | null; post_url: string | null; last_error: string | null;
  publish_at: string | null;
  last_error_details: string | null;
}

export async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export class Service {
  constructor(readonly store: Store, readonly config: Config, readonly now = () => new Date()) {}
  get db() { return this.store.db; }
  settings() { return this.store.settings(); }
  updateSettings(body: unknown) {
    const input = settingsPatchSchema.parse(body);
    return this.store.transaction(() => {
      const value = this.settings();
      if (value.version !== input.version) fail('VERSION_CONFLICT', 'Настройки уже изменены. Получите актуальную версию.', 409);
      const updated = { ...value, ...input, slots: (input.slots ?? value.slots).toSorted(), version: value.version + 1 };
      this.store.saveSettings(updated);
      return updated;
    });
  }
  pause(paused: boolean) {
    return this.store.transaction(() => {
      const settings = { ...this.settings(), paused, version: this.settings().version + 1 };
      this.store.saveSettings(settings);
      return settings;
    });
  }
  gallery(id: string): GalleryRow {
    return this.db.prepare('SELECT * FROM galleries WHERE id = ?').get(id) as unknown as GalleryRow;
  }
  draftRow(id: string): DraftRow {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as unknown as DraftRow | undefined;
    if (!row) fail('NOT_FOUND', 'Черновик не найден.', 404);
    return row;
  }
  editable(id: string, version: number): DraftRow {
    const row = this.draftRow(id);
    if (row.state === 'confirmed') fail('DRAFT_CONFIRMED', 'Принятый набор уже зафиксирован.', 409);
    if (row.state === 'expired' || row.expires_at <= this.now().toISOString()) fail('DRAFT_EXPIRED', 'Срок хранения черновика истёк.', 410);
    if (row.version !== version) fail('VERSION_CONFLICT', 'Предпросмотр изменён. Получите актуальную версию.', 409);
    return row;
  }
  assets(id: string): AssetRow[] {
    return this.db.prepare(`SELECT a.*, da.role, da.position FROM draft_assets da
      JOIN assets a ON a.id = da.asset_id WHERE da.draft_id = ? ORDER BY da.role DESC, a.page`).all(id) as unknown as AssetRow[];
  }
  duplicates(galleryId: string) {
    return this.db.prepare('SELECT id, state, confirmed_at FROM jobs WHERE gallery_id = ? ORDER BY confirmed_at DESC').all(galleryId);
  }
  publicAsset(asset: AssetRow) {
    const { path: _path, source_path: _sourcePath, draft_id: _draft, ...visible } = asset;
    const current = this.db.prepare('SELECT state, path FROM assets WHERE id = ?').get(asset.id);
    const available = current?.state === 'ready' && Boolean(current.path);
    return { ...visible, fileAvailable: available, previewUrl: available ? `${API_PREFIX}/assets/${asset.id}/preview` : null,
      source_mime: asset.source_mime ?? asset.mime, source_bytes: asset.source_bytes ?? asset.bytes,
      source_width: asset.source_width ?? asset.width, source_height: asset.source_height ?? asset.height,
      transformed: Boolean(asset.source_sha256 && asset.final_sha256 && asset.source_sha256 !== asset.final_sha256) };
  }
  draft(id: string) {
    const row = this.draftRow(id);
    const state = row.state !== 'confirmed' && row.expires_at <= this.now().toISOString() ? 'expired' : row.state;
    const fields = JSON.parse(row.fields) as TextFields;
    return { ...row, state, fields, gallery: this.gallery(row.gallery_id), assets: this.assets(id).map(a => this.publicAsset(a)),
      texts: renderTexts(fields), duplicates: this.duplicates(row.gallery_id), replacementAvailable: this.gallery(row.gallery_id).page_count > 13 };
  }
  createDraft(body: unknown) {
    const input = createDraftSchema.parse(body);
    const id = randomUUID();
    const galleryId = input.galleryUrl.split('/').slice(4, 6).join(':');
    const timestamp = this.now().toISOString();
    const fields: TextFields = { fandom: input.tags.parody ?? [], character: input.tags.character ?? [],
      model: input.tags.cosplayer ?? [], includeModel: this.settings().includeModel };
    const pages = samplePages(input.pageCount, 13, [], randomInt);
    this.store.transaction(() => {
      const previous = this.db.prepare('SELECT page_count FROM galleries WHERE id = ?').get(galleryId);
      if (previous && previous.page_count !== input.pageCount) fail('GALLERY_CONFLICT', 'Число страниц ранее сохранённой галереи отличается.', 409);
      this.db.prepare('INSERT OR IGNORE INTO galleries VALUES (?, ?, ?, ?, ?)')
        .run(galleryId, input.galleryUrl, input.title, input.pageCount, JSON.stringify(input.tags));
      this.db.prepare('INSERT INTO drafts VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
        .run(id, galleryId, JSON.stringify(fields), 'preparing', timestamp, timestamp,
          new Date(this.now().getTime() + this.config.draftTtlMs).toISOString());
      for (const role of ROLES) {
        const selected = (role === 'public' ? pages.slice(0, 4) : pages.slice(4)).toSorted((a, b) => a - b);
        selected.forEach((page, position) => this.insertAsset(id, role, position, page));
      }
    });
    return this.draft(id);
  }
  insertAsset(draft: string, role: Role, position: number, page: number): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO assets (id, draft_id, page) VALUES (?, ?, ?)').run(id, draft, page);
    this.db.prepare('INSERT INTO draft_assets VALUES (?, ?, ?, ?)').run(draft, role, position, id);
    return id;
  }
  touch(id: string) {
    const assets = this.assets(id);
    const state = assets.length === 13 && assets.every(a => a.state === 'ready') ? 'ready' : 'preparing';
    this.db.prepare('UPDATE drafts SET version = version + 1, state = ?, updated_at = ?, expires_at = ? WHERE id = ?')
      .run(state, this.now().toISOString(), new Date(this.now().getTime() + this.config.draftTtlMs).toISOString(), id);
  }
  patchDraft(id: string, body: unknown) {
    const input = patchDraftSchema.parse(body);
    this.store.transaction(() => {
      const draft = this.editable(id, input.version);
      if (input.fields) this.db.prepare('UPDATE drafts SET fields = ? WHERE id = ?').run(JSON.stringify(input.fields), id);
      if (input.replaceAssetId) {
        const assets = this.assets(id);
        const old = assets.find(a => a.id === input.replaceAssetId);
        if (!old) fail('NOT_FOUND', 'Изображение отсутствует в текущем наборе.', 404);
        if (this.gallery(draft.gallery_id).page_count === 13) fail('NO_REPLACEMENT', 'Все 13 страниц уже выбраны; свободной страницы нет.', 409);
        const [page] = samplePages(this.gallery(draft.gallery_id).page_count, 1, assets.map(a => a.page), randomInt);
        this.db.prepare('DELETE FROM draft_assets WHERE draft_id = ? AND asset_id = ?').run(id, old.id);
        this.insertAsset(id, old.role, old.position, page!);
      }
      this.touch(id);
    });
    return this.draft(id);
  }
  uploadTarget(draftId: string, assetId: string, version: number) {
    this.editable(draftId, version);
    const asset = this.assets(draftId).find(a => a.id === assetId);
    if (!asset) fail('NOT_FOUND', 'Изображение отсутствует в текущем наборе.', 404);
    return asset;
  }
  recordUpload(draftId: string, assetId: string, version: number, asset: {
    mime: string; width: number; height: number; bytes: number; finalHash: string; path: string; sourceKind: string;
    sourceMime: string; sourceBytes: number; sourceWidth: number; sourceHeight: number; sourceHash: string; sourcePath: string | null;
  }) {
    this.store.transaction(() => {
      this.uploadTarget(draftId, assetId, version);
      const duplicate = this.assets(draftId).some(a => a.id !== assetId &&
        [a.source_sha256, a.final_sha256].some(hash => hash === asset.sourceHash || hash === asset.finalHash));
      if (duplicate) fail('DUPLICATE_IMAGE', 'Этот файл уже выбран. Замените страницу другим изображением.', 409);
      this.db.prepare(`UPDATE assets SET state = 'ready', source_kind = ?, mime = ?, width = ?, height = ?, bytes = ?,
        source_sha256 = ?, final_sha256 = ?, path = ?, source_mime = ?, source_bytes = ?, source_width = ?,
        source_height = ?, source_path = ? WHERE id = ?`)
        .run(asset.sourceKind, asset.mime, asset.width, asset.height, asset.bytes, asset.sourceHash, asset.finalHash,
          asset.path, asset.sourceMime, asset.sourceBytes, asset.sourceWidth, asset.sourceHeight, asset.sourcePath, assetId);
      this.touch(draftId);
    });
    return this.draft(draftId);
  }
  validateSelection(assets: AssetRow[]) {
    if (assets.filter(a => a.role === 'public').length !== 4 || assets.filter(a => a.role === 'donut').length !== 9 ||
      assets.some(a => a.state !== 'ready' || !a.path || !a.final_sha256)) fail('INCOMPLETE_SET', 'Нужны 4 и 9 готовых изображений.', 409);
    if (new Set(assets.map(a => a.page)).size !== 13 || new Set(assets.map(a => a.source_sha256)).size !== 13 ||
      new Set(assets.map(a => a.final_sha256)).size !== 13) fail('DUPLICATE_IMAGE', 'Для пары нужны 13 уникальных страниц и файлов.', 409);
  }
  async verifyFiles(assets: AssetRow[]) {
    for (const asset of assets) {
      try {
        if (!asset.path || (await stat(asset.path)).size !== asset.bytes || await fileHash(asset.path) !== asset.final_sha256) throw new Error();
      } catch { fail('ASSET_LOST', 'Сохранённый файл отсутствует или изменён. Требуется новый предпросмотр.', 409); }
    }
  }
  async confirm(id: string, body: unknown, key: string) {
    const input = confirmSchema.parse(body);
    if (!/^[\x21-\x7e]{8,200}$/.test(key)) fail('IDEMPOTENCY_KEY_REQUIRED', 'Нужен Idempotency-Key длиной 8–200 символов.');
    const fingerprint = createHash('sha256').update(JSON.stringify({ id, ...input })).digest('hex');
    const existingKey = this.db.prepare('SELECT * FROM confirmation_keys WHERE key = ?').get(key);
    if (existingKey) {
      if (existingKey.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'Этот ключ уже использован для другого подтверждения.', 409);
      return this.job(existingKey.job_id as string);
    }
    const existing = this.db.prepare('SELECT id FROM jobs WHERE draft_id = ?').get(id);
    if (existing) {
      this.db.prepare('INSERT INTO confirmation_keys VALUES (?, ?, ?)').run(key, existing.id!, fingerprint);
      return this.job(existing.id as string);
    }
    this.editable(id, input.version);
    const assets = this.assets(id);
    this.validateSelection(assets);
    await this.verifyFiles(assets);
    const jobId = this.store.transaction(() => {
      // Another confirmation may have completed while hashes were being checked.
      const racedKey = this.db.prepare('SELECT * FROM confirmation_keys WHERE key = ?').get(key);
      if (racedKey) {
        if (racedKey.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'Этот ключ уже использован.', 409);
        return racedKey.job_id as string;
      }
      const previous = this.db.prepare('SELECT id FROM jobs WHERE draft_id = ?').get(id);
      if (previous) {
        this.db.prepare('INSERT INTO confirmation_keys VALUES (?, ?, ?)').run(key, previous.id!, fingerprint);
        return previous.id as string;
      }
      const draft = this.editable(id, input.version);
      this.validateSelection(this.assets(id));
      if (this.duplicates(draft.gallery_id).length && !input.repeatConfirmed) fail('REPEAT_CONFIRMATION_REQUIRED', 'Галерея уже отправлялась. Подтвердите повтор отдельно.', 409);
      const texts = renderTexts(JSON.parse(draft.fields) as TextFields);
      if (Object.values(texts).some(text => text.length > 4096)) fail('TEXT_TOO_LONG', 'Текст превышает внутренний лимит 4096 символов.');
      const snapshot: Snapshot = { gallery: this.gallery(draft.gallery_id), version: input.version,
        fields: JSON.parse(draft.fields), texts, assets: this.assets(id), permanentDonut: true };
      const jobId = randomUUID();
      const timestamp = this.now().toISOString();
      this.db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
        .run(jobId, id, draft.gallery_id, JSON.stringify(snapshot), 'queued', timestamp, timestamp);
      for (const role of ROLES) this.db.prepare(`INSERT INTO posts
        (id, job_id, role, state, operation_key) VALUES (?, ?, ?, 'pending', ?)`)
        .run(randomUUID(), jobId, role, randomUUID());
      this.db.prepare('INSERT INTO confirmation_keys VALUES (?, ?, ?)').run(key, jobId, fingerprint);
      this.db.prepare("UPDATE drafts SET state = 'confirmed' WHERE id = ?").run(id);
      return jobId;
    });
    return this.job(jobId);
  }
  jobRow(id: string): JobRow {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
    if (!row) fail('NOT_FOUND', 'Задача не найдена.', 404);
    return row;
  }
  posts(id: string): PostRow[] {
    return this.db.prepare('SELECT * FROM posts WHERE job_id = ? ORDER BY role DESC').all(id) as unknown as PostRow[];
  }
  job(id: string) {
    const row = this.jobRow(id);
    const snapshot = JSON.parse(row.snapshot) as Snapshot;
    return { ...row, snapshot: { ...snapshot, assets: snapshot.assets.map(a => this.publicAsset(a)) },
      posts: this.posts(id).map(({ operation_key: _key, ...post }) => ({ ...post, attachments: JSON.parse(post.attachments),
        last_error_details: post.last_error_details ? JSON.parse(post.last_error_details) : null })) };
  }
  listJobs(filters: { galleryUrl?: string; state?: string; from?: string; to?: string; limit: number; offset: number }, history = false) {
    const conditions = history ? ["j.state IN ('scheduled','completed','cancelled','partial','needs_attention')"] : [];
    const params: (string | number)[] = [];
    for (const [column, value] of [['g.url', filters.galleryUrl], ['j.state', filters.state],
      ['j.confirmed_at >=', filters.from], ['j.confirmed_at <=', filters.to]] as const) {
      if (value) { conditions.push(`${column}${column.endsWith('=') ? '' : ' ='} ?`); params.push(value); }
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM jobs j JOIN galleries g ON g.id = j.gallery_id ${where}`).get(...params)!.n;
    const rows = this.db.prepare(`SELECT j.id FROM jobs j JOIN galleries g ON g.id = j.gallery_id ${where}
      ORDER BY j.confirmed_at ${history ? 'DESC' : 'ASC'}, j.rowid ${history ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`).all(...params, filters.limit, filters.offset);
    return { items: rows.map(r => this.job(r.id as string)), total, limit: filters.limit, offset: filters.offset };
  }
  cancel(id: string) {
    this.store.transaction(() => {
      const job = this.jobRow(id);
      if (job.state === 'publishing') fail('JOB_BUSY', 'Дождитесь завершения текущей внешней операции.', 409);
      if (this.posts(id).some(p => p.state === 'unknown' || p.state === 'sending')) fail('RESULT_UNKNOWN', 'Сначала нужно установить результат публикации ВК.', 409);
      if (job.state === 'completed') fail('JOB_COMPLETED', 'Пара уже опубликована.', 409);
      if (job.state === 'scheduled') fail('JOB_IN_VK', 'Пара уже передана в отложенные ВК. Измените или отмените посты в ВК.', 409);
      this.db.prepare("UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ?").run(this.now().toISOString(), id);
    });
    return this.job(id);
  }
  retry(id: string) {
    this.store.transaction(() => {
      const job = this.jobRow(id);
      if (!['retry_wait', 'partial', 'needs_attention'].includes(job.state)) fail('RETRY_NOT_ALLOWED', 'Эту задачу сейчас нельзя повторить.', 409);
      if (this.posts(id).some(p => ['unknown', 'sending'].includes(p.state))) fail('RESULT_UNKNOWN', 'Сначала нужно установить результат публикации ВК.', 409);
      this.db.prepare("UPDATE posts SET state = CASE WHEN attachments = '[]' THEN 'pending' ELSE 'ready' END, last_error = NULL, last_error_details = NULL WHERE job_id = ? AND state NOT IN ('posted','scheduled')").run(id);
      this.db.prepare("UPDATE jobs SET state = 'queued', last_error = NULL, updated_at = ? WHERE id = ?").run(this.now().toISOString(), id);
    });
    return this.job(id);
  }
}
