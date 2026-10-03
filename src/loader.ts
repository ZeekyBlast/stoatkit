import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Client, ClientEvents } from "./client.ts";
import type { ArgSpec } from "./commands/args.ts";
import type { Command } from "./commands/registry.ts";

/**
 * Marks a command file's default export. Use it so `args` types reach `run`:
 * a plain object in its own file loses them.
 */
export function defineCommand<const S extends ArgSpec>(command: Command<S>): Command<S> {
  return command;
}

/** One event listener in its own file. `run` gets the event's arguments, then the client. */
export interface EventDefinition<K extends keyof ClientEvents = keyof ClientEvents> {
  name: K;
  /** Run only the first time. */
  once?: boolean;
  run(...args: [...ClientEvents[K], client: Client]): unknown;
}

/** Marks an event file's default export, so `run`'s arguments are typed from the event name. */
export function defineEvent<K extends keyof ClientEvents>(event: EventDefinition<K>): EventDefinition<K> {
  return event;
}

/** What a load did, by path relative to the folder. A failure is also reported on the client's `error` event. */
export interface LoadResult {
  loaded: string[];
  failed: string[];
}

const CODE_FILE = /\.m?[jt]s$/;
const DECLARATION_FILE = /\.d\.m?ts$/;

/**
 * Every .js, .mjs, .ts or .mts file under `dir`, sorted, skipping declaration files and anything
 * whose name (or folder's name) starts with `_` or `.`. Put shared helpers in `_helpers.ts`.
 */
export async function findModuleFiles(dir: string | URL): Promise<Array<{ path: string; relative: string }>> {
  const root = typeof dir === "string" ? resolve(dir) : fileURLToPath(dir);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && CODE_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name))
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path, relative: relative(root, path).split(sep).join("/") };
    })
    .filter((file) => !file.relative.split("/").some((part) => part.startsWith("_") || part.startsWith(".")))
    .sort((a, b) => (a.relative < b.relative ? -1 : 1));
}

/** Imports each file and hands its default export to `use`. One bad file never stops the rest. */
export async function loadModules(
  dir: string | URL,
  use: (value: unknown, file: string) => void,
  report: (err: unknown) => void,
): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], failed: [] };
  for (const file of await findModuleFiles(dir)) {
    try {
      const module = (await import(pathToFileURL(file.path).href)) as { default?: unknown };
      use(module.default, file.relative);
      result.loaded.push(file.relative);
    } catch (err) {
      result.failed.push(file.relative);
      report(new Error(`Couldn't load ${file.relative}: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
    }
  }
  return result;
}

export function isCommand(value: unknown): value is Command {
  const v = value as Partial<Command> | null;
  return typeof v === "object" && v !== null && typeof v.name === "string" && typeof v.run === "function";
}

export function isEvent(value: unknown): value is EventDefinition {
  const v = value as Partial<EventDefinition> | null;
  return typeof v === "object" && v !== null && typeof v.name === "string" && typeof v.run === "function";
}
