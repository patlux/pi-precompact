import { createHash } from "node:crypto";
import {
  buildSessionProjection,
  type CompactionResult,
  estimateTokens,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Preparation } from "./native.ts";

export interface Snapshot {
  sessionId: string;
  identity: string;
  entryCount: number;
  branchHash: string;
  preparation: Preparation;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function snapshotValid(
  snapshot: Snapshot,
  sessionId: string,
  identity: string,
  branch: SessionEntry[],
): boolean {
  if (
    sessionId !== snapshot.sessionId ||
    identity !== snapshot.identity ||
    branch.length < snapshot.entryCount
  )
    return false;
  if (fingerprint(branch.slice(0, snapshot.entryCount)) !== snapshot.branchHash) return false;
  // Even an edit to a retained entry can change a split-turn summary. Fail closed.
  return !branch
    .slice(snapshot.entryCount)
    .some(
      (entry) =>
        entry.type === "context_edit" ||
        entry.type === "compaction" ||
        entry.type === "branch_summary" ||
        entry.type === "model_change",
    );
}

/** Preview exactly the entry Pi will append, preserving native messages and attachments. */
export function validateResult(
  snapshot: Snapshot,
  result: CompactionResult,
  branch: SessionEntry[],
  contextWindow: number,
  tokensBefore: number,
): CompactionResult | undefined {
  if (!result.summary.trim() || result.firstKeptEntryId !== snapshot.preparation.firstKeptEntryId) return;
  if (!branch.some((entry) => entry.id === result.firstKeptEntryId)) return;
  const ceiling = contextWindow - snapshot.preparation.settings.reserveTokens;
  const tailLimit = Math.min(
    Math.max(2 * snapshot.preparation.settings.keepRecentTokens, 30_000),
    ceiling / 4,
  );
  const addedIds = new Set(branch.slice(snapshot.entryCount).map((entry) => entry.id));
  const growth = buildSessionProjection(branch)
    .entries.filter((entry) => addedIds.has(entry.sourceEntry.id))
    .flatMap((entry) => entry.messages)
    .reduce((sum, message) => sum + estimateTokens(message), 0);
  if (growth > tailLimit) return;
  const preview = SessionManager.inMemory(undefined, undefined, structuredClone(branch));
  preview.appendCompaction(result.summary, result.firstKeptEntryId, tokensBefore, result.details, true);
  const estimatedTokensAfter = preview
    .buildSessionProjection()
    .messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  // Token estimates are heuristic. Leave extra room in addition to Pi's native reserve.
  if (
    !Number.isFinite(estimatedTokensAfter) ||
    estimatedTokensAfter * 1.15 >= ceiling ||
    estimatedTokensAfter >= tokensBefore
  )
    return;
  return { ...result, tokensBefore, estimatedTokensAfter };
}
