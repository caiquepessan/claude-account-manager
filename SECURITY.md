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
writing, and the only field cam ever reads out of it is the pair of expiry
timestamps used for the "expires in 4d" warning, plus a truncated SHA-256
fingerprint used to notice that two profiles are the same account. Token strings
never outlive the function that parses them, are never logged, and are never
placed in a file cam writes.

What cam does instead is give each account **its own Claude Code config
directory** and set `CLAUDE_CONFIG_DIR` on the `claude` child process it spawns.
Claude Code then does all credential handling itself, exactly as it always has,
inside that directory. Switching accounts is one environment variable — not a
file swap.

Consequences worth understanding:

- **Your existing login is never touched.** The account shown as `default` in the
  menu launches `claude` with no `CLAUDE_CONFIG_DIR` at all, so it is byte-for-byte
  the behaviour you had before installing cam. cam never writes to `~/.claude.json`,
  `~/.claude/.claude.json`, or `~/.claude/.credentials.json`.
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
  directory. The session stays valid on Anthropic's side until you sign it out at
  claude.ai → Settings → Sessions. `cam rm` tells you this every time.
- **Claude Code writes its own plaintext config backups** to `~/.claude/backups`,
  and those contain your account email. cam does not create them and does not
  delete them; `cam doctor` counts them so you know they are there.

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
appear to switch accounts while changing nothing. When a profile is launched they
are removed from that one child process, and cam prints a line saying so — never
silently:

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

The `default` account is launched with your environment completely untouched,
including any `CLAUDE_CONFIG_DIR` you set yourself.

## Supported versions

Only the latest released version receives fixes.
