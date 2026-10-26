# pi-background-compaction

An experimental Pi extension that prepares compaction summaries while the agent continues its work.
Pi still decides when to compact. The extension supplies a valid prepared summary at that boundary, or leaves the request to Pi.

Inspired by [OpenCode background compaction](https://github.com/anomalyco/opencode/pull/57444).
This is an independent implementation, not an OpenCode port.

## Status

- Targets `@earendil-works/pi-coding-agent` **1.4.0** only.
- Uses Pi's native context projection, preparation, and summary generator.
- Does not abort the agent or inject a `continue` message.
- Does not install itself, change settings, or run a background process.
- Has deterministic unit tests and SDK integration tests with Pi's local Faux provider.
- Has no live-provider endurance or latency benchmark yet.

## Try it in one session

Start a separate Pi session with the explicit extension path:

```sh
pi --extension /Users/patwoz/dev/Personal/pi/pi-background-compaction/src/index.ts
```

The extension becomes active when that session starts. It does not change existing sessions.
Do not combine it with another extension that replaces compaction.

Commands:

```text
/background-compaction status
/background-compaction off
/background-compaction on
/background-compaction reset
```

These commands affect only the current session. `reset` cancels the prepared job and clears the failure counter.

`/background-compaction` and `/background-compaction status` open a status card in the TUI, in place of the editor.
The card appears only on this explicit request. It shows the state and last event, a context bar with the plugin's start and Pi's threshold,
the expected result of a held summary, the request usage, and the failure count. It updates every second.
Press `r` to reset, `o` to switch off or on, and Escape or Enter to close. RPC, JSON, and print modes keep the one-line answer.

When Pi adopts a background summary, the TUI and RPC clients receive one notice, for example:

```text
✓ Background summary applied · no wait · 249k → ~38k tokens · prepared in 48s
```

`waited 12s` replaces `no wait` when Pi had to wait for a running request. The token value after `→` is Pi's estimate.
Native fallback compactions produce no notice.

The plugin sets one footer status from session start, `bg compact: <state>`:

| State | Meaning |
| --- | --- |
| `idle` | Enabled; no summary is in progress. |
| `running` | Preparing a summary while the agent continues. |
| `ready` | Holding a summary until Pi requests threshold compaction. |
| `paused` | Two background requests failed; native compaction remains available. |
| `off` | Disabled for this session, or native auto-compaction is disabled. |
| `unavailable` | Unsupported Pi installation, virtual model, or no model selected. |

In Pi's built-in TUI footer, the plugin moves this status from the status row into the statistics line.
Pi's own context segment stays exactly as Pi renders it. From 100 columns, a context bar comes before it:

```text
━━━━━━━━━━━━━━━━━━━│━━━─│─ 91.6%/272k (auto) → ~14%
```

- The accent mark is where background preparation starts. The error mark is where Pi compacts.
- The fill uses the state colour: `running` accent, `ready` success, `paused` warning, the others muted or dim.
- `→ ~14%` follows while a summary is ready: the estimated context after Pi adopts it.
- `✓ bg` follows directly after an adopted summary, until the next change.
- `bg running`, `bg ready` (without an estimate), `bg paused`, `bg off`, and `bg unavailable` name the other states.

Below 100 columns the line shows `91.6%/272k (auto) bg: ready` instead. When even that does not fit,
or the footer has an unknown layout, Pi's status row keeps `bg compact: <state>`.

Use `/background-compaction status` for the last event and failure count.
Pi's `(auto)` context indicator refers to native automatic compaction, not this plugin.

Pi has no public API to place text inside its footer. A zero-row widget below the editor finds the one mounted
built-in `FooterComponent` and wraps the render method of that instance; the prototype stays untouched.
The plugin reads the instance's status provider read-only and never modifies shared statuses.
Other footer decorators can wrap the same instance before or after it; each keeps the other's lines.
Custom footers are left alone. Shutdown and reload restore Pi's method and clear this plugin's status only.
JSON, print, and RPC modes receive no terminal status or footer decoration.

To stop use permanently, remove its package declaration, or omit the extension argument if you loaded it only for one invocation.

## Scheduling

1. After a completed turn, resolve Pi's effective compaction settings for the current model.
2. Start one summary when context reaches 85% of the native compaction ceiling.
3. Require at least 64,000 measured input and cache tokens from the latest valid assistant response.
4. Keep the result in memory while the agent continues.
5. At native threshold compaction, validate the snapshot and await its result if necessary.
6. Return the prepared summary to Pi, or let Pi perform normal compaction.

The ceiling is `contextWindow - reserveTokens`. For a 200,000-token model with a 30,000-token reserve, background work starts at 144,500 tokens.
Pi's model overrides and adaptive reserves remain authoritative.
The extension does not start speculative work after the ceiling is already reached.

A job has a two-minute deadline from its start. Foreground waiting uses the remaining time, not a new two-minute timeout.
Two background failures pause speculative work until compaction or an explicit reset.
Manual compaction, custom instructions, and overflow recovery always use Pi's foreground path.

## Context safety

The summary uses the canonical `prepareCompaction()` and `compact()` functions from the running Pi installation.
There is no copied cut-point or projection algorithm.

The extension hashes the original branch and checks it again before applying a result.
It rejects changed models, settings, branch prefixes, context edits, and intervening compactions.
It also checks after a foreground wait, because session changes can race the request.
Session replacement, tree navigation, reload, model selection, and cancellation discard pending work.

Pi keeps the retained history as native messages. The extension does not convert recent tool output or attachments into truncated text.
New messages after the snapshot remain in that retained history. No catch-up summary call is necessary.
Pi can still make two native summary calls for a split turn.

Before acceptance, an in-memory `SessionManager` previews the real compaction entry, including replayed system state.
The estimated result must reduce context and fit below the native ceiling with a 15% estimate margin.
New history after the snapshot must also fit within `min(max(2 × keepRecentTokens, 30,000), ceiling / 4)`.
These checks use Pi's token estimates, not an exact provider tokenizer. Native overflow recovery remains the final safeguard.

Pi 1.4.0 skips inherited file metadata from all extension-generated compactions.
A narrow adapter preserves this extension's marked file lists in both background preparation and foreground fallback.
It leaves other extensions' details alone.

## Compatibility and limits

`prepareCompaction()` is not a public root export in Pi 1.4.0.
The adapter loads the installed distribution module after checking the runtime and package versions.
Unknown versions, mismatched installations, and binary installations without distribution modules leave the extension inactive.
Pi's normal compaction remains available.

Virtual routing models use native compaction only. This avoids speculative work against unresolved model limits.
Physical models use `ctx.modelRegistry.streamSimple()`, with the configured provider and request-time authentication.
The extension does not read credential files or resolve secrets itself.
Background requests do not use custom SDK `agent.streamFunction` overrides or request-transform hooks.

Background summaries consume provider quota, even when discarded. Requests can overlap with ordinary agent requests.
Accepted summaries carry their native usage into the compaction entry.
The extension records known discarded-result usage as a non-context `background-compaction.discarded` custom entry.
Pi does not include those custom entries in its built-in cost totals.

Partial failures and cancelled or late requests can incur costs without returning usage.
A provider that ignores abort can continue remote work after the local wait ends.

This extension follows Pi's summary prompt and cache policy. It does not implement OpenCode's prompt-cache optimization.
It reads persisted context, not temporary `context` or `context_with_system` hook transformations.
Persistent omissions and replacements must use Pi's `context_edit` entries.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, Changesets, the commit hook, and the separate release procedure.
See [CHANGELOG.md](CHANGELOG.md) for the local development history.

Prerequisites: Node.js 22.19+, Python 3.11+, Git, npm, Make, and tar.

Install the locked development dependencies:

```sh
npm --prefix /Users/patwoz/dev/Personal/pi/pi-background-compaction ci --ignore-scripts
```

Install the changeset hook once per clone:

```sh
make -C /Users/patwoz/dev/Personal/pi/pi-background-compaction hooks-install
```

Run the same checks as CI:

```sh
npm --prefix /Users/patwoz/dev/Personal/pi/pi-background-compaction run check
```

This checks formatting, lint, types, runtime tests, the actual npm tarball, and the Changesets flow.
The CI definition covers Linux/macOS and Node.js 22/24. Hosted CI needs a remote and has not run yet.

Tests use temporary directories, in-memory credentials, in-memory sessions, and a local scripted provider.
They do not load personal extensions, read real credential files, or call a remote model.
The integration tests inject deterministic token usage through Pi's finalized-message hook.
They exercise real extension loading, provider streaming, tool-driven turns, threshold compaction, fallback, and shutdown.

Source:

- `/Users/patwoz/dev/Personal/pi/pi-background-compaction/src/index.ts`: lifecycle hooks and commands.
- `/Users/patwoz/dev/Personal/pi/pi-background-compaction/src/controller.ts`: job scheduling and cancellation.
- `/Users/patwoz/dev/Personal/pi/pi-background-compaction/src/native.ts`: version-guarded native adapter.
- `/Users/patwoz/dev/Personal/pi/pi-background-compaction/src/validation.ts`: branch validation and context preview.
- `/Users/patwoz/dev/Personal/pi/pi-background-compaction/src/files.ts`: file-metadata inheritance for Pi 1.4.0.
- `/Users/patwoz/dev/Personal/pi/pi-background-compaction/src/card.ts`: the status card for `/background-compaction status`.
- `/Users/patwoz/dev/Personal/pi/pi-background-compaction/src/footer.ts`: the context bar in Pi's built-in footer.
- `/Users/patwoz/dev/Personal/pi/pi-background-compaction/src/format.ts`: token, duration, and share formatting.

## Apply / deploy

No system deployment is necessary. The explicit `pi --extension` command above activates this plugin only in that new session.
The repository is local and unpublished. Global installation and Nix activation are separate operations.
