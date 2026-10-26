import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { statusCard } from "./card.ts";
import { BackgroundCompaction } from "./controller.ts";
import { inheritOwnFiles } from "./files.ts";
import { attachFooter, STATUS_KEY } from "./footer.ts";
import { loadNativeCompaction } from "./native.ts";

export default function backgroundCompaction(pi: ExtensionAPI): void {
  let controller: BackgroundCompaction | undefined;
  let unavailable = "Not started";
  let detachFooter: (() => void) | undefined;
  pi.on("session_start", async (_event, ctx) => {
    detachFooter?.();
    detachFooter = undefined;
    try {
      const started = new BackgroundCompaction(pi, await loadNativeCompaction());
      controller = started;
      started.reset(ctx, "Waiting for enough context");
      // Draw the status beside Pi's context usage. Pi's status row stays the fallback.
      if (ctx.mode === "tui") detachFooter = attachFooter(ctx, () => started.footerState());
    } catch {
      controller = undefined;
      if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, "bg compact: unavailable");
      unavailable =
        "Unsupported Pi installation. Native compaction remains active; Pi 1.4.0 with dist modules is required.";
      if (ctx.hasUI) ctx.ui.notify(unavailable, "warning");
    }
  });
  pi.on("turn_end", (event, ctx) => {
    if (event.outcome !== "completed") {
      controller?.reset(ctx, "Turn aborted or failed");
      return;
    }
    // Other boundary extensions may be about to rewrite this context.
    if (event.entries.some((entry) => entry.type === "context_edit" || entry.type === "compaction")) {
      controller?.reset(ctx, "Another extension is changing the context");
      return;
    }
    controller?.consider(ctx);
  });
  pi.on("session_before_compact", async (event, ctx) => {
    // Also preserve our structured file lists when falling back to native compaction.
    inheritOwnFiles(event.preparation, event.branchEntries);
    return controller?.beforeCompact(event, ctx);
  });
  pi.on("session_compact", (event, ctx) => {
    const notice = controller?.compacted(event, ctx);
    if (notice && ctx.hasUI) ctx.ui.notify(notice, "info");
  });
  pi.on("session_compact_failed", (_event, ctx) =>
    controller?.reset(ctx, "Foreground compaction failed or cancelled"),
  );
  pi.on("model_select", (_event, ctx) => controller?.reset(ctx, "Model changed"));
  pi.on("thinking_level_select", (_event, ctx) => controller?.reset(ctx, "Thinking level changed"));
  pi.on("session_before_switch", (_event, ctx) => controller?.reset(ctx, "Session switching"));
  pi.on("session_before_fork", (_event, ctx) => controller?.reset(ctx, "Session forking"));
  pi.on("session_before_tree", (_event, ctx) => controller?.reset(ctx, "Tree navigation"));
  pi.on("session_shutdown", (_event, ctx) => {
    controller?.reset(ctx, "Session shutdown");
    controller = undefined;
    detachFooter?.();
    detachFooter = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted) controller?.reset(ctx, "Agent aborted");
  });
  pi.registerCommand("background-compaction", {
    description: "Background compaction: status, on, off, or reset (session only)",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (!controller) {
        ctx.ui.notify(unavailable, "warning");
        return;
      }
      if (action === "on" || action === "off") controller.setEnabled(action === "on", ctx);
      else if (action === "reset") controller.reset(ctx, "Manually reset");
      else if (action !== "status") {
        ctx.ui.notify("Usage: /background-compaction [status|on|off|reset]", "warning");
        return;
      }
      controller.refreshStatus(ctx);
      // The card appears only when the user explicitly asks for the status.
      if (action === "status" && ctx.mode === "tui") await showCard(controller, ctx);
      else ctx.ui.notify(controller.status(), "info");
    },
  });
}

async function showCard(controller: BackgroundCompaction, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
    statusCard(
      {
        details: () => controller.details(ctx),
        reset: () => controller.reset(ctx, "Manually reset"),
        setEnabled: (enabled) => controller.setEnabled(enabled, ctx),
      },
      tui,
      theme,
      keybindings,
      () => done(undefined),
    ),
  );
}
