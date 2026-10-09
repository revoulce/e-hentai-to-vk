import type { Settings } from './shared/contracts.js';

function formatter(timezone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}
function formattedParts(date: Date, format: Intl.DateTimeFormat): { day: string; time: string } {
  const parts = format.formatToParts(date);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}
export function localParts(date: Date, timezone: string) { return formattedParts(date, formatter(timezone)); }

// Walk UTC minutes so DST gaps and repeated hours remain distinct real instants.
export function nextSlots(after: Date, settings: Settings, count = 1): string[] {
  const result: string[] = [];
  const format = formatter(settings.timezone);
  let cursor = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 60 * 24 * 32 && result.length < count; i++, cursor += 60_000) {
    if (settings.slots.includes(formattedParts(new Date(cursor), format).time)) {
      result.push(new Date(cursor).toISOString());
    }
  }
  return result;
}

export const DONUT_DELAY_MS = 60_000;
export const SCHEDULE_LEAD_MS = 30_000;

// Reserve both minutes together; an adjacent public slot may be occupied by Donut.
export function nextPairs(after: Date, settings: Settings, count = 1, occupied: Iterable<number> = []): string[] {
  if (count <= 0) return [];
  const busy = new Set(Array.from(occupied, instant => Math.floor(instant / 60_000)));
  const result: string[] = [];
  for (const slot of nextSlots(after, settings, count * 2 + busy.size * 2)) {
    const minute = Date.parse(slot) / 60_000;
    if (busy.has(minute) || busy.has(minute + 1)) continue;
    result.push(slot);
    busy.add(minute); busy.add(minute + 1);
    if (result.length >= count) break;
  }
  return result;
}
