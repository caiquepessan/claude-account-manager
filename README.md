# Claude Account Manager (`cam`)

[![npm version](https://img.shields.io/npm/v/%40caiquepessan%2Fclaude-account-manager)](https://www.npmjs.com/package/@caiquepessan/claude-account-manager)
[![CI](https://github.com/caiquepessan/claude-account-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/caiquepessan/claude-account-manager/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40caiquepessan%2Fclaude-account-manager)](LICENSE)
[![node](https://img.shields.io/node/v/%40caiquepessan%2Fclaude-account-manager)](https://nodejs.org)

Pick which Claude account `claude` starts with.

Português: [README.pt-BR.md](README.pt-BR.md)

```
PS C:\proj\api> claude

╭──────────────────────────────────────────────────────────────────────╮
│ Claude Account Manager  0.1.0                    claude 2.1.252      │
│ ──────────────────────────────────────────────────────────────────── │
│   ○ default      you@gmail.com · max              your login      1  │
│ ▸ ● work         me@acme.io · team · Acme Inc     2h ago          2  │
│   ○ research     lab@uni.edu · pro                ! expires 4d    3  │
│                                                                      │
│   + Add account                       via claude auth login       a  │
│ ──────────────────────────────────────────────────────────────────── │
│ ↑↓ move · ↵ start · a add · q quit                                   │
╰──────────────────────────────────────────────────────────────────────╯

● = active (preselected)   ○ = idle   ▸ = cursor   ! = needs attention
```

Press `↵` and the box is erased; one line stays in your scrollback and the
real Claude Code takes the terminal:

```
PS C:\proj\api> claude
✓ work · me@acme.io · team

╭───────────────────────────────────────────╮
│ ✻ Welcome to Claude Code                  │
╰───────────────────────────────────────────╯
```

Pressing `2` does the same thing in one keystroke: a digit jumps to that row
and starts it. Row order is stable — `default` first, then creation order — so
the digits never move under your fingers.

> Not affiliated with, endorsed by, or sponsored by Anthropic.

## Why

Claude Code stores one login. If you have a personal account and a work
account, or one account per client, the only supported way to move between them
is to log out and log back in. That loses the session you were in, and it is
slow enough that people stop doing it and send the wrong prompt to the wrong
organisation instead.

`cam` gives each account its own directory and lets you choose one at launch.
Nothing is logged out. Nothing is copied between accounts. The account you have
right now keeps working exactly as it does today, under the name `default`.

## Install

```sh
npm i -g @caiquepessan/claude-account-manager
```

This installs two commands, `cam` and the longer alias
`claude-account-manager`. They are the same program.

Requirements: Node.js 18.17 or newer, and an existing Claude Code install.
`cam` has zero runtime dependencies — only Node built-ins.

Then, to make bare `claude` ask which account to use:

```sh
cam shell install
```

## Quick start

```sh
cam doctor         # check every assumption on this machine first
cam add            # sign in with a second account
cam shell install  # make bare `claude` ask
claude             # pick an account, then start Claude Code
```

`cam add` asks for a name, proves that two config directories really are
isolated on your machine, creates the folder, and then hands the terminal to
Claude Code's own `claude auth login`. `cam` never sees your password.

```
╭─ Add an account ─────────────────────────────────────────────────────╮
│ Name this account                                                    │
│   ›  client-acme▏                                                    │
│      a–z 0–9 . _ -  ·  max 32  ·  this becomes a folder name         │
╰──────────────────────────────────────────────────────────────────────╯
  ↵ continue · esc cancel

✓ Isolation check      a fresh config dir reports logged-out
✓ Folder               ~/.claude-account-manager/profiles/client-acme
✓ Seeded               onboarding, theme, folder trust, 3 MCP servers
✓ Shared               plugins, commands, agents, skills   (junction)
·  Not shared          conversation history and --resume sessions stay
                       private to each account, on purpose

───────────────────────── claude auth login ──────────────────────────
Login successful.
──────────────────────────────────────────────────────────────────────

✓ Signed in           billing@corp.example · Corp Ltd · team
✓ Saved as "client-acme"
```

If the login is cancelled or fails, the half-made profile is removed and
nothing else changes. Keep it for debugging with `cam add <name> --keep`.

## Commands

Everyday:

| Command | What it does |
| --- | --- |
| `cam add [name]` | Sign in with another account. Flags: `--console`, `--sso`, `--email <addr>`, `--no-share`, `--no-seed`, `--share-projects`, `--keep`. |
| `cam ls` | List your accounts, plans, orgs and token health. `--json` for machine output. Alias: `cam list`. |
| `cam use [name]` | Set the account bare `claude` uses. With no name and a terminal, it opens the picker. |
| `cam rm <name>` | Quarantine an account into `trash/`. `--yes` to skip the typed confirmation, `--purge` to delete instead of quarantine. |
| `cam shell install\|uninstall\|status` | Install, remove or inspect the `claude` shell hook. `--dry-run` prints the diff, `--shell <id>` limits it to one shell. |
| `cam doctor` | Check every assumption on this machine. `--deep` re-runs the isolation self-test, `--fix` applies the repairs marked safe, `--json` for machine output. |
| `cam help [command]` | Help. `--all` also lists the advanced commands. |

Advanced (`cam help --all`):

| Command | What it does |
| --- | --- |
| `cam launch [-- <args...>]` | Pick an account and start Claude Code. This is what the shell hook calls. |
| `cam which [-v]` | Show which account would be used right now, and why. `--json` for machine output. |
| `cam env <name>` | Print the environment for an account as shell statements. `--shell posix\|powershell\|fish\|cmd`. |
| `cam exec <name> -- <cmd...>` | Run any command under an account's environment. |
| `cam restore <name>` | Bring a quarantined account back. |
| `cam trash` | List the quarantine. `--empty` deletes it, `--yes` skips the confirmation. |
| `cam config [key] [value]` | Read or change the three settings: `ask` (`auto\|always\|never`), `claudeBin` (absolute path to the `claude` binary), `ascii` (`true\|false`). |

Global options: `--cam <name>`, `--keep-env`, `--ask <mode>`, `--json`,
`-y/--yes`, `-v/--verbose`, `--ascii`, `--no-color`, `--lang en|pt-BR`,
`-h/--help`, `--version`.

Exit codes are stable and documented in `cam help`:

```
0 OK   1 ERROR   2 USAGE   4 NOT_FOUND   5 CONFLICT
6 NO_ACCOUNTS   7 AUTH_FAILED   8 UNSAFE   127 NO_CLAUDE   130 CANCELLED
```

## Making `claude` ask

`cam shell install` writes a small managed block into your shell startup files.
It defines a function named `claude` that calls `cam launch` and then execs the
real `claude` binary — resolved as an executable, so the function never recurses
into itself. PowerShell, bash, zsh and fish are supported. `cmd.exe` is not: the
only way to hook it is an `AutoRun` registry key that affects every `cmd.exe` on
the machine, which is too invasive; use `cam env` or `cam exec` there instead.

The rule the hook follows is deliberately narrow:

```sh
claude                        # asks — no arguments, more than one account
claude -p "summarise" | jq    # does not ask; stdout stays byte-clean
claude --resume               # does not ask; resumes inside the active account
claude --cam research -c      # one-shot switch; claude never sees --cam
```

Anything you pass to `claude` means you already know what you want, so the
picker stays out of the way. IDE integrations, scripts and CI behave exactly as
they did before you installed `cam`. The menu is drawn on **stderr**, so a
piped stdout is unaffected.

Change the policy with `cam config ask always` (ask even with arguments) or
`cam config ask never` (never ask). `--ask <mode>` and `CAM_ASK` override it for
one run. `--cam` with no value forces the picker once.

Every key binding, and there are no others:

```
↑  k  Ctrl+P .......... previous  (wraps)
↓  j  Ctrl+N  Tab ..... next      (wraps)
Home / End ............ first / last
1 … 9 ................. jump to that account AND start it
↵  (CR or LF) ......... start Claude Code with the highlighted account
a ..................... add an account
q  Esc ................ quit without starting            exit 0
Ctrl+C  Ctrl+D ........ cancel                           exit 130
```

You do not have to install the hook. `cam launch`, `cam exec` and `cam env`
work on their own, and `cam shell uninstall` removes the block and restores the
backup it took.

## How it works

Claude Code reads `CLAUDE_CONFIG_DIR`; when that variable is set, its whole
configuration — including `.claude.json` and `.credentials.json` — lives inside
that directory instead of your home directory. `cam` gives each account its own
directory under `~/.claude-account-manager/profiles/<name>/` and sets that one
variable on the one `claude` child process it spawns. Claude Code then does all
credential handling itself, inside that directory, exactly as it always has —
so a token it refreshes mid-session is written straight back to the account it
belongs to, and there is no stored copy anywhere that can go stale. The reserved
`default` account is the exception that makes this safe to install: its
directory is `null` and it launches with **no** `CLAUDE_CONFIG_DIR` set at all,
so the child environment is byte-for-byte what you have today. `cam` never
writes to `~/.claude.json`, `~/.claude/.claude.json` or
`~/.claude/.credentials.json`, and there is no code path in it that opens a
credentials file for writing.

Five variables silently outrank `CLAUDE_CONFIG_DIR`. Left in place, every
profile would resolve to the same account while `cam` reported success, so
`cam` removes them from that one child process and prints a line saying it did
— `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`,
`SELF_HOSTED_RUNNER_HOST_CONFIG_DIR`, `CLAUDE_CODE_ACCOUNT_UUID` and
`CLAUDE_CODE_ORGANIZATION_UUID`. Pass `--keep-env` when one of them is your
intended credential.

## What is shared and what is not

A new profile starts empty, which would mean re-approving every plugin and
re-accepting every folder trust dialog. `cam add` therefore shares the parts of
`~/.claude` that belong to *you* rather than to an account, and refuses to share
the parts that belong to one account's organisation.

| What | Treatment | Why |
| --- | --- | --- |
| `plugins/`, `commands/`, `agents/`, `skills/` | **Shared** — directory junction on Windows, symlink elsewhere; degrades to a copy, then to skipping | Your tooling. Edit it once, every account sees it. |
| `settings.json`, `CLAUDE.md` | **Copied once**, at creation | Starting point, not a live link — each account can then diverge. |
| Machine state: onboarding flag, theme, per-folder trust, `mcpServers` | **Seeded once** from an explicit allowlist | So a new account does not re-ask questions you have already answered. |
| Account state: `oauthAccount`, usage and eligibility caches, model access caches | **Never copied** | These belong to one account. Copying them cross-contaminates the UI and the caches. |
| `projects/`, `sessions/`, `todos/`, `file-history/`, `shell-snapshots/` | **Not shared** | Conversation transcripts. Sharing them lets `--resume` under one account continue a session belonging to another organisation. |

Say it plainly: **after switching accounts, "my history disappeared" is the
expected behaviour.** Each account has its own `--resume` list, and that is the
point. If you accept the risk and want transcripts shared anyway, create the
profile with `cam add <name> --share-projects`; `cam` prints a warning at
creation saying `--resume` can then load another account's session.

`cam add --no-share` skips the shared directories and copied files entirely.
`cam add --no-seed` skips the machine-state seed.

## Security

Full detail, including the exact list of files written and the threat model, is
in [SECURITY.md](SECURITY.md). The three things worth knowing here:

- **`cam` never reads or writes a token.** There is no code path that opens
  `.credentials.json` for writing. The only things it ever reads out of one are
  the expiry timestamps behind the "expires in 4d" warning and a truncated
  SHA-256 fingerprint used to notice that two profiles are the same account.
  Token strings are never logged and never written to a file `cam` creates.
- **Each account's credentials stay wherever Claude Code puts them.** On Linux
  and Windows that is a plaintext `.credentials.json` inside the profile
  directory; on macOS it is the login Keychain, namespaced per config directory.
  `cam` does not change that storage and cannot make it more secure than Claude
  Code makes it. On Windows, `chmod` is a no-op, so those files are protected
  only by your user profile's NTFS ACL — `cam doctor` says so rather than
  implying protection that does not exist.
- **Removing an account does not revoke the session.** `cam rm` moves a local
  directory into `trash/`. The session stays valid on Anthropic's side until you
  sign it out at claude.ai → Settings → Sessions. `cam rm` tells you this every
  time, and `cam restore <name>` undoes the removal.

This tool is for switching between accounts you already own. It is not a way to
share one account with other people; that is against Anthropic's terms.

## Platform support

**Windows and Linux are verified.** The mechanism is exercised on both:
`CLAUDE_CONFIG_DIR` isolation, directory junctions and symlinks, the PowerShell
function shim, and the bash/zsh hook. CI runs the test suite on Ubuntu, macOS
and Windows across Node 18.17, 20, 22 and 24.

**macOS is verified at runtime rather than assumed.** The macOS credential
backend is the login Keychain, not a file, and `cam` cannot claim from a test
suite that Keychain namespacing per config directory behaves the way it needs
to. So instead of asserting it, `cam add` proves it on your machine before it
creates a second account: it makes a throwaway config directory, asks
`claude auth status --json` what it reports, and continues only if the answer is
"logged out". If a blank directory claims to be signed in, isolation does not
hold, every account would share one credential, and switching would silently do
nothing while appearing to work — so `cam add` refuses and exits 8 rather than
lying to you. `cam doctor` runs the same check and caches the result;
`cam doctor --deep` re-runs it.

If you use `cam` on macOS, that check is the guarantee you are getting. Reports
from real macOS use are welcome.

## FAQ

**Does this touch my existing login?** No. It becomes the `default` row in the
menu and launches with no `CLAUDE_CONFIG_DIR` at all — byte-for-byte the
behaviour you had before installing `cam`.

**Does `cam` see my password?** No. Adding an account hands the terminal to
Claude Code's own `claude auth login`. `cam` never handles a password, never
holds a token and never talks to Anthropic's servers.

**Does switching log the other account out?** No. Each account keeps its own
session in its own directory. Signing in to a new one does not sign out the ones
you already have.

**Why did my conversation history disappear after switching?** Because it did
not follow you, on purpose. Transcripts stay private to each account so
`--resume` cannot cross an organisation boundary. See
[What is shared and what is not](#what-is-shared-and-what-is-not).

**Does it slow `claude` down?** Only when it asks. With arguments present it
resolves an account and execs the real binary; there is no daemon, no network
call and no dependency tree to load.

**Can I use it without the shell hook?** Yes. `cam launch`, `cam exec <name> --
<cmd>` and `eval "$(cam env work)"` all work on their own.

**Can I pin an account for a whole terminal or a CI job?** Set `CAM_PROFILE`
(or `CAM_ACCOUNT`) to the account name. `--cam` still overrides it for one run.

**Where does everything live?** `~/.claude-account-manager`. Override the whole
store with `CAM_HOME` — useful on Windows if `MAX_PATH` gets tight, which
`cam doctor` warns about.

## Troubleshooting

Start with `cam doctor`. It checks Node, the `claude` binary, isolation, the
credential backend, ambient environment variables, link support, terminal
capability, path length, the shell hook, and each account's token health.

**The menu never appears.** In order of likelihood:

- The hook is not installed, or the terminal predates the install. Run
  `cam shell status`, then open a new terminal.
- An **alias** named `claude` outranks the function. In bash and zsh an alias
  wins over a function of the same name, so the hook never runs.
  `cam shell install` warns about this; fix it with `unalias claude` and remove
  the line from your rc file.
- You are inside Claude Code's own Bash tool. `CLAUDECODE=1` is set in every
  process Claude Code spawns, and the picker is suppressed there
  unconditionally — prompting on a stdin that will never deliver a byte is a
  hard hang, not a slow path.
- You passed arguments. That is the design: `claude -p …`, `claude -c` and
  `claude --resume` never ask. Use `claude --cam` to force the picker once, or
  `cam config ask always`.
- You are in git-bash or mintty. Node gets no TTY there, so the hook tells `cam`
  it is a terminal (`CAM_TTY=1`) and `cam` falls back to a numbered prompt with
  no ANSI at all. That is expected; Windows Terminal gives the full menu.
- Something else is not a terminal (a pipe, a CI runner). `cam` says which
  account it used and why rather than choosing one in silence:

  ```
  $ echo hi | claude
  cam: using "work" (last used; stdin is not a terminal)
       switch with: cam use <name>   or   claude --cam <name>
  ```

**`Can't find the claude command`** (exit 127). `cam` prints every path it
tried, which is the diagnosis. If Claude Code is installed somewhere unusual,
point at it directly:

```sh
cam config claudeBin "C:\path\to\claude.exe"
```

`cam doctor` lists all the candidate paths.

**`CLAUDE_CODE_OAUTH_TOKEN was set in your environment`.** That variable is a
complete auth bypass: it outranks every account, so `cam` removes it from the
session it spawns and tells you it did. If it is genuinely the credential you
want — a CI job, for instance — pass `--keep-env` (or set `CAM_KEEP_ENV=1`) and
`cam` will warn that account selection is not being enforced. It is never
stripped silently, and never stripped from your own shell.

**`Can't safely add a second account on this machine`** (exit 8). A throwaway
config directory reported that it is already signed in, so isolation does not
hold. The usual cause is `CLAUDE_SECURESTORAGE_CONFIG_DIR` being set. Unset it
and run `cam doctor`.

**The output is mangled or misaligned.** `CAM_ASCII=1` (or `--ascii`) forces
7-bit output for every glyph, separator and ellipsis; `NO_COLOR=1` (or
`--no-color`) drops colour. The layout is identical either way.

**Something else.** `cam which -v` shows exactly which account would be used,
why, which binary would run, and the full command line — usually faster than
guessing.

## Uninstall

```sh
cam shell uninstall
npm uninstall -g @caiquepessan/claude-account-manager
rm -rf ~/.claude-account-manager      # optional: deletes the extra accounts
```

`cam shell uninstall` removes the managed block from every shell file it wrote
to and restores the backup it took first.

Your original Claude Code login is untouched throughout, because it was never
moved. Deleting `~/.claude-account-manager` deletes the *other* accounts' config
directories, which does not revoke their sessions — sign those out at
claude.ai → Settings → Sessions if you want them gone.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: ESM, Node 18.17+, zero
dependencies, `node:` built-ins only. Everything environment-dependent comes
from an injected `ctx`, so no file under `src/` except `ctx.js` touches
`process.env`, `process.platform`, `process.stdout`, `os.homedir()`,
`Date.now()` or `node:child_process`. Every user-facing string goes through
`ctx.t()` with a matching entry in both `en` and `pt-BR`.

```sh
git clone https://github.com/caiquepessan/claude-account-manager
cd claude-account-manager
node --test          # there is nothing to install — that is the point
```

To try a working copy without touching your real accounts:

```sh
CAM_HOME=/tmp/cam-scratch node bin/cam.js ls
```

Bug reports and security issues:
[issues](https://github.com/caiquepessan/claude-account-manager/issues) ·
[SECURITY.md](SECURITY.md).

## License

MIT © Caique Pessan. See [LICENSE](LICENSE).
