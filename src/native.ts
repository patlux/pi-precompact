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

/** The Pi releases that CI tests, as [first supported, first unsupported]. Patch releases count. */
const SUPPORTED: [number[], number[]] = [
  [1, 2, 0],
  [1, 5, 0],
];
export const SUPPORTED_PI = "1.2.0 up to 1.4.x";
/** Set to 1 to run on an untested Pi release at the user's own risk. */
export const UNTESTED_PI_ENV = "PI_PRECOMPACT_ALLOW_UNTESTED_PI";

const compareVersions = (a: number[], b: number[]) => a.reduce((result, part, i) => result || part - b[i], 0);

/** Whether a stable Pi release is in the tested range; prereleases are not. */
export function supportsPi(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  return compareVersions(parts, SUPPORTED[0]) >= 0 && compareVersions(parts, SUPPORTED[1]) < 0;
}

/** The one private API dependency. Never ship a copied preparation algorithm. */
export async function loadNativeCompaction(
  root = getPackageDir(),
  version = VERSION,
  allowUntested = process.env[UNTESTED_PI_ENV] === "1",
): Promise<NativeCompaction> {
  if (!supportsPi(version) && !allowUntested) {
    throw new Error(`Precompact supports Pi ${SUPPORTED_PI}, not ${version}`);
  }
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
