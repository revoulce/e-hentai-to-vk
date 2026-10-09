import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs, access, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp, { type Metadata } from 'sharp';
import { AppError, fail } from './errors.js';
import type { Service } from './service.js';

sharp.concurrency(1);
sharp.cache(false);

export const INPUT_FORMATS = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const inputTypes: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heif: 'image/avif' };

async function syncFile(path: string) {
  const file = await open(path, 'r+');
  try { await file.sync(); } finally { await file.close(); }
}

async function hasAvifSequence(path: string, bytes: number) {
  // HEIF decoders may expose only the primary still image of an AVIF sequence.
  // The AVIF specification identifies sequences with the avis FileTypeBox brand.
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(16);
    if ((await file.read(header, 0, 16, 0)).bytesRead !== 16 || header.toString('ascii', 4, 8) !== 'ftyp')
      fail('INVALID_IMAGE', 'Повреждён заголовок AVIF.');
    const extended = header.readUInt32BE(0) === 1;
    const headerSize = extended ? 16 : 8;
    const length = extended ? Number(header.readBigUInt64BE(8)) : header.readUInt32BE(0);
    if (length < headerSize + 8 || length > Math.min(bytes, 65_536) || (length - headerSize) % 4)
      fail('INVALID_IMAGE', 'Недопустимый заголовок AVIF.');
    const brands = Buffer.alloc(length - headerSize);
    if ((await file.read(brands, 0, brands.length, headerSize)).bytesRead !== brands.length)
      fail('INVALID_IMAGE', 'Неполный заголовок AVIF.');
    for (let offset = 0; offset < brands.length; offset += 4) {
      if (offset !== 4 && brands.toString('ascii', offset, offset + 4) === 'avis') return true;
    }
    return false;
  } finally { await file.close(); }
}

async function hasPngAnimation(path: string, bytes: number) {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(8);
    let offset = 8;
    for (let chunks = 0; offset + 12 <= bytes && chunks < 10_000; chunks++) {
      const read = await file.read(header, 0, 8, offset);
      if (read.bytesRead !== 8) fail('INVALID_IMAGE', 'Неполный PNG-файл.');
      const length = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      if (offset + 12 + length > bytes) fail('INVALID_IMAGE', 'Повреждена структура PNG.');
      if (type === 'acTL') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      offset += 12 + length;
    }
    fail('INVALID_IMAGE', 'Недопустимая структура PNG.');
  } finally { await file.close(); }
}

export class Storage {
  readonly directory: string;
  busy = false;
  constructor(readonly service: Service) { this.directory = join(service.config.dataDir, 'images'); }
  async init() { await mkdir(this.directory, { recursive: true }); }
  async ready() { await access(this.directory); await statfs(this.directory); }
  async usage() {
    let bytes = 0;
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (entry.isFile()) bytes += (await stat(join(this.directory, entry.name))).size;
    }
    return bytes;
  }
  async capacity() {
    const disk = await statfs(this.directory);
    return Math.min(this.service.config.maxFileBytes, this.service.config.quotaBytes - await this.usage(),
      Math.floor(disk.bavail * disk.bsize) - this.service.config.minFreeBytes);
  }
  async receive(input: Readable, path: string, capacity: number) {
    let bytes = 0;
    const hash = createHash('sha256');
    const maxFileBytes = this.service.config.maxFileBytes;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxFileBytes) return callback(new AppError('FILE_TOO_LARGE', 'Исходный или итоговый файл превышает допустимый размер.', 413));
      if (bytes > capacity) return callback(new AppError('STORAGE_QUOTA', 'Превышена квота хранилища.', 507, true));
      hash.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(input, limiter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    return { bytes, hash: hash.digest('hex') };
  }
  async upload(draftId: string, assetId: string, version: number, input: Readable, sourceKind: string, declaredBytes?: number) {
    if (this.busy) fail('UPLOAD_BUSY', 'Уже обрабатывается изображение. Повторите загрузку после завершения.', 409, true);
    this.service.uploadTarget(draftId, assetId, version);
    if (!['page', 'free_original'].includes(sourceKind)) fail('INVALID_SOURCE_KIND', 'Укажите page либо free_original.');
    const config = this.service.config;
    if (declaredBytes !== undefined && declaredBytes > config.maxFileBytes) fail('FILE_TOO_LARGE', 'Файл превышает допустимый размер.', 413);
    this.busy = true;
    const temporary = join(this.directory, `${randomUUID()}.part`);
    const converted = join(this.directory, `${randomUUID()}.part`);
    const ownedFiles = new Set([temporary, converted]);
    try {
      const capacity = await this.capacity();
      if (capacity <= 0) fail('STORAGE_QUOTA', 'Недостаточно свободного места для новой подготовки.', 507, true);
      if (declaredBytes !== undefined && declaredBytes > capacity) fail('STORAGE_QUOTA', 'Недостаточно свободного места для файла.', 507, true);
      const source = await this.receive(input, temporary, capacity);
      if (!source.bytes) fail('INVALID_IMAGE', 'Получен пустой файл.');
      if (declaredBytes !== undefined && declaredBytes !== source.bytes) fail('INCOMPLETE_UPLOAD', 'Размер полученного файла отличается от заявленного.');
      let metadata: Metadata;
      let final = source;
      let finalMetadata: Metadata;
      let transformed = false;
      const decoder = sharp(temporary, { failOn: 'warning', limitInputPixels: config.maxPixels });
      try {
        metadata = await decoder.metadata();
        if ((metadata.pages ?? 1) > 1 || (metadata.format === 'png' && await hasPngAnimation(temporary, source.bytes)) ||
            (metadata.format === 'heif' && metadata.compression === 'av1' && await hasAvifSequence(temporary, source.bytes)))
          fail('ANIMATION_UNSUPPORTED', 'Анимация требует замены; один кадр автоматически не извлекается.');
        if (!inputTypes[metadata.format ?? ''] || (metadata.format === 'heif' && metadata.compression !== 'av1'))
          fail('FORMAT_UNSUPPORTED', `Формат ${metadata.format ?? 'неизвестен'} не поддерживается. Поддержаны статические JPEG, PNG, WebP, GIF и AVIF. Замените файл.`);
        if (!metadata.width || !metadata.height || metadata.width * metadata.height > config.maxPixels) fail('PIXEL_LIMIT', 'Изображение превышает лимит декодирования.');
        transformed = !['jpeg', 'png'].includes(metadata.format!);
        finalMetadata = metadata;
        if (transformed) {
          // Account for the original plus the output while both are on disk.
          const outputCapacity = await this.capacity();
          if (outputCapacity <= 0) fail('STORAGE_QUOTA', 'Недостаточно места для преобразования изображения.', 507, true);
          final = await this.receive(decoder.autoOrient().keepIccProfile().png(), converted, outputCapacity);
          const output = sharp(converted, { failOn: 'warning', limitInputPixels: config.maxPixels });
          try { finalMetadata = await output.metadata(); } finally { output.destroy(); }
        } else {
          // Fully decode compatible files but preserve their exact bytes.
          await decoder.stats();
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        fail('INVALID_IMAGE', 'Файл повреждён или превышает лимит декодирования.');
      } finally { decoder.destroy(); }
      await syncFile(temporary);
      const committed = join(this.directory, `${randomUUID()}.${finalMetadata.format === 'jpeg' ? 'jpg' : 'png'}`);
      ownedFiles.add(committed);
      let sourcePath: string | null = null;
      if (transformed) {
        await syncFile(converted);
        sourcePath = join(this.directory, `${randomUUID()}.${metadata.format === 'heif' ? 'avif' : metadata.format}`);
        ownedFiles.add(sourcePath);
        await rename(temporary, sourcePath);
        await rename(converted, committed);
      } else { await rename(temporary, committed); }
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      const result = this.service.recordUpload(draftId, assetId, version, {
        mime: finalMetadata.format === 'jpeg' ? 'image/jpeg' : 'image/png', width: finalMetadata.width!, height: finalMetadata.height!,
        bytes: final.bytes, finalHash: final.hash, path: committed, sourceKind,
        sourceMime: inputTypes[metadata.format!]!, sourceBytes: source.bytes, sourceWidth: metadata.width!, sourceHeight: metadata.height!,
        sourceHash: source.hash, sourcePath,
      });
      ownedFiles.clear(); // Ownership transferred to SQLite; preserve both referenced files.
      return result;
    } finally {
      try {
        for (const path of ownedFiles) await rm(path, { force: true });
      } finally { this.busy = false; }
    }
  }
  preview(assetId: string) {
    const asset = this.service.db.prepare(`SELECT a.* FROM assets a JOIN draft_assets da ON da.asset_id = a.id
      JOIN drafts d ON d.id = da.draft_id WHERE a.id = ? AND a.state = 'ready'
      AND (d.state = 'confirmed' OR (d.state != 'expired' AND d.expires_at > ?))`)
      .get(assetId, this.service.now().toISOString());
    if (!asset?.path) fail('NOT_FOUND', 'Предпросмотр недоступен.', 404);
    return { stream: createReadStream(asset.path as string), mime: asset.mime as string };
  }
  async cleanup() {
    if (this.busy) return;
    // Keep maintenance and upload mutually exclusive, including directory scans.
    this.busy = true;
    try {
      const now = this.service.now();
      this.service.db.prepare("UPDATE drafts SET state = 'expired' WHERE state NOT IN ('confirmed','expired') AND expires_at <= ?").run(now.toISOString());
      const candidates = this.service.db.prepare(`SELECT a.id, a.path, a.source_path FROM assets a JOIN drafts d ON d.id = a.draft_id
        LEFT JOIN jobs j ON j.draft_id = d.id WHERE a.state != 'deleted' AND (
        (j.id IS NULL AND (d.state = 'expired' OR NOT EXISTS (SELECT 1 FROM draft_assets da WHERE da.asset_id = a.id))) OR
        (j.state IN ('completed','scheduled') AND j.updated_at <= ?) OR (j.state = 'cancelled' AND j.updated_at <= ?))`)
        .all(new Date(now.getTime() - this.service.config.completedTtlMs).toISOString(),
          new Date(now.getTime() - this.service.config.cancelledTtlMs).toISOString());
      for (const asset of candidates) {
        if (asset.path) await rm(asset.path as string, { force: true });
        if (asset.source_path) await rm(asset.source_path as string, { force: true });
        this.service.db.prepare("UPDATE assets SET state = 'deleted', path = NULL, source_path = NULL, deleted_at = ? WHERE id = ?").run(now.toISOString(), asset.id!);
      }
      const referenced = new Set(this.service.db.prepare('SELECT path FROM assets WHERE path IS NOT NULL UNION SELECT source_path AS path FROM assets WHERE source_path IS NOT NULL').all().map(a => a.path));
      for (const name of await readdir(this.directory)) {
        const path = join(this.directory, name);
        if (!referenced.has(path)) await rm(path, { force: true });
      }
    } finally { this.busy = false; }
  }
}
