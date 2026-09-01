# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/caiquepessan/claude-account-manager/security/advisories/new)
rather than in a public issue. You should get a first response within a few days.

## What this tool actually does with your credentials

Being precise about this matters more than any promise, so here is the whole
mechanism:

**cam never reads, writes, moves, copies or transmits a Claude access token or
refresh token.** There is no code path that opens `.credentials.json` for
writing. What cam does read out of one is a short, fixed list, and it is worth
being exact about all of it:

| Read | Used for |
| --- | --- |
| `claudeAiOauth.expiresAt`, `claudeAiOauth.refreshTokenExpiresAt` | The "expires in 4d" warning and the token column of `cam ls`. |
| `claudeAiOauth.subscriptionType` | The plan shown in the picker and `cam ls`. |
| whether `claudeAiOauth.accessToken` is a non-empty string | Deciding whether the account counts as signed in. The value itself is never used. |
| a 12-hex prefix of SHA-256 over the refresh token | Noticing that two profiles are in fact the same account. |
| `claudeAiOauth.scopes`, and the top-level key names other than `claudeAiOauth` | Nothing today. They are returned by the reader and no caller consumes them; they exist so an unexpectedly shaped credentials file is visible rather than silently mis-parsed. |

Token strings never outlive the function that parses them, are never logged, and
are never placed in a file cam writes. Three of the derived values are cached in
a file cam writes — the two expiry timestamps, the subscription type and the
12-hex fingerprint land in the profile's own `.cam-meta.json`, so `cam ls` can
show a plan and a token age without opening a credentials file at all. None of
them can be turned back into a credential.

On macOS, and on Windows with Credential Manager enabled, cam reads **nothing**
at all: it cannot without raising a Keychain prompt, so it does not try, and
`cam ls` shows the cached values or nothing.

What cam does instead is give each account **its own Claude Code config
directory** and set `CLAUDE_CONFIG_DIR` on the `claude` child process it spawns.
Claude Code then does all credential handling itself, exactly as it always has,
inside that directory. Switching accounts is one environment variable — not a
file swap.

Consequences worth understanding:

- **Your existing login is never touched.** The account shown as `default` in the
  menu has no config directory of its own, so cam sets no `CLAUDE_CONFIG_DIR` for
  it and passes your environment through unchanged — byte-for-byte the behaviour
  you had before installing cam. That pass-through is literal: see
  [Environment variables cam removes](#environment-variables-cam-removes-from-the-child-process)
  for what it means for the overriding variables. cam never writes to
  `~/.claude.json`, `~/.claude/.claude.json`, or `~/.claude/.credentials.json`.
- **Tokens live wherever Claude Code puts them.** On Linux and Windows that is a
  plaintext `.credentials.json` inside each profile directory. On macOS it is the
  login Keychain, namespaced per config directory. cam does not change that
  storage, and cannot make it more secure than Claude Code makes it.
- **File permissions.** Everything cam creates under `~/.claude-account-manager`
  is `0700` for directories and `0600` for files on Linux and macOS. On Windows
  `chmod` is a no-op — those files are protected only by your user profile's
  NTFS ACL. `cam doctor` says so plainly rather than implying protection that
  does not exist.
- **Removing an account does not revoke it.** `cam rm` quarantines a local
  directory into `trash/`; `cam restore <name>` puts it back. The session stays
  valid on Anthropic's side until you sign it out at claude.ai → Settings →
  Sessions. `cam rm` tells you this every time.
- **`cam rm --purge` does delete credential storage.** It is the one command that
  does. It deletes the profile directory outright rather than quarantining it —
  including the `.credentials.json` inside it on Linux and Windows — and on macOS
  it then runs `security delete-generic-password` against that profile's own
  Keychain service, removing the item and its chunks. That item lives outside the
  profile directory, so `cam restore` cannot bring it back and nothing else can:
  the account has to sign in again. cam refuses the whole operation outright if
  the directory handed to it is the machine's real `~/.claude`, and it deliberately
  ignores `CLAUDE_SECURESTORAGE_CONFIG_DIR` when locating the file so a purge can
  never reach outside the profile it was given. The one thing it does *not* clean
  up is a Windows Credential Manager entry, because `cmdkey` cannot address the
  chunked blob Claude Code writes there; cam says nothing was removed rather than
  pretending. And `cam rm --purge` still does not revoke the session server-side;
  it says so before it asks you to confirm.
- **Claude Code writes its own plaintext config backups** to `~/.claude/backups`,
  and those contain your account email. cam does not create them and does not
  delete them; `cam doctor` counts them so you know they are there.

## Every file cam writes

There are exactly two places on disk cam creates anything, and one of them you
have to ask for.

**Its own store, `~/.claude-account-manager`** (or `$CAM_HOME` when you set it):

| Path | Written by | Contents |
| --- | --- | --- |
| `config.json` | `cam config` | cam's own settings, such as `claudeBin`. |
| `last` | `cam use`, `cam add`, every launch | One line: the name of the account bare `claude` uses. |
| `isolation.json` | `cam add`, `cam doctor --deep` | Cached result of the isolation self-test: ok/not, when, the Claude Code version, why. |
| `default-meta.json` | any command that resolves the `default` row | Its cached identity — email, org, plan — keyed on your `~/.claude.json`'s size and mtime, so a 78 KB file is not re-parsed on every launch. |
| `profiles/<name>/` | `cam add` | One whole Claude Code config directory per account. Everything inside it except the files named below is written by Claude Code itself, not by cam. |
| `profiles/<name>/.cam-meta.json` | `cam add`, `cam ls`, every launch | cam's own record for that account: name, email, org, plan, backend, launch count, timestamps, the token expiry timestamps and the 12-hex fingerprint. No token. |
| `profiles/<name>/.cam-pending` | `cam add` | A marker while an account is half-created, so an interrupted `cam add` can be swept up rather than left behind. |
| `profiles/<name>/.claude.json` | `cam add` | The seeded machine state, written once at creation from an explicit allowlist. A `.claude.json.cam-backup` copy is kept the first time cam rewrites it. |
| `profiles/<name>/settings.json`, `CLAUDE.md` | `cam add` | Copied once from `~/.claude` at creation. |
| `profiles/<name>/plugins`, `commands`, `agents`, `skills` | `cam add` | Links to the ones in `~/.claude` — junctions on Windows, symlinks elsewhere; a copy if links are unavailable, and skipped if that fails too. |
| `trash/<name>-<timestamp>/` | `cam rm` | The quarantined profile, moved whole, plus a `trash-meta.json` describing where it came from. |
| `shell/cam.sh`, `shell/cam.ps1` | `cam shell install` | The hook runtime your rc file sources. Rewritten on upgrade; removed when the last hook is uninstalled. |

Directories are `0700` and files `0600` on Linux and macOS.

**Your shell startup files, and only if you run `cam shell install`:**

- A marked block appended to whichever of `~/.bashrc`, `~/.bash_profile`
  (macOS), `$ZDOTDIR/.zshrc` and the Windows PowerShell / pwsh `$PROFILE` you
  choose, and a `claude.fish` function file under `~/.config/fish/functions/`.
  `cam shell uninstall` takes the block out again; the rest of the file survives
  byte-for-byte, and a `claude.fish` cam did not write is never deleted.
- `<file>.cam-backup-<ISO>` — a timestamped copy of an rc file taken *before*
  every edit, on install and on uninstall alike. cam never reads one back, so
  they accumulate one per edit and are yours to inspect or delete.

Nothing else. In particular `~/.claude.json`, `~/.claude/.claude.json` and
`~/.claude/.credentials.json` are refused by the file-writing layer itself, not
merely avoided by convention: every atomic write checks the path against those
three and raises `UNSAFE` rather than proceeding.

## Threat model

cam protects against *mixing up accounts* — sending a prompt to the wrong
organisation, or having one client's conversation history reachable from another
client's session. That is why conversation transcripts (`projects/`, `sessions/`,
`todos/`, `file-history/`, `shell-snapshots/`) are **not** shared between profiles
by default, and why `cam add` refuses to create a second account if it cannot
first prove, on your actual machine, that two config directories really are
isolated.

cam does **not** protect against an attacker who already has read access to your
user account on this machine. Anyone who can read `~/.claude-account-manager` can
read the same credentials they could already read from `~/.claude`.

## Environment variables cam removes from the child process

These silently outrank `CLAUDE_CONFIG_DIR`, so leaving them set would make cam
appear to switch accounts while changing nothing. When a cam-managed profile is
launched they are removed from that one child process, and cam prints a line
saying so — never silently:

| Variable | Why it is removed |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | A complete auth bypass; outranks every account. |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR` | Relocates the credential store on its own, collapsing isolation. |
| `SELF_HOSTED_RUNNER_HOST_CONFIG_DIR` | Outranks `CLAUDE_CONFIG_DIR` entirely. |
| `CLAUDE_CODE_ACCOUNT_UUID` | Pins an identity independently of the config dir. |
| `CLAUDE_CODE_ORGANIZATION_UUID` | Same, for the organisation. |

Pass `--keep-env` (or set `CAM_KEEP_ENV=1`) if one of these *is* your intended
credential, such as `CLAUDE_CODE_OAUTH_TOKEN` in CI. cam then warns that account
selection is not being enforced.

**The `default` account is the exception, and you should understand it.** It is
launched with your environment completely untouched — including any
`CLAUDE_CONFIG_DIR` you set yourself, and including every variable in the table
above. Nothing is stripped from it, because "untouched" is the entire point of
that row: it is what makes installing cam a no-op for the login you already had.
The consequence is real, though. If `CLAUDE_CODE_OAUTH_TOKEN` is exported in
your shell, choosing `default` runs Claude Code as that token's account, not as
your `~/.claude` login. Unset it, or pick a named account, where cam does
enforce the choice.

## Supported versions

Only the latest released version receives fixes.
