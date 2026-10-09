import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { normalizeHashtags, renderTexts, samplePages, DEFAULT_SETTINGS, createDraftSchema } from '../../src/shared/contracts.js';
import { nextSlots, nextPairs } from '../../src/schedule.js';

test('tags normalize Unicode, preserve name order, remove duplicates and omit empty labels', () => {
  assert.deepEqual(normalizeHashtags(['Ｋｉｌｌ La Kill', 'kill_la_kill', '  ', '#Рюко Мато́й']), ['#kill_la_kill', '#рюко_мато_й']);
  assert.deepEqual(renderTexts({ fandom: [], character: [], model: ['Ignored'], includeModel: false }),
    { public: '', donut: '⭐ Эксклюзивное продолжение для Донов.' });
  const texts = renderTexts({ fandom: ['Kill la Kill'], character: ['Ryuko Matoi', 'Nui Harime'], model: ['Kate Sarkissian'], includeModel: true });
  assert.equal(texts.public, 'Фэндом: #kill_la_kill\nПерсонаж: #ryuko_matoi #nui_harime\nМодель: #kate_sarkissian');
  assert.equal(texts.donut, `${texts.public}\n⭐ Эксклюзивное продолжение для Донов.`);
});

test('12 pages rejected; 13 and all pages of large galleries can be sampled', () => {
  const gallery = { galleryUrl: 'https://e-hentai.org/g/123/abcdef1234/', title: 'Fixture' };
  assert.equal(createDraftSchema.safeParse({ ...gallery, pageCount: 12 }).success, false);
  assert.equal(createDraftSchema.safeParse({ ...gallery, galleryUrl: 'https://exhentai.org/g/123/abcdef1234/', pageCount: 13 }).success, false);
  assert.deepEqual(samplePages(13, 13, [], () => 0).toSorted((a,b) => a-b), Array.from({ length: 13 }, (_, i) => i + 1));
  assert.equal(samplePages(10_000, 1, [], max => max - 1)[0], 10_000);
  assert.equal(samplePages(10_000, 1, [], () => 0)[0], 1);
});

test('replacements exclude all current pages; every eligible index maps to exactly one free page', () => {
  const excluded = [1, 2, 5, 8, 13];
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => samplePages(14, 1, excluded, () => i)[0]), [3,4,6,7,9,10,11,12,14]);
  for (let i = 0; i < 100; i++) {
    const pages = samplePages(1000, 13, [], randomInt);
    assert.equal(new Set(pages).size, 13);
    assert.ok(pages.every(p => p >= 1 && p <= 1000));
    assert.ok(!pages.includes(samplePages(1000, 1, pages, randomInt)[0]!));
  }
  assert.throws(() => samplePages(13, 1, Array.from({ length: 13 }, (_, i) => i + 1), randomInt), RangeError);
});

test('Minsk slots are strictly future, with no overnight or catch-up slots', () => {
  assert.deepEqual(nextSlots(new Date('2026-10-08T04:59:59Z'), DEFAULT_SETTINGS, 2),
    ['2026-10-08T05:00:00.000Z', '2026-10-08T07:00:00.000Z']);
  assert.equal(nextSlots(new Date('2026-10-08T05:00:00Z'), DEFAULT_SETTINGS)[0], '2026-10-08T07:00:00.000Z');
  assert.equal(nextSlots(new Date('2026-10-08T17:00:00Z'), DEFAULT_SETTINGS)[0], '2026-10-09T05:00:00.000Z');
});

test('timezone calculation handles daylight-saving gaps', () => {
  const settings = { ...DEFAULT_SETTINGS, timezone: 'America/New_York', slots: ['02:30'] };
  assert.equal(nextSlots(new Date('2026-03-08T06:00:00Z'), settings)[0], '2026-03-09T06:30:00.000Z');
});

test('pairs avoid both occupied minutes, adjacent slots and midnight collisions', () => {
  const after = new Date('2026-10-08T14:00:00Z');
  const settings = { ...DEFAULT_SETTINGS, slots: ['18:00','18:01','20:00'] };
  const occupied = [Date.parse('2026-10-08T15:01:35Z')];
  assert.deepEqual(nextPairs(after, settings, 2, occupied), ['2026-10-08T17:00:00.000Z','2026-10-09T15:00:00.000Z']);
  assert.deepEqual(nextPairs(after, settings, 2), ['2026-10-08T15:00:00.000Z','2026-10-08T17:00:00.000Z']);
  assert.deepEqual(nextPairs(new Date('2026-10-08T20:00:00Z'), { ...settings, slots: ['00:00','23:59'] }, 2),
    ['2026-10-08T20:59:00.000Z','2026-10-09T20:59:00.000Z']);
});
