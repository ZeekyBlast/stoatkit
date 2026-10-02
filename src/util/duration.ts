const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parses durations like `10m`, `2h` or `1h30m` into milliseconds. Returns null for anything else, zero included. */
export function parseDuration(text: string): number | null {
  const input = text.trim().toLowerCase();
  if (!/^(\d+[smhdw])+$/.test(input)) return null;
  let total = 0;
  for (const [, amount, unit] of input.matchAll(/(\d+)([smhdw])/g)) total += Number(amount) * UNIT_MS[unit!]!;
  return total > 0 && Number.isSafeInteger(total) ? total : null;
}
