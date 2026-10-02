// Records which Stoat API version src/generated/api.ts came from, and checks it against the live API.
// Usage: node scripts/spec-version.ts write|check
import { writeFile } from "node:fs/promises";

const SPEC_URL = "https://api.stoat.chat/openapi.json";
const VERSION_FILE = new URL("../src/generated/version.ts", import.meta.url);

const res = await fetch(SPEC_URL);
if (!res.ok) throw new Error(`Could not fetch ${SPEC_URL}: ${res.status}`);
const live = ((await res.json()) as { info: { version: string } }).info.version;

const mode = process.argv[2];
if (mode === "write") {
  await writeFile(VERSION_FILE, `export const STOAT_API_VERSION = "${live}";\n`);
  console.log(`stoat api: recorded ${live}`);
} else if (mode === "check") {
  const { STOAT_API_VERSION } = await import(VERSION_FILE.href);
  if (STOAT_API_VERSION === live) {
    console.log(`stoat api: up to date (${live})`);
  } else {
    console.log(`stoat api changed: ${STOAT_API_VERSION} -> ${live}. Run npm run gen:types and review the diff.`);
    process.exitCode = 1;
  }
} else {
  console.error("Usage: node scripts/spec-version.ts write|check");
  process.exitCode = 1;
}
