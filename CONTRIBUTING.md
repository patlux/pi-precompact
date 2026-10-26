# Contributing

## Setup and checks

Use Node.js 22.19+ and Python 3.11+. Git, npm, Make, and tar must be on `PATH`.
The lockfile pins development dependencies. Pi supplies the runtime SDK.

```sh
npm --prefix /Users/patwoz/dev/Personal/pi/pi-precompact ci --ignore-scripts
make -C /Users/patwoz/dev/Personal/pi/pi-precompact hooks-install
make -C /Users/patwoz/dev/Personal/pi/pi-precompact verify
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
There is no remote repository yet, so hosted CI has not run.
There is no automatic npm publication, OIDC, or release-token workflow.

To apply formatting:

```sh
npm --prefix /Users/patwoz/dev/Personal/pi/pi-precompact run format
```

Do not relax tests to accept an unsupported Pi version. Review the private native adapter before changing the exact SDK pin.
Runtime changes need applicable regression and integration tests. Pure tooling changes do not need live-provider calls or GUI tests.

## Changesets

This repository uses the Python changeset flow from TWS, Teams-GPUI, and Zugriff-Menu, not `@changesets/cli`.
Every non-merge, non-release commit adds one new Markdown changeset.
Write notes for changelog readers, not as copies of commit messages.

For documentation, tests, formatting, or internal tooling without a release note, add an explicit empty changeset.
Editing a note from an earlier commit does not count as a new changeset.
Do not bypass the hook.

Interactive entry:

```sh
make -C /Users/patwoz/dev/Personal/pi/pi-precompact changeset
```

Non-interactive entry:

```sh
python3 /Users/patwoz/dev/Personal/pi/pi-precompact/scripts/changeset.py add --type fixed --bump patch "Preserve newer messages after compaction."
python3 /Users/patwoz/dev/Personal/pi/pi-precompact/scripts/changeset.py add --empty
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
CI validates pending notes and tests hook behavior. Like the reference repositories, CI does not enforce changesets across all historical commits.

## Prepare a release

Prepare a version only after an explicit release request, from clean `main` with verified, committed changesets.
Use the changeset tool, not `npm version` or a manual version edit.

```sh
make -C /Users/patwoz/dev/Personal/pi/pi-precompact changeset-status
make -C /Users/patwoz/dev/Personal/pi/pi-precompact version
make -C /Users/patwoz/dev/Personal/pi/pi-precompact verify
```

`make version` plans all outputs before writing. It:

1. Selects the highest pending SemVer bump.
2. Updates the version in the package manifest.
3. Updates the lockfile version and its root package version, without resolving dependencies.
4. Prepends a dated changelog section and removes all consumed changesets.

It does not run npm, commit, tag, push, install, or publish.
Review the diff. Commit only the generated release files, with a message such as `version bump to v0.1.1`.
Feature branches keep their notes until merge. They do not prepare releases.

### Publication is separate

The package remains `private: true` and version `0.1.0` until you request and prepare publication.
The initial changelog section records a local development baseline, not an npm release.
The tooling adoption uses an empty changeset because it does not change plugin behavior.

Before the first requested publication, review these fields in a normal changeset-bearing commit:

- The actual repository URL, homepage, and issue URL after a remote exists.
- `private: false`.
- `publishConfig` with public access and `https://registry.npmjs.org/` as the registry.
- A real release note for the intended release.

Then prepare and commit the version. Run the read-only publication gate:

```sh
npm --prefix /Users/patwoz/dev/Personal/pi/pi-precompact run release:check
```

It requires clean `main`, synchronized versions, no pending notes, and an exact changeset-generated release at `HEAD`.
It also checks publication metadata and runs the normal checks.
`prepublishOnly` runs this gate. The command never publishes anything.

For an authorized publication, use the browser-free local npm procedure through `kp-agent`.
Require green CI for the exact release commit after hosting exists.
Verify the registry version and package load after publication. Pushes, tags, and hosted releases remain separate authorized operations.

## Reference choices

The small Pi plugins supplied the package shape: source exports, explicit Pi resources, host peer dependencies, narrow tarball contents, and CI checks.
Pi Dynamic Workflows supplied the Biome and pre-publication verification pattern.
This repository does not copy automatic publishing workflows from existing plugins.

The changeset implementation derives from these reviewed local sources:

- `/Users/patwoz/dev/Personal/thirdparty/tws/scripts/changeset.py` at `2c0cf40e4e0ae9177dc98b36be89402305fa7978`.
- `/Users/patwoz/dev/Personal/zugriff-menu/scripts/changeset.py` at `155b0c4e7e59f38bd89290bd82a20067b4101104`.
- `/Users/patwoz/dev/Personal/thirdparty/teams-gpui/CONTRIBUTING.md` and its Python-aware hook at `d5055564033c1b3872c1537a0e6113b8e626ef11`.

The TWS and Zugriff scripts differ only in their introductory description at those revisions.
The source checkout retains the TWS MIT notice in `/Users/patwoz/dev/Personal/pi/pi-precompact/scripts/LICENSE.tws`.
This adaptation replaces Cargo version handling with single-package npm version handling.
It does not copy Teams-GPUI's backlog exemption, Nix fallback, or application installation steps.
