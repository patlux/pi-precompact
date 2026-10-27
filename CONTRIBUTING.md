# Contributing

## Setup and checks

Use Node.js 22.19+ and Python 3.11+. Git, npm, Make, and tar must be on `PATH`.
The lockfile pins development dependencies. Pi supplies the runtime SDK.
Run all commands from the repository root.

```sh
npm ci --ignore-scripts
make hooks-install
make verify
```

`make verify` and CI run the same checks:

- Biome formatting, import order, and recommended lint rules.
- Strict TypeScript checks.
- Unit tests and Pi SDK integration tests with a local scripted provider.
- A real npm tarball check, including loading the extracted extension without packaged development dependencies.
- Changeset parser, Git hook, and release tests in disposable repositories.
- Pending changeset and manifest/lockfile validation.

The CI definition covers Linux and macOS with Node.js 22 and 24.
It needs no provider credentials and has read-only GitHub permissions.
There is no automatic npm publication, OIDC, or release-token workflow.

To apply formatting:

```sh
npm run format
```

Do not relax tests to accept an unsupported Pi version. To support a new Pi release, review the private native adapter,
run the full tests against that release, then widen `SUPPORTED` in `src/native.ts`, the peer ranges, and the `pi-versions`
CI matrix together. The daily `Newest Pi` workflow shows when a new release passes or breaks the tests.
Runtime changes need applicable regression and integration tests. Pure tooling changes do not need live-provider calls or GUI tests.

## Changesets

This repository uses a small Python changeset flow, not `@changesets/cli`.
Every non-merge, non-release commit adds one new Markdown changeset.
Write notes for changelog readers, not as copies of commit messages.

For documentation, tests, formatting, or internal tooling without a release note, add an explicit empty changeset.
Editing a note from an earlier commit does not count as a new changeset.
Do not bypass the hook.

Interactive entry:

```sh
make changeset
```

Non-interactive entry:

```sh
python3 scripts/changeset.py add --type fixed --bump patch "Preserve newer messages after compaction."
python3 scripts/changeset.py add --empty
```

Stage the generated file with the change it describes. Example note:

```markdown
---
type: fixed
bump: patch
---

Preserve newer messages after compaction.
```

| Field | Values |
| --- | --- |
| `type` | `added`, `changed`, `fixed`, `removed` |
| `bump` | `patch`, `minor`, `major` |

The highest pending bump wins. Bumps do not add together.
Only stable `X.Y.Z` versions are supported. There is no special 0.x rule.

An empty changeset contains two `---` lines. It generates no note or version bump.
The next release with real notes consumes pending empty changesets too.

Keep related unpublished notes consistent. Do not rewrite published changelog history.
A changeset is neither release authorization nor evidence of acceptance.

### Hook behavior

Install the hook once per clone with `make hooks-install`.
The installer preserves existing hooks and `core.hooksPath`. Integrate `check-staged` into an existing hook manager instead.

The hook locates Python 3.11+ on `PATH`. It does not install Python or activate Nix.

The hook checks staged content, not unstaged edits:

- Merge commits use notes from the merged branches. Staged notes still need valid syntax.
- Amend checks use the commit's parent, so the original note counts.
- Release commits must exactly match the generated manifest, lockfile, changelog, and consumed notes.

The hook rejects hand-edited version bumps, mismatched lockfile versions, and unrelated changes in release commits.
CI validates pending notes and tests hook behavior. It does not enforce changesets across all historical commits.

## Prepare a release

Prepare a version only after an explicit release request, from clean `main` with verified, committed changesets.
Use the changeset tool, not `npm version` or a manual version edit.

```sh
make changeset-status
make version
make verify
```

`make version` plans all outputs before writing. It:

1. Selects the highest pending SemVer bump.
2. Updates the version in the package manifest.
3. Updates the lockfile version and its root package version, without resolving dependencies.
4. Prepends a dated changelog section and removes all consumed changesets.

It does not run npm, commit, tag, push, install, or publish.
Review the diff. Commit only the generated release files, with a message such as `version bump to v0.1.1`.
Feature branches keep their notes until merge. They do not prepare releases.

### Publish a release

A maintainer publishes each release by hand from a local machine, with npm two-factor authentication.

1. Prepare the version with `make version` and commit only the generated release files.
2. Push `main` and wait for green CI on that exact release commit.
3. Run the read-only publication gate:

   ```sh
   npm run release:check
   ```

   It requires clean `main`, synchronized versions, no pending notes, and an exact changeset-generated release at `HEAD`.
   It also checks the publication metadata and runs the normal checks. `prepublishOnly` runs the same gate.
4. Run `npm publish --provenance=false`. A local release has no npm provenance.
5. Check the exact version on the registry, and install it with `pi install npm:pi-precompact@<version>` in a clean Pi home.
6. Tag the release commit as `v<version>`, push the tag, and create the GitHub release from the changelog section.

Do not republish a version that the registry already accepted. Repair only the missing tag or release.

## Reference choices

The small Pi plugins supplied the package shape: source exports, explicit Pi resources, host peer dependencies, narrow tarball contents, and CI checks.
Pi Dynamic Workflows supplied the Biome and pre-publication verification pattern.
This repository does not copy automatic publishing workflows from existing plugins.

The changeset tool adapts the author's changeset scripts from the TWS, Zugriff-Menu, and Teams-GPUI projects.
`scripts/LICENSE.tws` keeps the TWS MIT notice.
This adaptation replaces Cargo version handling with single-package npm version handling.
It does not copy Teams-GPUI's backlog exemption, Nix fallback, or application installation steps.
