import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  type CompactionResult,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionFactory,
  ModelRuntime,
  type SessionBeforeCompactEvent,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadNativeCompaction, type Preparation } from "../src/native.ts";

export const native = await loadNativeCompaction();

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export function assistant(text: string, tokens = 79_000) {
  const message = fauxAssistantMessage(text);
  return {
    ...message,
    provider: "test-background",
    model: "test",
    usage: { ...message.usage, input: tokens, totalTokens: tokens },
  };
}

export async function fixture(
  extensions: ExtensionFactory[] = [],
  additionalExtensionPaths: string[] = [],
  mode: ExtensionContext["mode"] = "json",
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-background-test-"));
  const provider = fauxProvider({
    provider: "test-background",
    api: "test-background",
    models: [{ id: "test", contextWindow: 100_000, maxTokens: 4096 }],
  });
  const model = provider.getModel();
  const settings = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      modelOverrides: { "test-background/test": { reserveTokens: 10_000, keepRecentTokens: 1_000 } },
    },
    retry: { enabled: false },
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(provider.provider);
  const manager = SessionManager.inMemory(dir);
  manager.appendMessage({ role: "user", content: `Old task ${"a".repeat(16_000)}`, timestamp: 1 });
  manager.appendMessage(assistant(`Old work ${"b".repeat(8_000)}`));
  manager.appendMessage({ role: "user", content: `Retain this request ${"c".repeat(4_000)}`, timestamp: 2 });
  manager.appendMessage(assistant("Recent answer"));
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Isolated test. No external tools.",
    extensionFactories: extensions,
    additionalExtensionPaths,
  });
  await loader.reload();
  const errors: string[] = [];
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: join(dir, "agent"),
    modelRuntime: runtime,
    model,
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    noTools: "builtin",
  });
  const statuses = new Map<string, string>();
  await session.bindExtensions({
    mode,
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      setStatus: (key, text) => {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
    },
    onError: (error) => errors.push(error.error),
  });
  const ctx = session.extensionRunner.createContext();
  const pi = {
    getSettings: () => settings.getSettings(),
    appendEntry: <T>(type: string, data?: T) => {
      manager.appendCustomEntry(type, data);
    },
  };
  return {
    dir,
    provider,
    model,
    settings,
    manager,
    session,
    ctx,
    pi,
    errors,
    statuses,
    async close() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function beforeEvent(
  ctx: ExtensionContext,
  reason: SessionBeforeCompactEvent["reason"] = "threshold",
  signal = new AbortController().signal,
): SessionBeforeCompactEvent {
  const preparation = native.prepareCompaction(ctx.sessionManager.getBranch(), {
    enabled: true,
    reserveTokens: 10_000,
    keepRecentTokens: 1_000,
  });
  if (!preparation) throw new Error("Fixture has no compactable history");
  return {
    type: "session_before_compact",
    reason,
    preparation,
    branchEntries: ctx.sessionManager.getBranch(),
    signal,
    willRetry: reason === "overflow",
  };
}

export function result(preparation: Preparation): CompactionResult {
  return {
    summary: "Checkpoint: old task and completed work.",
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { readFiles: [], modifiedFiles: [] },
  };
}
