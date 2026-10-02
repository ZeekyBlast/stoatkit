// Records real gateway traffic (60s, or until Ctrl+C) into test/fixtures/session.json for the replay test.
// Run from the repo root: node --env-file=.env scripts/record.ts
import { mkdir, writeFile } from "node:fs/promises";

type Frame = { type: string; v?: Frame[]; [key: string]: unknown };

const token = process.env.STOAT_TOKEN;
if (!token) {
  console.error("Set STOAT_TOKEN in .env");
  process.exit(1);
}

const { ws } = (await (await fetch("https://api.stoat.chat/")).json()) as { ws: string };
const SKIP = new Set(["Authenticated", "Ping", "Pong"]);
const frames: Frame[] = [];

function keep(frame: Frame): void {
  if (frame.type === "Bulk") for (const inner of frame.v ?? []) keep(inner);
  else if (frame.type === "Error") {
    console.error("Gateway error:", JSON.stringify(frame));
    process.exit(1);
  } else if (!SKIP.has(frame.type)) {
    frames.push(frame);
    console.log(`  got ${frame.type}`);
  }
}

const socket = new WebSocket(`${ws}?version=1&format=json`);
socket.onopen = () => socket.send(JSON.stringify({ type: "Authenticate", token }));
socket.onmessage = (ev) => keep(JSON.parse(String(ev.data)) as Frame);
const ping = setInterval(() => socket.send(JSON.stringify({ type: "Ping", data: Date.now() })), 20_000);
console.log("Recording: send a message, edit it, then delete it in your test server. Ctrl+C (or 60s) to save.");

let saved = false;
async function save(): Promise<void> {
  if (saved) return;
  saved = true;
  clearInterval(ping);
  socket.close();
  const out = new URL("../test/fixtures/session.json", import.meta.url);
  await mkdir(new URL(".", out), { recursive: true });
  await writeFile(out, JSON.stringify(frames, null, 2) + "\n");
  console.log(`Saved ${frames.length} frames to test/fixtures/session.json`);
  process.exit(0);
}
process.on("SIGINT", () => void save());
setTimeout(() => void save(), 60_000);
