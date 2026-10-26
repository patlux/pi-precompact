# pi-precompact

This is an experimental Pi 1.4.0 extension.

- Keep the foreground agent uninterrupted. Never call `ctx.abort()`, force compaction, or inject continuation messages.
- Let native `session_before_compact` own the commit boundary. Fall back to Pi when validation fails.
- Reuse canonical preparation, projection, and summarization. Do not copy their algorithms.
- Keep the private API access isolated and version-guarded.
- Preserve native retained messages, attachments, context edits, and nested file metadata.
- Use in-memory test credentials and local scripted providers. Do not use personal sessions or live credentials for tests.
- Read `/Users/patwoz/dev/Personal/pi/pi-precompact/CONTRIBUTING.md` before changes.
- Every non-merge, non-release commit adds a new changeset. Internal tooling/docs/tests use an explicit empty note. Never bypass the hook.
- Run `npm --prefix /Users/patwoz/dev/Personal/pi/pi-precompact run check` before committing. This includes lint, types, runtime/package tests and Changesets tests.
- Prepare versions only through `make -C /Users/patwoz/dev/Personal/pi/pi-precompact version`, on clean main after an explicit release request. Never hand-bump versions.
- Commit generated release files separately. Version preparation never grants publication, tag, push, or installation permission.
- Do not install, publish, or activate this plugin in running sessions without a separate request.
