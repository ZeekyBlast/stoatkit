const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const MAX_TIME = 2 ** 48 - 1;

/** True when `id` is 26 Crockford base32 characters (case-insensitive). */
export function isUlid(id: string): boolean {
  return ULID_RE.test(id);
}

/** The creation time encoded in a ULID's first 10 characters. */
export function ulidToDate(id: string): Date {
  if (!isUlid(id)) throw new TypeError(`Not a ULID: ${id}`);
  let time = 0;
  for (const char of id.slice(0, 10).toUpperCase()) time = time * 32 + ALPHABET.indexOf(char);
  if (time > MAX_TIME) throw new TypeError(`ULID timestamp out of range: ${id}`);
  return new Date(time);
}
