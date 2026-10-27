# Changelog

Versions follow SemVer. Future entries come from Markdown changesets.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the release workflow.

## 0.3.0 - 2026-10-27

### Added

- Support Pi 1.2.0 up to 1.4.x instead of 1.4.0 only. CI tests every release in that range and the newest Pi every day. Other versions leave the extension inactive unless PI_PRECOMPACT_ALLOW_UNTESTED_PI=1 is set.

### Changed

- Record the README and gallery media with the official Pi 1.4.0 from npm instead of a locally patched build.

### Fixed

- Keep the context bar's fade-in running when Pi's context value changes during it, for example through a tool result right after the first response.
- Correct the threshold example in the README: Pi uses the configured reserve, 16,384 tokens by default. The 20% minimum named in 0.2.2 came from a locally patched Pi.

## 0.2.3 - 2026-10-27

### Changed

- Keep the README on the plugin: drop the notes about how its media were made.

## 0.2.2 - 2026-10-27

### Added

- Show a recorded Pi session, the footer states, the fade-in, and the status card in the README and the Pi gallery. Correct the threshold example: Pi 1.4.0 reserves at least 20% of the context window.

### Fixed

- Show the notice for an adopted background summary in the TUI. Pi rebuilt its chat right after the plugin added the notice, so the notice disappeared at once.

## 0.2.1 - 2026-10-27

### Fixed

- Remove an outdated sentence from the README.

## 0.2.0 - 2026-10-26

### Added

- Show the precompact state in the footer from session start, including idle, paused, off, and unavailable.
- Open a status card for /precompact status and announce adopted background summaries.
- Draw a context bar in Pi's built-in footer with the background start, Pi's threshold, the state, and the expected context after adoption; Pi's own context text stays unchanged.
- Show nothing in the footer before the first measured response, like Pi, then fade the context bar in once. PI_PRECOMPACT_MOTION=off shows it without animation.
- Publish the package on npm. Install it with `pi install npm:pi-precompact`.

### Changed

- Name the package pi-precompact, with the command /precompact and the motion variable PI_PRECOMPACT_MOTION.
- Show the footer short form as pre and Pi's status text as precompact: <state>.

## 0.1.0 - 2026-10-25

Local development baseline, not an npm publication.

### Added

- Prepare native Pi 1.4.0 compaction summaries in the background without interrupting the agent.
- Apply valid summaries only at native threshold compaction, with cancellation, context validation, and foreground fallback.
