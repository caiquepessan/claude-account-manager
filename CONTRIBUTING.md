# Contributing

Thanks for considering it. This is a small, deliberately boring codebase and the
constraints below are what keep it that way.

## Getting set up

```bash
git clone https://github.com/caiquepessan/claude-account-manager
cd claude-account-manager
node --test          # there is nothing to install — that is the point
```

Node 18.17 or newer. There is no build step, no bundler, and no `node_modules`.

To run your working copy against a real Claude Code install without touching your
own accounts, point the store somewhere disposable:

```bash
CAM_HOME=/tmp/cam-scratch node bin/cam.js ls
```

## The four rules

1. **Zero runtime dependencies.** Not one. `package.json` must never gain a
   `dependencies` block, and CI fails if it does. If you need a helper, write the
   twenty lines.
2. **Nothing outside `src/ctx.js` touches the outside world.** No `process.env`,
   `process.platform`, `process.stdout`, `os.homedir()`, `Date.now()` or
   `node:child_process` anywhere else — they all come from the injected `ctx`.
   This is what makes the whole program testable without a real HOME, and there
   is a test that enforces it.
3. **Every user-facing string goes through `ctx.t('some.key')`.** Add the key to
   **both** locales in `src/i18n.js`; a test asserts the two catalogues have an
   identical key set. Portuguese should read like a person wrote it, not like a
   translation.
4. **Never write to the user's real Claude Code files.** `~/.claude.json`,
   `~/.claude/.claude.json` and `~/.claude/.credentials.json` are read-only to
   this program, forever. The entire safety argument rests on that.

## Tests

- `test/pure.test.js` — pure functions and architectural invariants. No
  filesystem, no subprocess. Must pass on every supported Node and OS.
- `test/fs.test.js` — everything that touches disk or spawns a process, run
  inside a throwaway HOME with a fake `claude` binary. **No test may reach the
  real `~/.claude`.**

Two tests deserve particular care if you touch the code near them:

- The **purge guard** builds a symlink pointing outside the store and asserts
  that deleting a trashed profile unlinks it instead of following it. Following
  it would delete data in the user's real `~/.claude`. This is the worst bug this
  project can ship.
- The **seed allowlist** test adds an unknown key to a fixture config and asserts
  it is *not* copied into a new profile. Seeding must stay an allowlist; a
  denylist over a file written by a closed-source binary fails open.

Add a test with your change. `node --test` runs everything.

## Platform notes

macOS is verified at runtime rather than assumed: `cam add` first proves that two
config directories are genuinely isolated on your machine and refuses to create a
second account if they are not. The test suite cannot check that — it never
touches a real Keychain, and the `keychain` tests in `pure.test.js` only cover
the service-name derivation against a fake `ctx`. So the check that matters on
macOS only ever runs on someone's actual Mac.

If you have one, the genuinely useful contribution is the output of

```bash
CAM_HOME=/tmp/cam-scratch node bin/cam.js doctor --deep --json
```

filed as an issue, with your macOS version and how Claude Code was installed. The
`isolation` and `credentials` rows are the ones being verified. Please redact
paths you would rather not publish; the report contains no token material.

Windows behaviour worth knowing when reviewing: `rename` over an open file fails
with `EPERM` where POSIX succeeds (hence the retry loop), directory `fsync`
throws (hence the POSIX-only guard), and git-bash/mintty gives Node no TTY at all
(hence the numbered fallback picker).

## Commits and pull requests

Plain, descriptive commit messages. Say what changed and why; the diff already
says how. Small PRs get reviewed faster than large ones.

By contributing you agree your work is licensed under the MIT License.
