## What this changes

<!-- One or two sentences. The diff says how; say why. -->

## Checklist

- [ ] `node --test` passes
- [ ] No new runtime dependency (this package has zero, by design)
- [ ] No `process.env` / `process.platform` / `os.homedir()` / `Date.now()` /
      `node:child_process` outside `src/ctx.js`
- [ ] Every new user-facing string goes through `ctx.t()` and exists in **both**
      locales in `src/i18n.js`
- [ ] Nothing writes to `~/.claude.json`, `~/.claude/.claude.json` or
      `~/.claude/.credentials.json`
- [ ] Tested on: <!-- Windows / macOS / Linux — say which -->
