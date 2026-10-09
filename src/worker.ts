import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ROLES } from './shared/contracts.js';
import { AppError } from './errors.js';
import { nextPairs, DONUT_DELAY_MS, SCHEDULE_LEAD_MS } from './schedule.js';
import { PublicationError, type Publisher, type PublishRequest, type PublishResult } from './publisher.js';
import type { Service, Snapshot, PostRow } from './service.js';

export class Worker {
  busy = false;
  get authBlocked() { return this.service.settings().vkAuthorizationBlocked; }
  set authBlocked(value: boolean) {
    this.service.store.saveSettings({ ...this.service.settings(), vkAuthorizationBlocked: value });
  }
  private occupiedInVk: number[] = [];
  constructor(readonly service: Service, readonly publisher: Publisher,
    private readonly wait: (ms: number) => Promise<unknown> = delay) {}
  private occupied(excludeJob?: string) {
    const rows = this.service.db.prepare(`SELECT p.publish_at FROM posts p JOIN jobs j ON j.id = p.job_id
      WHERE p.publish_at IS NOT NULL AND (j.state != 'cancelled' OR p.state IN ('scheduled','posted','unknown'))
      AND (? IS NULL OR p.job_id != ?)`).all(excludeJob ?? null, excludeJob ?? null);
    const earliest = Math.floor(this.service.now().getTime() / 60_000) * 60_000;
    return [...this.occupiedInVk, ...rows.map(row => Date.parse(row.publish_at as string))].filter(time => time >= earliest);
  }
  forecast(count = 7) {
    return this.service.settings().paused ? [] : nextPairs(new Date(this.service.now().getTime() + SCHEDULE_LEAD_MS),
      this.service.settings(), count, this.occupied());
  }
  recover() {
    this.service.store.transaction(() => {
      this.service.db.prepare("UPDATE posts SET state = 'unknown', last_error = 'RESULT_UNKNOWN' WHERE state = 'sending'").run();
      this.service.db.prepare("UPDATE posts SET state = CASE WHEN attachments = '[]' THEN 'pending' ELSE 'ready' END WHERE state = 'uploading'").run();
      this.service.db.prepare("UPDATE attempts SET state = 'unknown', updated_at = ? WHERE state = 'started'").run(this.service.now().toISOString());
      this.service.db.prepare(`UPDATE jobs SET state = CASE
        WHEN EXISTS (SELECT 1 FROM posts p WHERE p.job_id = jobs.id AND p.state = 'unknown') THEN 'needs_attention'
        WHEN (SELECT COUNT(*) FROM posts p WHERE p.job_id = jobs.id AND p.state IN ('posted','scheduled')) = 2
          THEN CASE WHEN EXISTS (SELECT 1 FROM posts p WHERE p.job_id = jobs.id AND p.state = 'scheduled') THEN 'scheduled' ELSE 'completed' END
        WHEN EXISTS (SELECT 1 FROM posts p WHERE p.job_id = jobs.id AND p.state IN ('posted','scheduled')) THEN 'partial'
        ELSE 'retry_wait' END, updated_at = ? WHERE state = 'publishing'`).run(this.service.now().toISOString());
    });
  }
  async tick() {
    if (this.busy) return;
    if (this.service.settings().paused || this.authBlocked) return;
    this.busy = true;
    try {
      const rows = this.service.db.prepare(`SELECT j.id FROM jobs j
        WHERE (j.state = 'queued' OR (j.state IN ('retry_wait','partial') AND j.updated_at <= ?)) AND NOT EXISTS
        (SELECT 1 FROM posts p WHERE p.job_id = j.id AND p.state IN ('unknown','sending'))
        ORDER BY EXISTS (SELECT 1 FROM posts p WHERE p.job_id = j.id AND p.state IN ('posted','scheduled')) DESC,
        j.confirmed_at, j.rowid`).all(new Date(this.service.now().getTime() - 60_000).toISOString());
      if (!rows.length) return;
      await this.publisher.check?.();
      if (!this.publisher.available()) return;
      for (const row of rows) {
        if (this.service.settings().paused || this.authBlocked || !this.publisher.available()) break;
        const jobId = row.id as string;
        // Cancellation may happen while a previous pair is being uploaded.
        if (!['queued','retry_wait','partial'].includes(this.service.jobRow(jobId).state)) continue;
        this.service.db.prepare("UPDATE jobs SET state = 'publishing', last_error = NULL, updated_at = ? WHERE id = ?")
          .run(this.service.now().toISOString(), jobId);
        await this.process(jobId);
      }
    } finally { this.busy = false; }
  }
  private request(post: PostRow, snapshot: Snapshot): PublishRequest {
    return { role: post.role, text: snapshot.texts[post.role], attachments: JSON.parse(post.attachments),
      operationKey: post.operation_key, permanentDonut: true,
      ...(post.publish_at ? { publishAt: Date.parse(post.publish_at) / 1000 } : {}),
      ...(post.post_id ? { candidatePostId: post.post_id } : {}) };
  }
  private savePosted(post: PostRow, result: PublishResult) {
    this.service.db.prepare('UPDATE posts SET state = ?, post_id = ?, post_url = ?, last_error = NULL, last_error_details = NULL WHERE id = ?')
      .run(post.publish_at ? 'scheduled' : 'posted', result.postId, result.url, post.id);
  }
  async reconcileJob(id: string) {
    if (this.busy) throw new AppError('WORKER_BUSY', 'Дождитесь завершения текущей операции.', 409, true);
    this.busy = true;
    try {
      await this.publisher.check?.();
      if (!this.publisher.available()) throw new AppError('VK_NOT_VERIFIED', 'Проверьте подключение VK в настройках.', 409);
      const job = this.service.jobRow(id);
      if (!this.service.posts(id).some(p => p.state === 'unknown')) throw new AppError('RECONCILIATION_NOT_REQUIRED', 'У задачи нет неопределённой публикации.', 409);
      const snapshot = JSON.parse(job.snapshot) as Snapshot;
      for (const post of this.service.posts(id).filter(p => p.state === 'unknown')) {
        let result;
        try { result = await this.publisher.reconcile(this.request(post, snapshot)); }
        catch { throw new AppError('RESULT_UNKNOWN', 'Результат публикации по-прежнему не установлен.', 409, true); }
        if (result.status === 'unknown') throw new AppError('RESULT_UNKNOWN', 'Результат публикации по-прежнему не установлен.', 409);
        if (result.status === 'posted') this.savePosted(post, result.result);
        else this.service.db.prepare("UPDATE posts SET state = 'ready', last_error = NULL, last_error_details = NULL WHERE id = ?").run(post.id);
      }
      const complete = this.service.posts(id).every(p => ['posted','scheduled'].includes(p.state));
      this.service.db.prepare('UPDATE jobs SET state = ?, updated_at = ?, last_error = NULL WHERE id = ?')
        .run(complete ? this.finishedState(id) : 'queued', this.service.now().toISOString(), id);
      return this.service.job(id);
    } finally { this.busy = false; }
  }
  async checkPublisher() {
    if (this.busy) throw new AppError('WORKER_BUSY', 'Дождитесь завершения текущей операции.', 409, true);
    this.busy = true;
    try {
      await this.publisher.check?.();
      if (this.publisher.available()) this.authBlocked = false;
    } finally { this.busy = false; }
  }
  private async uploads(post: PostRow, snapshot: Snapshot) {
    const selected = snapshot.assets.filter(a => a.role === post.role).toSorted((a, b) => a.page - b.page);
    const attachments: string[] = JSON.parse(post.attachments);
    this.service.db.prepare("UPDATE posts SET state = 'uploading', last_error = NULL, last_error_details = NULL WHERE id = ?").run(post.id);
    for (const asset of selected.slice(attachments.length)) {
      await this.service.verifyFiles([asset]);
      let uploaded: string | undefined;
      for (let i = 0; i < 3; i++) {
        const attempt = this.intent(post.id, 'upload', { assetId: asset.id, role: post.role });
        try {
          uploaded = await this.publisher.upload(asset, post.role);
          this.finish(attempt, 'succeeded', { attachment: uploaded });
          break;
        } catch (error) {
          this.finish(attempt, 'failed', { code: error instanceof PublicationError ? error.code ?? error.kind : 'transient',
            ...(error instanceof PublicationError && error.details ? { details: error.details } : {}) });
          if (error instanceof PublicationError && error.kind !== 'transient') throw error;
          if (i === 2) throw error instanceof PublicationError ? error : new PublicationError('transient');
          await this.wait(1000 * 2 ** i);
        }
      }
      attachments.push(uploaded!);
      this.service.db.prepare('UPDATE posts SET attachments = ? WHERE id = ?').run(JSON.stringify(attachments), post.id);
    }
    this.service.db.prepare("UPDATE posts SET state = 'ready' WHERE id = ?").run(post.id);
  }
  private intent(postId: string, operation: string, request: unknown) {
    const id = randomUUID();
    const now = this.service.now().toISOString();
    this.service.db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(id, postId, operation, 'started', JSON.stringify(request), now, now);
    return id;
  }
  private finish(id: string, state: string, result: unknown) {
    this.service.db.prepare('UPDATE attempts SET state = ?, result = ?, updated_at = ? WHERE id = ?')
      .run(state, JSON.stringify(result), this.service.now().toISOString(), id);
  }
  private finishedState(id: string) {
    return this.service.posts(id).some(post => post.state === 'scheduled') ? 'scheduled' : 'completed';
  }
  private async reserve(id: string) {
    this.occupiedInVk = await this.publisher.scheduledTimes?.() ?? [];
    this.service.store.transaction(() => {
      const remaining = this.service.posts(id).filter(post => !['posted','scheduled'].includes(post.state));
      const after = new Date(this.service.now().getTime() + SCHEDULE_LEAD_MS);
      const occupied = this.occupied(id);
      if (remaining.length === 1) {
        const other = this.service.posts(id).find(post => ['posted','scheduled'].includes(post.state));
        const intended = other?.publish_at && remaining[0]!.role === 'donut'
          ? Date.parse(other.publish_at) + DONUT_DELAY_MS : NaN;
        if (intended > after.getTime() && !occupied.some(time => Math.floor(time / 60_000) === intended / 60_000)) {
          this.service.db.prepare('UPDATE posts SET publish_at = ? WHERE id = ?').run(new Date(intended).toISOString(), remaining[0]!.id);
          return;
        }
      }
      const [slot] = nextPairs(after, this.service.settings(), 1, occupied);
      if (!slot) throw new PublicationError('transient', 'VK_SCHEDULE_FULL');
      for (const post of remaining) {
        const instant = Date.parse(slot) + (post.role === 'donut' ? DONUT_DELAY_MS : 0);
        this.service.db.prepare('UPDATE posts SET publish_at = ? WHERE id = ?').run(new Date(instant).toISOString(), post.id);
      }
    });
  }
  private async process(id: string) {
    const snapshot = JSON.parse(this.service.jobRow(id).snapshot) as Snapshot;
    // Prepare all photos before choosing a time, so a slow upload cannot consume its slot.
    for (const role of ROLES) {
      const post = this.service.posts(id).find(p => p.role === role)!;
      if (['posted','scheduled'].includes(post.state)) continue;
      try { await this.uploads(post, snapshot); }
      catch (error) { this.failed(id, post, error, false); return; }
    }
    try { await this.reserve(id); }
    catch (error) {
      this.failed(id, this.service.posts(id).find(p => !['posted','scheduled'].includes(p.state))!, error, false);
      return;
    }
    for (const role of ROLES) {
      let post = this.service.posts(id).find(p => p.role === role)!;
      if (['posted','scheduled'].includes(post.state)) continue;
      let creating = false;
      try {
        // If VK was slow, choose a future time again without touching an accepted post.
        if (Date.parse(post.publish_at!) <= this.service.now().getTime() + SCHEDULE_LEAD_MS) {
          await this.reserve(id); post = this.service.posts(id).find(p => p.role === role)!;
        }
        const request = this.request(post, snapshot);
        const attempt = this.service.store.transaction(() => {
          this.service.db.prepare("UPDATE posts SET state = 'sending' WHERE id = ?").run(post.id);
          return this.intent(post.id, 'publish', request);
        });
        creating = true;
        try {
          const result = await this.publisher.publish(request);
          this.service.store.transaction(() => { this.savePosted(post, result); this.finish(attempt, 'succeeded', result); });
        } catch (error) {
          this.finish(attempt, 'failed', { code: error instanceof PublicationError ? error.code ?? error.kind : 'unknown',
            ...(error instanceof PublicationError && error.details ? { details: error.details } : {}),
            ...(error instanceof PublicationError && error.result ? { candidate: error.result } : {}) });
          throw error;
        }
      } catch (error) {
        this.failed(id, post, error, creating);
        return;
      }
    }
    this.service.db.prepare('UPDATE jobs SET state = ?, last_error = NULL, updated_at = ? WHERE id = ?')
      .run(this.finishedState(id), this.service.now().toISOString(), id);
  }
  private failed(id: string, post: PostRow, error: unknown, creating: boolean) {
    const kind = error instanceof PublicationError ? error.kind : creating ? 'unknown' : error instanceof AppError ? 'permanent' : 'transient';
    if (kind === 'authorization') this.authBlocked = true;
    const code = error instanceof AppError ? error.code : error instanceof PublicationError && error.code ? error.code : ({ unknown: 'RESULT_UNKNOWN', transient: 'VK_TEMPORARY',
      authorization: 'VK_AUTH_REQUIRED', permanent: 'VK_REJECTED' } as const)[kind];
    const postState = kind === 'unknown' ? 'unknown' : kind === 'transient' ? 'retry_wait' : 'failed';
    const partial = this.service.posts(id).some(p => ['posted','scheduled'].includes(p.state));
    this.service.store.transaction(() => {
      if (error instanceof PublicationError && error.result) {
        this.service.db.prepare('UPDATE posts SET post_id = ?, post_url = ? WHERE id = ?').run(error.result.postId, error.result.url, post.id);
      }
      this.service.db.prepare('UPDATE posts SET state = ?, last_error = ?, last_error_details = ? WHERE id = ?')
        .run(postState, code, error instanceof PublicationError && error.details ? JSON.stringify(error.details) : null, post.id);
      this.service.db.prepare('UPDATE jobs SET state = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(kind === 'unknown' || kind === 'authorization' || kind === 'permanent' ? 'needs_attention' : partial ? 'partial' : 'retry_wait',
          code, this.service.now().toISOString(), id);
    });
  }
}
