#!/usr/bin/env node
// Print the installed Pi package versions. With an expected version, fail unless all four match it.
//
//   node scripts/pi-versions.mjs [1.3.0]
import { readFileSync } from "node:fs";

const packages = ["pi-coding-agent", "pi-ai", "pi-tui", "pi-agent-core"];
const expected = process.argv[2];
let mismatch = false;
for (const name of packages) {
  // Read the file directly: the packages do not export ./package.json.
  const { version } = JSON.parse(readFileSync(`node_modules/@earendil-works/${name}/package.json`, "utf8"));
  const ok = !expected || version === expected;
  mismatch ||= !ok;
  console.log(`@earendil-works/${name} ${version}${ok ? "" : ` (expected ${expected})`}`);
}
if (mismatch) process.exit(1);
