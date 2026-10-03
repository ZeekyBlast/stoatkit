// Makes a recorded session safe to publish: ids, usernames, server names and avatar files are replaced,
// consistently, so the replay test still works on the result.
// Run from the repo root: node scripts/anonymize.ts <raw-recording.json> test/fixtures/session.json
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: node scripts/anonymize.ts <raw-recording.json> <output.json>");
  process.exit(1);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Fields that hold an uploaded file (avatar, icon, banner): their ids and previews point at real images. */
const FILE_FIELDS = new Set(["avatar", "icon", "banner"]);

/** Same id in, same id out. The first 10 characters (the time) are kept, so createdAt and audit freshness still work. */
function fakeId(id: string): string {
  const hash = createHash("sha256").update(id).digest();
  let tail = "";
  for (let i = 0; i < 16; i++) tail += CROCKFORD[hash[i]! % 32];
  return id.slice(0, 10) + tail;
}

const names = new Map<string, string>();
function fakeName(real: string, bot: boolean): string {
  if (!names.has(real)) names.set(real, bot ? "testbot" : `user${names.size + 1}`);
  return names.get(real)!;
}

function scrub(value: unknown, key: string): unknown {
  if (typeof value === "string") return ULID.test(value) ? fakeId(value) : value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (!value || typeof value !== "object") return value;

  const obj = value as Record<string, unknown>;
  if (FILE_FIELDS.has(key)) {
    return { _id: "anonymized-file", tag: obj.tag, filename: "file.jpg", metadata: { type: "Image", width: 1, height: 1 }, content_type: obj.content_type, size: 1 };
  }
  const bot = obj.bot != null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const outKey = ULID.test(k) ? fakeId(k) : k; // role and permission maps are keyed by id
    if ((k === "username" || k === "display_name") && typeof v === "string") out[outKey] = fakeName(v, bot);
    else if (k === "discriminator") out[outKey] = "0001";
    else if (k === "name" && "owner" in obj && "channels" in obj) out[outKey] = "Test Server"; // a server object
    else out[outKey] = scrub(v, k);
  }
  return out;
}

const frames = JSON.parse(readFileSync(input, "utf8")) as unknown[];
writeFileSync(output, JSON.stringify(scrub(frames, ""), null, 2) + "\n");
console.log(`Wrote ${frames.length} anonymized frames to ${output}`);
