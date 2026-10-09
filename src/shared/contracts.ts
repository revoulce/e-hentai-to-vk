import { z } from 'zod';

export const ROLES = ['public', 'donut'] as const;
export type Role = (typeof ROLES)[number];
export const primaryAttachmentsModeSchema = z.enum(['carousel', 'grid']);
export type PrimaryAttachmentsMode = z.infer<typeof primaryAttachmentsModeSchema>;
export const DONUT_FOOTER = '⭐ Эксклюзивное продолжение для Донов.';
export const API_PREFIX = '/ehvk/api/v1';

const tagList = z.array(z.string().trim().min(1).max(200)).max(50);
export const fieldsSchema = z.object({
  fandom: tagList,
  character: tagList,
  model: tagList,
  includeModel: z.boolean(),
}).strict();
export type TextFields = z.infer<typeof fieldsSchema>;
export const createDraftSchema = z.object({
  galleryUrl: z.string().max(200).regex(/^https:\/\/e-hentai\.org\/g\/[1-9]\d*\/[a-f0-9]{10}\/$/),
  title: z.string().trim().min(1).max(1000),
  pageCount: z.number().int().min(13).max(1_000_000),
  tags: z.object({ parody: tagList.optional(), character: tagList.optional(), cosplayer: tagList.optional() }).strict().default({}),
}).strict();
export type CreateDraft = z.infer<typeof createDraftSchema>;
export const patchDraftSchema = z.object({
  version: z.number().int().positive(),
  fields: fieldsSchema.optional(),
  replaceAssetId: z.string().uuid().optional(),
}).strict().refine(v => v.fields !== undefined || v.replaceAssetId !== undefined);
export const confirmSchema = z.object({
  version: z.number().int().positive(),
  repeatConfirmed: z.boolean().default(false),
}).strict();
export const settingsPatchSchema = z.object({
  version: z.number().int().positive(),
  timezone: z.string().max(100).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }).optional(),
  slots: z.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)).min(1).max(24)
    .refine(v => new Set(v).size === v.length).optional(),
  includeModel: z.boolean().optional(),
  primaryAttachmentsMode: primaryAttachmentsModeSchema.optional(),
}).strict();

export interface Settings {
  version: number;
  timezone: string;
  slots: string[];
  includeModel: boolean;
  primaryAttachmentsMode: PrimaryAttachmentsMode;
  paused: boolean;
  gpSpendingAllowed: false;
  permanentDonut: true;
  vkAuthorizationBlocked: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  version: 1, timezone: 'Europe/Minsk',
  slots: ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00'],
  includeModel: true, primaryAttachmentsMode: 'carousel', paused: false, gpSpendingAllowed: false, permanentDonut: true, vkAuthorizationBlocked: false,
};

export function normalizeHashtags(values: string[]): string[] {
  return [...new Set(values.map(v => v.normalize('NFKC').toLowerCase()
    .replace(/^#+/, '').replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/_+/g, '_').replace(/^_|_$/g, '')).filter(Boolean))].map(v => `#${v}`);
}
export function renderTexts(fields: TextFields): Record<Role, string> {
  const lines = [
    ['Фэндом', fields.fandom], ['Персонаж', fields.character],
    ['Модель', fields.includeModel ? fields.model : []],
  ] as const;
  const text = lines.map(([label, values]) => {
    const tags = normalizeHashtags([...values]);
    return tags.length ? `${label}: ${tags.join(' ')}` : '';
  }).filter(Boolean).join('\n');
  return { public: text, donut: [text, DONUT_FOOTER].filter(Boolean).join('\n') };
}

// Sparse Fisher–Yates: memory is bounded by the sample size, even for large galleries.
export function samplePages(total: number, count: number, excluded: number[], rng: (max: number) => number): number[] {
  const unavailable = new Set(excluded);
  const remaining = total - unavailable.size;
  if (remaining < count) throw new RangeError('Недостаточно свободных страниц.');
  const indices = new Map<number, number>();
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    const j = rng(remaining - i);
    let index = indices.get(j) ?? j;
    indices.set(j, indices.get(remaining - i - 1) ?? remaining - i - 1);
    for (const page of [...unavailable].sort((a, b) => a - b)) {
      if (page - 1 <= index) index++;
    }
    result.push(index + 1);
  }
  return result;
}
