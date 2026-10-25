# pi-background-compaction

This is an experimental Pi 1.4.0 extension.

- Keep the foreground agent uninterrupted. Never call `ctx.abort()`, force compaction, or inject continuation messages.
- Let native `session_before_compact` own the commit boundary. Fall back to Pi when validation fails.
- Reuse canonical preparation, projection, and summarization. Do not copy their algorithms.
- Keep the private API access isolated and version-guarded.
- Preserve native retained messages, attachments, context edits, and nested file metadata.
- Use in-memory test credentials and local scripted providers. Do not use personal sessions or live credentials for tests.
- Run `npm --prefix /Users/patwoz/dev/Personal/pi/pi-background-compaction run check` before committing.
- Do not install, publish, or activate this plugin in running sessions without a separate request.
