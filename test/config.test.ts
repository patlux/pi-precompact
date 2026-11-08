import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, FOOTER_ENV, type LoadConfigOptions, loadConfig, MOTION_ENV } from "../src/config.ts";

async function layout(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "pi-precompact-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const global = join(agentDir, "extensions", "precompact.json");
  const project = join(cwd, CONFIG_DIR_NAME, "precompact.json");
  const write = async (path: string, text: string) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  const load = (options: Partial<LoadConfigOptions> = {}) =>
    loadConfig({ cwd, agentDir, projectTrusted: true, env: {}, ...options });
  return { global, project, write, load };
}

test("without files or environment the bar with motion is the default", async (t) => {
  const { load } = await layout(t);
  assert.deepEqual(await load(), { config: DEFAULT_CONFIG, paths: [], warnings: [] });
  assert.deepEqual(DEFAULT_CONFIG, { footer: "bar", motion: true });
});

test("the global file, then a trusted project file, then the environment", async (t) => {
  const { global, project, write, load } = await layout(t);
  await write(global, JSON.stringify({ footer: "underline", motion: false }));
  assert.deepEqual(await load(), {
    config: { footer: "underline", motion: false },
    paths: [global],
    warnings: [],
  });
  await write(project, JSON.stringify({ footer: "bar" }));
  const trusted = await load();
  assert.deepEqual(trusted.config, { footer: "bar", motion: false });
  assert.deepEqual(trusted.paths, [global, project]);
  const untrusted = await load({ projectTrusted: false });
  assert.deepEqual(
    untrusted.config,
    { footer: "underline", motion: false },
    "untrusted projects are ignored",
  );
  assert.deepEqual(untrusted.paths, [global]);
  const env = await load({ env: { [FOOTER_ENV]: " Underline ", [MOTION_ENV]: "on" } });
  assert.deepEqual(env.config, { footer: "underline", motion: true }, "the environment wins");
});

test("invalid values keep the previous value and explain why", async (t) => {
  const { global, project, write, load } = await layout(t);
  await write(global, JSON.stringify({ footer: "underline", motion: "no", colour: "red" }));
  await write(project, JSON.stringify({ footer: "dots" }));
  const loaded = await load({ env: { [FOOTER_ENV]: "thin", [MOTION_ENV]: "1" } });
  assert.deepEqual(loaded.config, { footer: "underline", motion: true });
  assert.deepEqual(loaded.warnings, [
    `${global}: unknown key "colour"`,
    `${global}: "motion" must be true or false`,
    `${project}: "footer" must be one of bar, short, block, text, underline`,
    `${FOOTER_ENV} must be one of bar, short, block, text, underline`,
    `${MOTION_ENV} must be on or off`,
  ]);
});

test("a broken or non-object file is skipped as a whole", async (t) => {
  const { global, project, write, load } = await layout(t);
  await write(global, "{ footer: underline");
  await write(project, JSON.stringify(["underline"]));
  const loaded = await load();
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  assert.deepEqual(loaded.paths, [project]);
  assert.equal(loaded.warnings.length, 2);
  assert.match(
    loaded.warnings[0] ?? "",
    new RegExp(`^Could not read ${global.replace(/[.\\/]/g, "\\$&")}: `),
  );
  assert.equal(loaded.warnings[1], `${project} must contain a JSON object`);
});
