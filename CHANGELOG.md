# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-01

### Added

- Interactive account picker shown when you type a bare `claude`, with arrow-key
  navigation, one-keystroke digit hotkeys, and a numbered fallback for terminals
  that give Node no TTY (git-bash / mintty).
- Per-account isolation via `CLAUDE_CONFIG_DIR`: each account is its own Claude
  Code config directory, so switching is one environment variable and your
  existing login is never moved, copied or rewritten.
- `cam add` hands off to Claude Code's own `claude auth login`, so cam never
  sees a password, and verifies isolation on your actual machine before creating
  a second account.
- Pass-through semantics: `claude <args>` goes straight to the active account
  with no menu, so `claude -p x | jq`, `claude -c` and `claude --resume` behave
  exactly as they did before installing cam.
- `claude --cam <name>` for a one-shot switch without changing the default.
- Shell hook installer for PowerShell, bash, zsh and fish, with backups, marker
  blocks and a clean uninstall.
- `cam doctor`, which turns every platform assumption in the design into a check
  that runs in your environment.
- Bilingual interface (English and Brazilian Portuguese), auto-detected from the
  system locale and overridable with `CAM_LANG`.

[Unreleased]: https://github.com/caiquepessan/claude-account-manager/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/caiquepessan/claude-account-manager/releases/tag/v0.1.0
