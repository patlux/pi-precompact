import { getLatestCompactionEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Preparation } from "./native.ts";

export function isFileDetails(value: unknown): value is { readFiles: string[]; modifiedFiles: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "readFiles" in value &&
    Array.isArray(value.readFiles) &&
    value.readFiles.every((file) => typeof file === "string") &&
    "modifiedFiles" in value &&
    Array.isArray(value.modifiedFiles) &&
    value.modifiedFiles.every((file) => typeof file === "string")
  );
}

/** Pi 1.2 to 1.4 do not inherit file details from fromHook entries, even native-shaped ones. */
export function inheritOwnFiles(preparation: Preparation, branch: SessionEntry[]): void {
  const previous = getLatestCompactionEntry(branch);
  const details: unknown = previous?.details;
  if (!isFileDetails(details) || !("precompact" in details) || details.precompact !== 1) return;
  for (const file of details.readFiles) preparation.fileOps.read.add(file);
  for (const file of details.modifiedFiles) preparation.fileOps.edited.add(file);
}
