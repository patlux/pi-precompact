import {
  buildSessionProjection,
  type CompactionResult,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type SessionCompactEvent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { inheritOwnFiles, isFileDetails } from "./files.ts";
import { formatDuration, formatTokens } from "./format.ts";
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
/** The state shown in the footer and the status card. */
export type Label = "idle" | "running" | "ready" | "paused" | "off" | "unavailable";
type Usage = NonNullable<CompactionResult["usage"]>;

/** `pi.events` channel for {@link FooterState}; the footer listens to it. */
export const STATE_CHANNEL = "background-compaction:state";
/** Emit on this channel to receive the last {@link FooterState} again. */
export const REQUEST_CHANNEL = "background-compaction:request";

/**
 * Versioned footer payload. Shares are fractions of the model's context window.
 * The plain `bg compact: <state>` status text stays the fallback for other footers.
 */
export interface FooterState {
  version: 1;
  state: Label;
  /** The last compaction used a background summary, and nothing happened since. */
  applied: boolean;
  /** Where background preparation starts. */
  start?: number;
  /** Where Pi compacts natively. */
  threshold?: number;
  /** Estimated context after Pi adopts the held summary (ready only). */
  after?: number;
}

export interface Applied {
  tokensBefore: number;
  tokensAfter: number;
  preparedMs: number;
  waitedMs: number;
  at: number;
  usage?: Usage;
}

/** Everything the status card shows. */
export interface StatusDetails {
  label: Label;
  reason: string;
  failures: number;
  enabled: boolean;
  context?: { tokens: number | null; window: number; percent: number | null };
  start?: number;
  threshold?: number;
  job?: { phase: "running" | "ready"; startedAt: number; readyAt?: number; estimate?: number; usage?: Usage };
  applied?: Applied;
}

interface Job {
  snapshot: Snapshot;
  controller: AbortController;
  promise: Promise<CompactionResult | undefined>;
  result?: CompactionResult;
  startedAt: number;
  readyAt?: number;
  /** Estimated context tokens after adoption, refreshed while the result is held. */
  estimate?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The single-line notice after Pi adopted a background summary. */
export function appliedNotice(applied: Applied): string {
  const wait = applied.waitedMs < 1000 ? "no wait" : `waited ${formatDuration(applied.waitedMs)}`;
  return `✓ Background summary applied · ${wait} · ${formatTokens(applied.tokensBefore)} → ~${formatTokens(applied.tokensAfter)} tokens · prepared in ${formatDuration(applied.preparedMs)}`;
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
  private pendingApplied?: Applied;
  private applied?: Applied;
  private showApplied = false;
  private footer?: FooterState;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "getSettings" | "appendEntry" | "events">,
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
    this.pendingApplied = undefined;
    this.discard(ctx, reason);
    this.failures = 0;
    this.show(ctx, this.enabled ? "idle" : "disabled", reason);
  }

  /**
   * Called on `session_compact`. Returns the notice when Pi adopted this plugin's summary.
   * The footer keeps the applied mark until the next state change.
   */
  compacted(event: SessionCompactEvent, ctx: ExtensionContext): string | undefined {
    const applied = this.pendingApplied;
    this.reset(ctx, "Compaction completed");
    const details = event.compactionEntry.details;
    if (!applied || !isRecord(details) || details.backgroundCompaction !== 1) return undefined;
    this.applied = applied;
    this.showApplied = true;
    this.last = "Prepared summary applied";
    this.refreshStatus(ctx);
    return appliedNotice(applied);
  }

  private show(ctx: ExtensionContext, state: State, reason: string): void {
    this.state = state;
    this.last = reason;
    this.showApplied = false;
    this.refreshStatus(ctx);
  }

  private label(ctx: ExtensionContext): Label {
    const settings = SettingsManager.inMemory(this.pi.getSettings()).getCompactionSettings(ctx.model);
    if (!this.enabled || !settings.enabled) return "off";
    if (!ctx.model || ctx.model.api === "pi-virtual") return "unavailable";
    return this.state === "disabled" ? "off" : this.state;
  }

  /** Start and native threshold as shares of the context window, when known. */
  private shares(ctx: ExtensionContext, label: Label): { start?: number; threshold?: number } {
    const model = ctx.model;
    if (!model || model.api === "pi-virtual" || !(model.contextWindow > 0)) return {};
    const settings = SettingsManager.inMemory(this.pi.getSettings()).getCompactionSettings(model);
    const ceiling = model.contextWindow - settings.reserveTokens;
    if (!settings.enabled || !(ceiling > 0)) return {};
    const threshold = ceiling / model.contextWindow;
    return label === "off" ? { threshold } : { start: threshold * this.options.startRatio, threshold };
  }

  refreshStatus(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const label = this.label(ctx);
    const footer: FooterState = {
      version: 1,
      state: label,
      applied: label === "idle" && this.showApplied,
      ...this.shares(ctx, label),
    };
    const window = ctx.model?.contextWindow ?? 0;
    if (label === "ready" && this.job?.estimate !== undefined && window > 0)
      footer.after = this.job.estimate / window;
    this.footer = footer;
    // Publish structured data first: setStatus triggers the render that reads it.
    this.pi.events.emit(STATE_CHANNEL, footer);
    ctx.ui.setStatus("background-compaction", `bg compact: ${label}`);
  }

  /** Answer a footer that subscribed after the last change. */
  republish(): void {
    if (this.footer) this.pi.events.emit(STATE_CHANNEL, this.footer);
  }

  details(ctx: ExtensionContext): StatusDetails {
    const label = this.label(ctx);
    const usage = ctx.getContextUsage();
    const job = this.job;
    return {
      label,
      reason: this.last,
      failures: this.failures,
      enabled: this.enabled,
      ...(usage
        ? { context: { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent } }
        : {}),
      ...this.shares(ctx, label),
      ...(job
        ? {
            job: {
              phase: job.result ? "ready" : "running",
              startedAt: job.startedAt,
              readyAt: job.readyAt,
              estimate: job.estimate,
              usage: job.result?.usage,
            },
          }
        : {}),
      ...(this.showApplied && this.applied ? { applied: this.applied } : {}),
    };
  }

  /** Preview the held result against the current branch. Undefined means Pi would reject it. */
  private estimate(job: Job, result: CompactionResult, ctx: ExtensionContext): number | undefined {
    try {
      const tokens = ctx.getContextUsage()?.tokens ?? job.snapshot.preparation.tokensBefore;
      return validateResult(
        job.snapshot,
        result,
        ctx.sessionManager.getBranch(),
        ctx.model?.contextWindow ?? 0,
        tokens,
      )?.estimatedTokensAfter;
    } catch {
      return undefined;
    }
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
    const held = this.job;
    if (held?.result) {
      // Newer history stays in the retained tail, so the expected result grows.
      const estimate = this.estimate(held, held.result, ctx);
      if (estimate !== held.estimate) {
        held.estimate = estimate;
        this.refreshStatus(ctx);
      }
    }
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
    const job: Job = { snapshot, controller, promise: Promise.resolve(undefined), startedAt: Date.now() };
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
        job.readyAt = Date.now();
        job.estimate = this.estimate(job, result, ctx);
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
    const waitStart = Date.now();
    try {
      const result = await job.promise;
      const waitedMs = Date.now() - waitStart;
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
      this.pendingApplied = {
        tokensBefore: event.preparation.tokensBefore,
        tokensAfter: accepted.estimatedTokensAfter ?? event.preparation.tokensBefore,
        preparedMs: (job.readyAt ?? Date.now()) - job.startedAt,
        waitedMs,
        at: Date.now(),
        usage: accepted.usage,
      };
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
