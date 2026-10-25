import {
  buildSessionProjection,
  type CompactionResult,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { inheritOwnFiles, isFileDetails } from "./files.ts";
import type { NativeCompaction } from "./native.ts";
import { fingerprint, type Snapshot, snapshotValid, validateResult } from "./validation.ts";

export interface Options {
  startRatio: number;
  minimumTokens: number;
  timeoutMs: number;
}
export const DEFAULT_OPTIONS: Readonly<Options> = {
  startRatio: 0.85,
  minimumTokens: 64_000,
  timeoutMs: 120_000,
};
type State = "idle" | "running" | "ready" | "paused" | "disabled";
interface Job {
  snapshot: Snapshot;
  controller: AbortController;
  promise: Promise<CompactionResult | undefined>;
  result?: CompactionResult;
}

/** A bounded wait even if a provider does not settle its promise on abort. */
export async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let listener = () => {};
  const abort = new Promise<undefined>((resolve) => {
    listener = () => resolve(undefined);
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

export class BackgroundCompaction {
  private job?: Job;
  private failures = 0;
  private enabled = true;
  private last = "Waiting for enough context";
  private state: State = "idle";

  constructor(
    private readonly pi: Pick<ExtensionAPI, "getSettings" | "appendEntry">,
    private readonly native: NativeCompaction,
    private readonly options: Options = DEFAULT_OPTIONS,
  ) {
    if (
      !(options.startRatio > 0 && options.startRatio < 1) ||
      !Number.isFinite(options.minimumTokens) ||
      options.minimumTokens < 0 ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1
    )
      throw new Error("Invalid background compaction options");
  }

  status(): string {
    return `${this.enabled ? this.state : "disabled"}: ${this.last} (${this.failures}/2 failures)`;
  }

  setEnabled(enabled: boolean, ctx: ExtensionContext): void {
    this.enabled = enabled;
    this.reset(ctx, enabled ? "Enabled for this session" : "Disabled for this session");
  }

  reset(ctx: ExtensionContext, reason = "Session changed"): void {
    this.discard(ctx, reason);
    this.failures = 0;
    this.show(ctx, this.enabled ? "idle" : "disabled", reason);
  }

  private show(ctx: ExtensionContext, state: State, reason: string): void {
    this.state = state;
    this.last = reason;
    if (ctx.mode === "tui")
      ctx.ui.setStatus(
        "background-compaction",
        state === "running" || state === "ready" ? `compact: ${state}` : undefined,
      );
  }

  private identity(ctx: ExtensionContext): string {
    const settings = this.pi.getSettings();
    return fingerprint({
      model: ctx.model,
      compaction: settings.compaction,
      retry: settings.retry,
      thinking: ctx.thinkingLevel,
    });
  }

  private discard(ctx: ExtensionContext, reason: string): void {
    const job = this.job;
    this.job = undefined;
    job?.controller.abort();
    // Pi's public extension API has no usage-entry writer. Keep known discarded
    // usage auditable without putting it into the conversation or double counting.
    if (job?.result?.usage && job.snapshot.sessionId === ctx.sessionManager.getSessionId()) {
      this.pi.appendEntry("background-compaction.discarded", { reason, usage: job.result.usage });
    }
    this.show(ctx, this.failures >= 2 ? "paused" : "idle", reason);
  }

  private valid(job: Job, ctx: ExtensionContext): boolean {
    return snapshotValid(
      job.snapshot,
      ctx.sessionManager.getSessionId(),
      this.identity(ctx),
      ctx.sessionManager.getBranch(),
    );
  }

  /** Called from a persisted turn boundary. This method never awaits the provider. */
  consider(ctx: ExtensionContext): void {
    if (!this.enabled) return;
    const settingsManager = SettingsManager.inMemory(this.pi.getSettings());
    const model = ctx.model;
    const settings = settingsManager.getCompactionSettings(model);
    if (!settings.enabled || !model || model.api === "pi-virtual") {
      this.discard(ctx, "Native compaction disabled or model unsupported");
      return;
    }
    if (this.job && !this.valid(this.job, ctx)) this.discard(ctx, "Snapshot invalidated");
    if (this.job || this.failures >= 2) return;
    const usage = ctx.getContextUsage();
    const ceiling = model.contextWindow - settings.reserveTokens;
    if (
      !usage ||
      usage.tokens === null ||
      !Number.isFinite(usage.tokens) ||
      usage.tokens < ceiling * this.options.startRatio ||
      usage.tokens >= ceiling
    )
      return;
    const branch = ctx.sessionManager.getBranch();
    const measured = buildSessionProjection(branch).messages.findLast(
      (message) =>
        message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted",
    );
    if (
      measured?.role !== "assistant" ||
      measured.usage.input + measured.usage.cacheRead + measured.usage.cacheWrite < this.options.minimumTokens
    )
      return;
    const preparation = this.native.prepareCompaction(branch, settings);
    if (!preparation) return;
    inheritOwnFiles(preparation, branch);
    const snapshot: Snapshot = {
      sessionId: ctx.sessionManager.getSessionId(),
      identity: this.identity(ctx),
      entryCount: branch.length,
      branchHash: fingerprint(branch),
      preparation: structuredClone(preparation),
    };
    const controller = new AbortController();
    const job: Job = { snapshot, controller, promise: Promise.resolve(undefined) };
    this.job = job;
    this.show(ctx, "running", "Preparing a native summary");
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timeout.unref();
    // Defer invocation so a synchronous provider error is handled identically.
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return this.native.compact(
        snapshot.preparation,
        model,
        undefined,
        undefined,
        undefined,
        controller.signal,
        ctx.thinkingLevel,
        (requestModel, context, options) => ctx.modelRegistry.streamSimple(requestModel, context, options),
        undefined,
        settingsManager.getRetrySettings(),
      );
    });
    job.promise = untilAborted(work, controller.signal)
      .catch(() => undefined) // Never copy provider errors (possibly sensitive) into status or session data.
      .then((result) => {
        if (this.job !== job) return undefined;
        if (!result) {
          this.job = undefined;
          this.failures++;
          this.show(
            ctx,
            this.failures >= 2 ? "paused" : "idle",
            "Background request failed or timed out; native fallback remains active",
          );
          return undefined;
        }
        job.result = result;
        this.show(ctx, "ready", "Summary held until native threshold compaction");
        return result;
      })
      .finally(() => clearTimeout(timeout));
  }

  async beforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<SessionBeforeCompactResult | undefined> {
    const job = this.job;
    if (!job) return undefined;
    if (
      !this.enabled ||
      event.reason !== "threshold" ||
      event.customInstructions !== undefined ||
      fingerprint(event.preparation.settings) !== fingerprint(job.snapshot.preparation.settings) ||
      !this.valid(job, ctx)
    ) {
      this.discard(ctx, "Using native compaction for this request");
      return undefined;
    }
    const abort = () => this.discard(ctx, "Foreground compaction cancelled");
    if (event.signal.aborted) {
      abort();
      return undefined;
    }
    event.signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await job.promise;
      // Revalidate after awaiting: edits, switches, and model changes may race it.
      if (event.signal.aborted || this.job !== job || !result) return undefined;
      if (!this.valid(job, ctx)) {
        this.discard(ctx, "Snapshot changed while waiting");
        return undefined;
      }
      const accepted = validateResult(
        job.snapshot,
        result,
        ctx.sessionManager.getBranch(),
        ctx.model?.contextWindow ?? 0,
        event.preparation.tokensBefore,
      );
      if (!accepted) {
        this.discard(ctx, "Summary or retained tail exceeds the safe budget");
        return undefined;
      }
      this.job = undefined;
      this.show(ctx, "idle", "Prepared summary supplied to Pi");
      return {
        compaction: {
          ...accepted,
          details: isFileDetails(accepted.details)
            ? { ...accepted.details, backgroundCompaction: 1 }
            : accepted.details,
        },
      };
    } finally {
      event.signal.removeEventListener("abort", abort);
    }
  }
}
