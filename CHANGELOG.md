# Changelog

Versions follow SemVer. Future entries come from Markdown changesets.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the release workflow.

## 0.1.0 - 2026-10-25

Local development baseline, not an npm publication.

### Added

- Prepare native Pi 1.4.0 compaction summaries in the background without interrupting the agent.
- Apply valid summaries only at native threshold compaction, with cancellation, context validation, and foreground fallback.
