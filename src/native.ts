import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type compact,
  getPackageDir,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  VERSION,
} from "@earendil-works/pi-coding-agent";

export type Preparation = SessionBeforeCompactEvent["preparation"];
export type CompactionSettings = Preparation["settings"];

export interface NativeCompaction {
  prepareCompaction(entries: SessionEntry[], settings: CompactionSettings): Preparation | undefined;
  compact: typeof compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNativeCompaction(value: unknown): value is NativeCompaction {
  return (
    isRecord(value) && typeof value.prepareCompaction === "function" && typeof value.compact === "function"
  );
}

/** The one private API dependency. Never ship a copied preparation algorithm. */
export async function loadNativeCompaction(
  root = getPackageDir(),
  version = VERSION,
): Promise<NativeCompaction> {
  if (version !== "1.4.0") throw new Error("Precompact requires Pi 1.4.0");
  const metadata: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (
    !isRecord(metadata) ||
    metadata.name !== "@earendil-works/pi-coding-agent" ||
    metadata.version !== version
  ) {
    throw new Error("Pi package and runtime versions do not match");
  }
  const module: unknown = await import(pathToFileURL(join(root, "dist/core/compaction/compaction.js")).href);
  if (!isNativeCompaction(module)) throw new Error("Pi native compaction API is unavailable");
  return module;
}
