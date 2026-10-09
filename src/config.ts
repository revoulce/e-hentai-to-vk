import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export interface VkConfig {
  group: string; tokenFile: string; donutReferencePost?: string; donutPermanentConfirmedPost?: string;
  photoPrivacyVerified: boolean; timeoutMs: number;
}
export interface Config {
  host: string; port: number; dataDir: string; tokenFile: string;
  maxFileBytes: number; maxPixels: number; quotaBytes: number; minFreeBytes: number;
  draftTtlMs: number; completedTtlMs: number; cancelledTtlMs: number;
  vk?: VkConfig;
}
export function vkGroup(value: string): string {
  let group = value.trim();
  if (group.startsWith('https://')) {
    const url = new URL(group);
    if (!['vk.com', 'vk.ru'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash)
      throw new Error('VK_GROUP_ID: нужен ID, короткое имя или HTTPS-ссылка на сообщество VK.');
    group = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  group = group.replace(/^@/, '').replace(/^-(?=\d+$)/, '').replace(/^(?:club|public)(?=\d+$)/, '');
  return z.string().regex(/^(?:[1-9]\d*|[a-zA-Z][a-zA-Z0-9_.]{0,99})$/).parse(group);
}
export function vkPost(value: string): string {
  let post = value.trim();
  if (post.startsWith('https://')) {
    const url = new URL(post);
    if (!['vk.com', 'vk.ru'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash)
      throw new Error('VK_DONUT_REFERENCE_POST: нужна ссылка на пост стены сообщества VK.');
    post = url.pathname.replace(/^\/wall/, '');
  }
  return z.string().regex(/^-[1-9]\d*_[1-9]\d*$/).parse(post);
}
export function loadConfig(env = process.env): Config {
  const integer = (name: string, fallback: number) => z.coerce.number().int().positive().parse(env[name] ?? fallback);
  if (!env.API_TOKEN_FILE) throw new Error('Укажите API_TOKEN_FILE: путь к файлу API-токена владельца.');
  return {
    host: env.HOST ?? '127.0.0.1', port: integer('PORT', 3000),
    dataDir: resolve(env.DATA_DIR ?? 'data'), tokenFile: resolve(env.API_TOKEN_FILE),
    maxFileBytes: integer('MAX_FILE_BYTES', 50 * 1024 ** 2),
    maxPixels: integer('MAX_PIXELS', 40_000_000), quotaBytes: integer('QUOTA_BYTES', 10 * 1024 ** 3),
    minFreeBytes: integer('MIN_FREE_BYTES', 2 * 1024 ** 3),
    draftTtlMs: integer('DRAFT_TTL_HOURS', 24) * 3_600_000,
    completedTtlMs: integer('COMPLETED_TTL_HOURS', 72) * 3_600_000,
    cancelledTtlMs: integer('CANCELLED_TTL_HOURS', 24) * 3_600_000,
    ...(env.VK_TOKEN_FILE ? { vk: {
      group: vkGroup(env.VK_GROUP_ID ?? 'quetzalcoatl_cosplay'), tokenFile: resolve(env.VK_TOKEN_FILE),
      donutReferencePost: env.VK_DONUT_REFERENCE_POST ? vkPost(env.VK_DONUT_REFERENCE_POST) : undefined,
      donutPermanentConfirmedPost: env.VK_DONUT_PERMANENT_CONFIRMED_POST ? vkPost(env.VK_DONUT_PERMANENT_CONFIRMED_POST) : undefined,
      photoPrivacyVerified: z.enum(['true', 'false']).parse(env.VK_PHOTO_PRIVACY_VERIFIED ?? 'false') === 'true',
      timeoutMs: integer('VK_TIMEOUT_MS', 60_000),
    } } : {}),
  };
}
export function readToken(path: string): string {
  const token = readFileSync(path, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('API-токен должен содержать 32–256 символов base64url.');
  return token;
}
