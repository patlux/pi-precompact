import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { assistant, beforeEvent, fixture, flush } from "./helpers.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function packedFiles(value: unknown): { filename: string; paths: string[] } {
  assert.ok(Array.isArray(value) && value.length === 1);
  const pack: unknown = value[0];
  assert.ok(isRecord(pack) && typeof pack.filename === "string" && Array.isArray(pack.files));
  const paths = pack.files.map((file: unknown) => {
    assert.ok(isRecord(file) && typeof file.path === "string");
    return file.path;
  });
  assert.match(pack.filename, /^pi-background-compaction-\d+\.\d+\.\d+\.tgz$/);
  return { filename: pack.filename, paths };
}

test("actual npm tarball has only runtime files and loads without packaged dev dependencies", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "pi-background-package-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  // A local pack only: no registry queries, installation, or lifecycle scripts.
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  const packed = packedFiles(JSON.parse(output));
  assert.deepEqual(packed.paths.sort(), [
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "package.json",
    "src/card.ts",
    "src/controller.ts",
    "src/files.ts",
    "src/format.ts",
    "src/index.ts",
    "src/native.ts",
    "src/validation.ts",
  ]);
  execFileSync("tar", ["-xzf", join(temp, packed.filename), "-C", temp], { timeout: 10_000 });
  const manifest: unknown = JSON.parse(await readFile(join(temp, "package/package.json"), "utf8"));
  assert.ok(isRecord(manifest));
  assert.equal(manifest.name, "pi-background-compaction");
  assert.deepEqual(manifest.pi, { extensions: ["./src/index.ts"] });
  assert.deepEqual(manifest.exports, { ".": "./src/index.ts" });
  assert.deepEqual(manifest.peerDependencies, {
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@earendil-works/pi-tui": "1.4.0",
  });
  assert.equal(manifest.dependencies, undefined);
  const f = await fixture([], [join(temp, "package/src/index.ts")]);
  t.after(() => f.close());
  f.provider.setResponses([fauxAssistantMessage("Packed checkpoint")]);
  const branch = f.manager.getBranch();
  const last = branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(last?.type === "message");
  await f.session.extensionRunner.emitBoundary(
    {
      type: "turn_end",
      turnIndex: 0,
      message: assistant("Recent answer"),
      toolResults: [],
      messageEntryId: last.id,
      toolResultEntryIds: [],
      outcome: "completed",
    },
    () => ({
      contextEntries: f.manager.buildSessionProjection().entries,
      contextMessages: f.manager.buildSessionContext().messages,
      llmMessages: [],
      pendingMessages: [],
      canContinue: false,
    }),
  );
  await flush();
  const accepted = await f.session.extensionRunner.emit(beforeEvent(f.ctx));
  assert.ok(accepted?.compaction);
  assert.match(accepted.compaction.summary, /Packed checkpoint/);
  assert.equal(f.provider.state.callCount, 1);
  assert.deepEqual(f.errors, []);
});
