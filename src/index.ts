import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BackgroundCompaction } from "./controller.ts";
import { inheritOwnFiles } from "./files.ts";
import { loadNativeCompaction } from "./native.ts";

export default function backgroundCompaction(pi: ExtensionAPI): void {
  let controller: BackgroundCompaction | undefined;
  let unavailable = "Not started";
  pi.on("session_start", async (_event, ctx) => {
    try {
      controller = new BackgroundCompaction(pi, await loadNativeCompaction());
    } catch {
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
  pi.on("session_compact", (_event, ctx) => controller?.reset(ctx, "Compaction completed"));
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
      ctx.ui.notify(controller.status(), "info");
    },
  });
}
