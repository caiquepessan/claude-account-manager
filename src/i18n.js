// src/i18n.js — the bilingual string catalogue (en, pt-BR) and the translator.
// Owns EVERY user-facing string in cam: no other module may hold English text.
// Values may be plain strings with {name} placeholders, or (vars) => string.

/** Locales this build ships. */
export const LOCALES = ['en', 'pt-BR'];

/** Keys asked for at runtime that were not in the catalogue. */
const MISSING = new Set();

const EN = {
  // ── app ──────────────────────────────────────────────────────────────
  // Menu header line, budget: 34 cols on the left half of the box.
  'app.name': 'Claude Account Manager',
  'app.short': 'cam',
  'app.tagline': 'pick which Claude account `claude` starts with',
  'app.header': '{name}  {version}',
  'app.claudeVersion': 'claude {version}',
  'app.versionLine': 'cam {version} · node {node} · {platform}',
  'app.repo': 'https://github.com/caiquepessan/claude-account-manager',

  // ── menu ─────────────────────────────────────────────────────────────
  'menu.title': 'Choose an account',
  'menu.footer': '{updown} move · {enter} start · a add · q quit',
  'menu.footerSelect': '{updown} move · {enter} select · q quit',
  'menu.add': 'Add account',
  'menu.addVia': 'via claude auth login',
  'menu.yourLogin': 'your login',           // budget: 12 cols
  'menu.lastUsed': 'last used',             // budget: 12 cols
  'menu.active': 'active',
  'menu.empty': 'No accounts yet — press a to add one',
  'menu.hotkey': 'press {n} to start it',
  'menu.signedOut': 'signed out',

  // ── key names (footers and hints) ────────────────────────────────────
  'key.up': 'up',
  'key.down': 'down',
  'key.updown': '{up}{down}',
  'key.enter': 'Enter',
  'key.esc': 'esc',
  'key.tab': 'tab',
  'key.move': 'move',
  'key.start': 'start',
  'key.select': 'select',
  'key.add': 'add',
  'key.quit': 'quit',
  'key.cancel': 'cancel',
  'key.accept': 'accept',
  'key.continue': 'continue',
  'key.clear': 'clear',
  'key.deleteWord': 'delete word',
  'key.first': 'first',
  'key.last': 'last',
  'key.jump': 'jump and start',
  'key.yes': 'yes',
  'key.no': 'no',

  // ── launch (the hot path) ────────────────────────────────────────────
  'launch.banner': '{name} · {email} · {plan}',
  'launch.bannerNoEmail': '{name} · {plan}',
  'launch.bannerPlain': '{name}',
  'launch.prefix': 'cam:',
  'launch.using': 'using "{name}" ({reason})',
  'launch.switchHint': 'switch with: cam use <name>   or   claude --cam <name>',
  'launch.cannotAsk': 'cannot ask here: {reason}',
  'launch.lastMissing': 'the account "{name}" is gone; using default instead',
  'launch.stripped': '{name} was set in your environment. {impact}, so cam removed it from this session only.',
  'launch.strippedKeep': 'Keep it with: claude --keep-env    Details: cam doctor',
  'launch.keepEnv': '--keep-env: account selection is not enforced in this session.',
  'launch.respectConfigDir': 'respecting your CLAUDE_CONFIG_DIR',
  'launch.healExpired': '{name}: this account\u2019s sign-in expired {ago}.',
  'launch.healSignedOut': '{name}: this account is signed out.',
  'launch.healAction': 'Signing you in again — settings, plugins and shared folders are kept.',
  'launch.healFailed': 'Sign-in did not complete; nothing was started.',
  'launch.healDone': 'Signed in again.',
  'launch.cancelled': 'Cancelled — nothing was started.',
  'launch.noAccounts': 'No accounts yet.',
  'launch.spawning': 'starting {bin}',
  'launch.exited': 'claude exited with {code}',
  'launch.noClaudeTitle': 'Can\u2019t find the claude command.',
  'launch.noClaudeInstall': 'Install Claude Code',
  'launch.noClaudeAlready': 'Already installed?',
  'launch.noClaudeAlreadyHint': 'cam config claudeBin "<path to claude>"',
  'launch.noClaudeLooked': 'I looked in',
  'launch.noClaudeMore': (v) => `…and ${v.n} more (cam doctor shows all)`,

  // ── env vars cam removes from the child ──────────────────────────────
  'env.impact.oauthToken': 'it overrides every account and bypasses cam entirely',
  'env.impact.secureStorage': 'it moves the credential store and collapses account isolation',
  'env.impact.selfHosted': 'it outranks CLAUDE_CONFIG_DIR entirely',
  'env.impact.accountUuid': 'it pins the account id',
  'env.impact.orgUuid': 'it pins the organisation id',
  'env.impact.camPin': 'a nested session would inherit a stale cam pin',
  // Reported, never stripped: these two complete the same sentence in a
  // `cam which -v` row, so they stay in the same "it …" clause shape.
  'env.impact.configDir': 'it already chooses the config directory, and cam leaves it alone',
  'env.impact.credman': 'it moves the session into Windows Credential Manager, which cam can only report',
  'env.usage': 'usage: cam env <name> [--shell posix|powershell|fish|cmd]',
  'env.unknownShell': 'unknown shell "{shell}"',
  'env.shellList': 'use one of: posix, powershell, fish, cmd',
  'env.evalHint': 'safe to eval in your shell',

  // ── the picker (numbered fallback and suppression) ───────────────────
  'pick.header': 'Choose an account:',
  'pick.notty': 'this terminal doesn\u2019t expose a TTY to Node (MSYS/mintty).',
  'pick.nottyHint': 'Using the numbered prompt — Windows Terminal gives the full menu.',
  'pick.choice': 'choice [{def}]: ',
  'pick.addRow': 'a) add account',
  'pick.quitRow': 'q) quit',
  'pick.lastUsedTag': '(last used)',
  'pick.invalid': 'not a valid choice',
  'pick.reason.claudecode': 'running inside Claude Code',
  'pick.reason.noPrompt': 'CAM_NO_PROMPT is set',
  'pick.reason.ci': 'CI is set',
  'pick.reason.notATty': 'stdin is not a terminal',
  'pick.reason.args': 'arguments were forwarded',
  'pick.reason.askNever': 'ask=never',
  'pick.reason.single': 'only one account',
  'pick.reason.rawUnavailable': 'raw mode is unavailable',

  // ── prompts (text input and confirm) ─────────────────────────────────
  'prompt.footerText': '{enter} continue · {esc} cancel',
  'prompt.footerConfirm': 'y · n · {enter} takes the default · {esc} = no',
  'prompt.yesKey': 'y',
  'prompt.noKey': 'n',
  'prompt.yesNo': '[Y/n]',
  'prompt.noYes': '[y/N]',
  'prompt.typeToConfirm': 'Type {word} to confirm:',
  'prompt.mismatch': 'that did not match — nothing was changed',
  'prompt.cancelled': 'Cancelled.',
  // Hint for any prompt that cannot run here; not tied to `cam rm`.
  'prompt.needsYes': 'pass --yes to continue without a prompt',

  // ── add an account ───────────────────────────────────────────────────
  'add.title': 'Add an account',
  'add.namePrompt': 'Name this account',
  // budget: 54 cols inside the box
  'add.nameHint': 'a–z 0–9 . _ -  ·  max 32  ·  this becomes a folder name',
  'add.nameEmpty': 'type a name',
  'add.nameTaken': '"{name}" is already taken — try {suggestion}',
  'add.nameChars': 'use only a–z 0–9 . _ -',
  'add.nameTooLong': 'max 32 characters',
  'add.nameStart': 'can\u2019t start with . or -',
  'add.nameReserved': '"{name}" is a reserved name',
  'add.checkIsolation': 'Isolation check',
  'add.checkIsolationOk': 'a fresh config dir reports logged-out',
  'add.checkFolder': 'Folder',
  'add.checkSeeded': 'Seeded',
  'add.seededDetail': (v) => `onboarding, theme, folder trust, ${v.n} MCP servers`,
  'add.checkShared': 'Shared',
  'add.sharedDetail': '{items}   ({mode})',
  'add.notShared': 'Not shared',
  'add.notSharedDetail': 'conversation history and --resume sessions stay private to each account, on purpose',
  'add.shareProjectsWarn': '--share-projects: transcripts are shared, so --resume can load another account\u2019s session.',
  'add.handoff': 'Claude Code\u2019s own login opens next — the same flow as `claude auth login`.',
  'add.handoffPrivacy': 'cam never sees your password, and signing in here does not sign out the accounts you already have.',
  'add.authHeader': 'claude auth login',
  'add.signedIn': 'Signed in',
  'add.credentials': 'Credentials',
  'add.credentialsDetail': 'this profile\u2019s own store — your other accounts were not touched',
  'add.savedAs': 'Saved as "{name}"',
  'add.next': 'Next',
  'add.nextPick': 'pick it from the menu',
  'add.nextUse': 'make it the default',
  'add.noEmail': 'signed in, but Claude Code reported no email address',
  'add.dupTitle': 'This is the same account as "{name}" (same account id).',
  'add.dupBody': 'Two profiles for one account usually means confusion later.',
  'add.dupChoices': '[k] keep both   [r] replace "{name}"   [c] cancel',
  'add.dupKept': 'Kept both.',
  'add.dupReplaced': 'Replaced "{name}".',
  'add.dupCancelled': 'Cancelled — nothing was created.',
  'add.failed': 'Login did not complete (claude auth login exited {code})',
  'add.removed': 'Removed {dir}',
  'add.nothingElse': 'Nothing else changed. Keep it for debugging with: cam add <name> --keep',
  'add.kept': 'Kept {dir} for debugging.',
  'add.cancelled': 'Cancelled — nothing was created.',
  'add.unsafeTitle': 'Can\u2019t safely add a second account on this machine.',
  'add.unsafeBody': 'A throwaway config directory reported that it is ALREADY signed in, which means every account would share one credential and switching would silently do nothing while appearing to work.',
  'add.unsafeCause': 'Likely cause',
  'add.unsafeCauseDetail': 'CLAUDE_SECURESTORAGE_CONFIG_DIR is set',
  'add.unsafeTry': 'Try',
  'add.unsafeTryDetail': 'unset it, then run: cam doctor',
  'add.keychainWarn': 'this profile\u2019s keychain item could not be confirmed — run: cam doctor',
  'add.pendingSwept': (v) => `${v.n} unfinished profiles cleaned up`,

  // ── first run ────────────────────────────────────────────────────────
  'first.title': 'Welcome',
  'first.already': 'You\u2019re already signed in to Claude Code as',
  'first.identity': '{email}   ·   {plan}',
  'first.stays': 'That login stays exactly where it is. Nothing moves, nothing is copied, nothing is logged out. It shows up in the menu as "default".',
  'first.ask': 'Make `claude` ask which account to use?',
  'first.askDetail': 'adds 3 lines to {file}',
  'first.askUndo': 'backs the file up first · undo any time with  cam shell uninstall',
  'first.installed': 'Installed for {shells} — open a new terminal.',
  'first.aliasWarn': '{shell}: an alias named `claude` already exists and would win over the function. Remove it with: unalias claude',
  'first.skipped': 'Skipped. Install it later with: cam shell install',
  'first.next': 'Next',
  'first.nextAdd': 'sign in with a second account',
  'first.nextClaude': 'with one account it doesn\u2019t ask — it just goes',
  'first.noLogin': 'You\u2019re not signed in to Claude Code yet.',
  'first.noLoginHint': 'Run: cam add',

  // ── list ─────────────────────────────────────────────────────────────
  'list.col.account': 'ACCOUNT',
  'list.col.email': 'SIGNED IN AS',
  'list.col.plan': 'PLAN',
  'list.col.org': 'ORG',
  'list.col.token': 'TOKEN',
  'list.col.lastUsed': 'LAST USED',
  'list.signedOut': '(signed out)',
  // budget: 12 cols — the profile folder is gone from under cam
  'list.folderMissing': '(folder gone)',
  'list.never': 'never',
  'list.footer': (v) => `${v.n} ${v.n === 1 ? 'account' : 'accounts'} · ${v.root}`,
  'list.tokenNote': 'Token column is as of the last time each account was used.',
  'list.empty': 'No accounts yet. Add one with: cam add',

  // ── which ────────────────────────────────────────────────────────────
  'which.chose': 'chose',
  'which.dir': 'dir',
  'which.env': 'env',
  'which.binary': 'binary',
  'which.ambient': 'ambient',
  'which.wouldRun': 'would run',
  'which.envUnset': 'unset (native default account)',
  'which.ambientNone': 'none of the CLAUDE_* override variables are set',
  'which.ambientSet': '{name} is set — cam would remove it for this session',
  'which.ambientKept': '{name} is set — kept because of --keep-env',
  'which.kind.exe': 'native .exe',
  'which.kind.cmd': 'npm shim .cmd',
  'which.kind.script': 'shell script',
  'which.kind.unknown': 'unknown kind',
  'which.reason.flag': 'chosen with --cam {name}',
  'which.reason.env': 'chosen with {var}={name}',
  'which.reason.picked': 'you picked it from the menu',
  'which.reason.last': 'last used',
  'which.reason.only': 'the only account',
  'which.reason.default': 'your existing Claude Code login',
  'which.reason.askNever': 'ask=never, so cam passed through',
  'which.reason.detail': (v) => `no --cam flag, ${v.var} unset, ask=${v.ask}, ${v.n} forwarded ${v.n === 1 ? 'argument' : 'arguments'} → pass-through`,
  'which.reason.detailAsk': 'no arguments, {n} accounts, interactive terminal → menu',
  // ask=always, or a bare --cam: the menu was asked for, arguments or not.
  'which.reason.detailAskAlways': 'menu requested, {n} accounts, interactive terminal → menu',

  // ── doctor ───────────────────────────────────────────────────────────
  'doctor.label.node': 'node',
  'doctor.label.cam': 'cam',
  'doctor.label.claude': 'claude',
  'doctor.label.isolation': 'isolation',
  'doctor.label.credentials': 'credentials',
  'doctor.label.ambient': 'ambient env',
  'doctor.label.links': 'links',
  'doctor.label.terminal': 'terminal',
  'doctor.label.permissions': 'permissions',
  'doctor.label.pathLength': 'path length',
  'doctor.label.shellHook': 'shell hook',
  'doctor.label.backups': 'backups',
  'doctor.label.store': 'store',
  'doctor.label.platform': 'platform',
  'doctor.isolationOk': 'a fresh config dir reports logged-out — accounts are genuinely separate on this machine',
  'doctor.isolationFail': 'a throwaway config dir reported SIGNED IN — accounts would share one credential',
  'doctor.isolationSkipped': 'not checked yet — run: cam doctor --deep',
  'doctor.isolationUnreadable': 'the isolation probe returned no readable status',
  'doctor.credentialsFile': 'file  {path}',
  'doctor.credentialsKeychain': 'macOS Keychain — one item per profile',
  'doctor.credentialsCredman': 'Windows Credential Manager',
  'doctor.credmanOff': '(credman is off)',
  'doctor.deepKeychainWarn': 'a deep check reads the macOS Keychain — expect one access prompt per profile',
  'doctor.ambientOk': 'no CLAUDE_CODE_OAUTH_TOKEN / SECURESTORAGE / SELF_HOSTED',
  'doctor.ambientBad': '{names} set — see: cam which -v',
  'doctor.linksOk': 'directory junctions work without administrator rights',
  'doctor.linksSymlink': 'symlinks work',
  'doctor.linksFail': 'links are unavailable; shared folders were copied instead',
  'doctor.terminalRaw': 'raw mode available — full menu',
  'doctor.terminalLine': 'no raw mode; the numbered prompt is used (MSYS/mintty)',
  'doctor.terminalNone': 'no terminal here — cam will never prompt',
  'doctor.permissionsOk': 'store is 0700 and its files are 0600',
  'doctor.permissionsWindows': 'chmod is a no-op on Windows; these files are protected only by your user-profile ACL',
  'doctor.permissionsLoose': '{path} is world-readable',
  'doctor.pathOk': 'profiles root is {len} chars — plenty of headroom',
  'doctor.pathTight': 'profiles root is {len} chars; MAX_PATH headroom is tight',
  'doctor.pathFix': 'set CAM_HOME=C:\\cam',
  'doctor.shellOk': '{targets}',
  'doctor.shellNone': 'not installed — run: cam shell install',
  'doctor.storeOk': '{root}',
  'doctor.claudeFound': '{version}   {path} ({kind})',
  'doctor.claudeMissing': 'not found — run: cam config claudeBin <path>',
  'doctor.claudeCmdShim': 'a .cmd cannot be spawned directly — cam runs it through {bin}',
  'doctor.claudeDrift': 'claude {version} — outside the tested range, or a profile saw another one',
  'doctor.claudeTested': 'tested against {min}–{max}',
  'doctor.migrationNote': 'a version change can migrate the layout of {path}',
  'doctor.backups': (v) => `~/.claude/backups holds ${v.n} plaintext config ${v.n === 1 ? 'copy' : 'copies'}, each containing an account email. Claude Code writes these, not cam. Review them yourself.`,
  'doctor.backupsOk': 'no plaintext config backups found',
  'doctor.profileOk': 'signed in · sign-in valid {days}d · {links} shared links ok · {size}',
  'doctor.profileExpiring': 'sign-in expires in {days} days — just start it to renew',
  'doctor.profileExpired': 'sign-in expired — run: cam add {name}',
  'doctor.profileSignedOut': 'signed out — run: cam add {name}',
  'doctor.profileUnknown': 'sign-in state unknown on this credential backend',
  // credentials validate, but .claude.json carries no oauthAccount
  'doctor.profileHalfIdentity': 'signed in but anonymous — the account identity is missing; run: cam add {name}',
  'doctor.profileLinksBroken': (v) => `${v.n} shared ${v.n === 1 ? 'link is' : 'links are'} broken — run: cam doctor --fix`,
  'doctor.summary': (v) => `${v.failures} ${v.failures === 1 ? 'failure' : 'failures'} · ${v.warnings} ${v.warnings === 1 ? 'warning' : 'warnings'}`,
  'doctor.fixed': 'fixed: {what}',
  'doctor.fixNothing': 'nothing to fix',
  'doctor.fixHint': 'run with --fix to repair permissions, missing links and stale markers',
  'doctor.deepHint': 'run with --deep to re-run the isolation self-test',
  'doctor.pendingSwept': (v) => `${v.n} stale unfinished profiles removed`,

  // ── credential backend caveats ───────────────────────────────────────
  'credstore.securityMissing': 'the macOS security command is missing — cam cannot touch the keychain',
  'credstore.credmanNoRead': 'cmdkey cannot read this secret back — the item belongs to Claude Code',

  // ── shell hooks ──────────────────────────────────────────────────────
  'shell.installed': 'installed',
  'shell.updated': 'updated',
  'shell.unchanged': 'already up to date',
  'shell.removed': 'removed',
  'shell.absent': 'not installed',
  'shell.notFound': 'no rc file for {shell}',
  'shell.target': '{shell}  {file}',
  'shell.backup': 'backup: {file}',
  'shell.wrote': 'wrote {file}',
  'shell.dryRun': 'dry run — nothing was written',
  'shell.reopen': 'Open a new terminal for this to take effect.',
  'shell.conflictAlias': '{shell}: an alias named `claude` already exists and would win over the function. Remove it with: unalias claude',
  'shell.conflictFunction': '{shell}: a function named `claude` is already defined in {where}',
  'shell.noTargets': 'no supported shell rc files were found',
  'shell.statusHeader': 'shell hooks',
  'shell.usage': 'usage: cam shell install|uninstall|status [--dry-run] [--shell <id>]',
  'shell.unknownShell': 'unknown shell "{shell}"',
  'shell.uninstalled': 'Removed the `claude` hook from {n} files.',

  // ── remove ───────────────────────────────────────────────────────────
  'rm.confirmHead': '"{name}" ({email} · {plan} · last used {when})',
  'rm.explain': 'The folder moves to trash/ and can be brought back with cam restore.',
  'rm.notRevoked': 'Your Claude account is NOT deleted and the session stays valid until you sign it out at claude.ai → Settings → Sessions.',
  'rm.typeName': 'Type the name to confirm: {name}',
  'rm.mismatch': 'that did not match — nothing was removed',
  'rm.done': 'Quarantined → trash/{id}',
  'rm.undo': 'Undo with:  cam restore {name}',
  'rm.purged': 'Purged "{name}" — {files} files, {links} links',
  'rm.purgeWarn': '--purge deletes the copy immediately; there is no undo.',
  'rm.keychainRemoved': 'keychain item removed',
  'rm.refuseDefault': '"default" is your existing Claude Code login; cam cannot remove it.',
  'rm.cancelled': 'Cancelled — nothing was removed.',
  'rm.needsConfirm': 'refusing to remove without confirmation — pass --yes',
  'rm.usage': 'usage: cam rm <name> [--yes] [--purge]',

  // ── restore ──────────────────────────────────────────────────────────
  'restore.done': 'Restored "{name}" → {dir}',
  'restore.notInTrash': 'nothing named "{name}" is in the trash',
  'restore.occupied': 'a profile named "{name}" already exists',
  'restore.usage': 'usage: cam restore <name>',

  // ── trash ────────────────────────────────────────────────────────────
  'trash.empty': 'the trash is empty',
  'trash.col.name': 'NAME',
  'trash.col.size': 'SIZE',
  'trash.col.age': 'AGE',
  'trash.footer': (v) => `${v.n} quarantined ${v.n === 1 ? 'profile' : 'profiles'} · ${v.dir}`,
  'trash.confirmEmpty': 'Permanently delete every quarantined profile?',
  'trash.emptied': (v) => `${v.n} ${v.n === 1 ? 'profile' : 'profiles'} purged`,
  'trash.usage': 'usage: cam trash [--empty] [--yes]',

  // ── config ───────────────────────────────────────────────────────────
  'config.col.key': 'KEY',
  'config.col.value': 'VALUE',
  'config.col.default': 'DEFAULT',
  'config.desc.ask': 'when to show the account menu (auto|always|never)',
  'config.desc.claudeBin': 'absolute path to the claude binary',
  'config.desc.ascii': 'force plain 7-bit output (true|false)',
  'config.set': '{key} = {value}',
  'config.cleared': '{key} cleared',
  'config.unknownKey': 'unknown key "{key}"',
  'config.validKeys': 'valid keys: ask, claudeBin, ascii',
  'config.invalidValue': '"{value}" is not valid for {key}',
  'config.askValues': 'use one of: auto, always, never',
  'config.boolValues': 'use true or false',
  'config.binMissing': 'no file at {path}',
  'config.binCmdWarn': 'a .cmd is fine — cam runs it through the Windows command processor',
  'config.usage': 'usage: cam config [key] [value]',

  // ── health ───────────────────────────────────────────────────────────
  'health.ok': 'ok',
  'health.okShort': 'ok · {days}d',
  'health.warnMenu': '! expires {days}d',
  'health.warnShort': '! {days}d',
  'health.warnLong': 'expires in {days} days',
  'health.expired': 'expired',
  'health.expiredAgo': 'expired {ago}',
  'health.signedout': 'signed out',
  'health.unknown': '—',
  'health.unknownLong': 'unknown on this credential backend',
  'health.notAdvanced': '{name}: the refresh token did not advance during that session and expires in {days} days; run `cam add {name}` to sign in again if it lapses.',

  // ── errors (one per exit-code condition, plus its hint) ──────────────
  'err.prefix': 'cam:',
  'err.hintLabel': 'hint',
  'err.error': 'Something went wrong.',
  'err.errorHint': 'run again with --verbose for details',
  'err.doctorHint': 'run: cam doctor',
  'err.usage': 'That is not a valid command.',
  'err.usageHint': 'run: cam help',
  'err.notFound': 'No account named "{name}".',
  'err.notFoundHint': 'available: {names}',
  'err.conflict': 'An account named "{name}" already exists.',
  'err.conflictHint': 'pick another name, or remove it with: cam rm {name}',
  'err.noAccounts': 'No accounts yet.',
  'err.noAccountsHint': 'run: cam add',
  'err.authFailed': 'Sign-in did not complete.',
  'err.authFailedHint': 'try again with: cam add {name}',
  'err.unsafe': 'Can\u2019t safely isolate accounts on this machine.',
  'err.unsafeHint': 'run: cam doctor',
  'err.noClaude': 'Can\u2019t find the claude command.',
  'err.noClaudeHint': 'cam config claudeBin "<path to claude>"',
  'err.cancelled': 'Cancelled.',
  'err.cancelledHint': 'nothing was changed',
  'err.io': 'Could not write {file}.',
  'err.read': 'Could not read {file}.',
  'err.ioHint': 'another program may be holding it open (antivirus, a backup agent, a running claude)',
  'err.json': '{file} is not valid JSON.',
  'err.jsonHint': 'move it aside and let cam rebuild it',
  'err.nodeVersion': 'cam needs Node 18.17 or newer (found {version}).',
  'err.nodeVersionHint': 'upgrade Node, then try again',
  'err.unexpected': 'Unexpected error: {message}',
  'err.permission': 'Permission denied on {file}.',
  'err.permissionHint': 'check who owns {file}',

  // ── filesystem refusals (structural, not advisory) ───────────────────
  'fsx.refuseOutsideStore': 'Refusing to delete {file}: it is outside {root}.',
  'fsx.refuseClaudeOwned': 'cam never writes {file}.',
  'fsx.copyIntoItself': 'Cannot copy into {file}: it is inside the directory being copied.',

  // ── relative time ────────────────────────────────────────────────────
  'time.now': 'just now',
  'time.minutes': (v) => `${v.n}m ago`,
  'time.hours': (v) => `${v.n}h ago`,
  'time.yesterday': 'yesterday',
  'time.days': (v) => `${v.n}d ago`,
  'time.weeks': (v) => `${v.n}w ago`,
  'time.months': (v) => `${v.n}mo ago`,
  'time.never': 'never',
  'time.inDays': (v) => `in ${v.n}d`,
  'time.inHours': (v) => `in ${v.n}h`,

  // ── plans ────────────────────────────────────────────────────────────
  'plan.free': 'free',
  'plan.pro': 'pro',
  'plan.max': 'max',
  'plan.team': 'team',
  'plan.enterprise': 'enterprise',
  'plan.unknown': '—',

  // ── share modes ──────────────────────────────────────────────────────
  'share.mode.junction': 'junction',
  'share.mode.symlink': 'symlink',
  'share.mode.copy': 'copy',
  'share.mode.skip': 'skipped',

  // ── use / exec ───────────────────────────────────────────────────────
  'use.done': '"{name}" is now the account bare `claude` uses.',
  'use.doneScope': 'This is what cam starts next; a claude outside your shell is unaffected.',
  'use.cancelled': 'Cancelled — the active account did not change.',
  'use.usage': 'usage: cam use [name]',
  'exec.usage': 'usage: cam exec <name> -- <command...>',
  'exec.noCommand': 'nothing to run after --',

  // ── help ─────────────────────────────────────────────────────────────
  'help.usage': 'usage: cam [command] [options]',
  'help.commands': 'Commands',
  'help.more': 'More commands',
  'help.moreHint': 'see them all with: cam help --all',
  'help.options': 'Options',
  'help.examples': 'Examples',
  // Label for the `code name` block; a colon and the codes follow it.
  'help.exitCodes': 'exit',
  'help.footer': 'Docs: {repo}',
  'help.unknownCommand': 'unknown command "{cmd}"',
  'help.cmd.launch': 'pick an account and start Claude Code',
  'help.cmd.add': 'sign in with another account',
  'help.cmd.ls': 'list your accounts',
  'help.cmd.use': 'set the account bare `claude` uses',
  'help.cmd.rm': 'quarantine an account',
  'help.cmd.shell': 'install the `claude` shell hook',
  'help.cmd.doctor': 'check this machine',
  'help.cmd.help': 'show this help',
  'help.cmd.which': 'show which account would be used, and why',
  'help.cmd.env': 'print the environment for an account',
  'help.cmd.exec': 'run any command under an account',
  'help.cmd.restore': 'bring a quarantined account back',
  'help.cmd.trash': 'list or empty the trash',
  'help.cmd.config': 'read or change the three settings',
  'help.opt.cam': 'use this account for one run',
  'help.opt.keepEnv': 'keep CLAUDE_* variables cam would remove',
  'help.opt.json': 'machine-readable output',
  'help.opt.yes': 'do not ask for confirmation',
  'help.opt.verbose': 'explain what cam is doing',
  'help.opt.ascii': 'plain 7-bit output',
  'help.opt.lang': 'force a language (en|pt-BR)',
  'help.opt.help': 'show help',
  'help.opt.version': 'show the version',
};

const PT = {
  // ── app ──────────────────────────────────────────────────────────────
  'app.name': 'Claude Account Manager',
  'app.short': 'cam',
  'app.tagline': 'escolha com qual conta Claude o `claude` inicia',
  'app.header': '{name}  {version}',
  'app.claudeVersion': 'claude {version}',
  'app.versionLine': 'cam {version} · node {node} · {platform}',
  'app.repo': 'https://github.com/caiquepessan/claude-account-manager',

  // ── menu ─────────────────────────────────────────────────────────────
  'menu.title': 'Escolha uma conta',
  'menu.footer': '{updown} mover · {enter} iniciar · a adicionar · q sair',
  'menu.footerSelect': '{updown} mover · {enter} escolher · q sair',
  'menu.add': 'Adicionar conta',
  'menu.addVia': 'via claude auth login',
  'menu.yourLogin': 'seu login',
  'menu.lastUsed': 'último uso',
  'menu.active': 'ativa',
  'menu.empty': 'Nenhuma conta ainda — aperte a para adicionar',
  'menu.hotkey': 'aperte {n} para iniciar',
  'menu.signedOut': 'desconectada',

  // ── key names ────────────────────────────────────────────────────────
  'key.up': 'cima',
  'key.down': 'baixo',
  'key.updown': '{up}{down}',
  'key.enter': 'Enter',
  'key.esc': 'esc',
  'key.tab': 'tab',
  'key.move': 'mover',
  'key.start': 'iniciar',
  'key.select': 'escolher',
  'key.add': 'adicionar',
  'key.quit': 'sair',
  'key.cancel': 'cancelar',
  'key.accept': 'confirmar',
  'key.continue': 'continuar',
  'key.clear': 'limpar',
  'key.deleteWord': 'apagar palavra',
  'key.first': 'primeira',
  'key.last': 'última',
  'key.jump': 'ir e iniciar',
  'key.yes': 'sim',
  'key.no': 'não',

  // ── launch ───────────────────────────────────────────────────────────
  'launch.banner': '{name} · {email} · {plan}',
  'launch.bannerNoEmail': '{name} · {plan}',
  'launch.bannerPlain': '{name}',
  'launch.prefix': 'cam:',
  'launch.using': 'usando "{name}" ({reason})',
  'launch.switchHint': 'troque com: cam use <nome>   ou   claude --cam <nome>',
  'launch.cannotAsk': 'não dá para perguntar aqui: {reason}',
  'launch.lastMissing': 'a conta "{name}" não existe mais; usando default',
  'launch.stripped': '{name} estava no seu ambiente. {impact}, então o cam removeu só nesta sessão.',
  'launch.strippedKeep': 'Mantenha com: claude --keep-env    Detalhes: cam doctor',
  'launch.keepEnv': '--keep-env: a escolha de conta não é garantida nesta sessão.',
  'launch.respectConfigDir': 'respeitando seu CLAUDE_CONFIG_DIR',
  'launch.healExpired': '{name}: o login desta conta expirou {ago}.',
  'launch.healSignedOut': '{name}: esta conta está desconectada.',
  'launch.healAction': 'Entrando de novo — configurações, plugins e pastas compartilhadas são mantidos.',
  'launch.healFailed': 'O login não foi concluído; nada foi iniciado.',
  'launch.healDone': 'Login refeito.',
  'launch.cancelled': 'Cancelado — nada foi iniciado.',
  'launch.noAccounts': 'Nenhuma conta ainda.',
  'launch.spawning': 'iniciando {bin}',
  'launch.exited': 'claude terminou com {code}',
  'launch.noClaudeTitle': 'Não encontrei o comando claude.',
  'launch.noClaudeInstall': 'Instale o Claude Code',
  'launch.noClaudeAlready': 'Já instalou?',
  'launch.noClaudeAlreadyHint': 'cam config claudeBin "<caminho do claude>"',
  'launch.noClaudeLooked': 'Procurei em',
  'launch.noClaudeMore': (v) => `…e mais ${v.n} (cam doctor mostra todos)`,

  // ── env ──────────────────────────────────────────────────────────────
  'env.impact.oauthToken': 'ela sobrepõe todas as contas e ignora o cam por completo',
  'env.impact.secureStorage': 'ela move o cofre de credenciais e derruba o isolamento entre contas',
  'env.impact.selfHosted': 'ela tem prioridade sobre o CLAUDE_CONFIG_DIR',
  'env.impact.accountUuid': 'ela fixa o id da conta',
  'env.impact.orgUuid': 'ela fixa o id da organização',
  'env.impact.camPin': 'uma sessão aninhada herdaria uma escolha antiga do cam',
  // Só reportadas, nunca removidas: mesma forma de oração ("ela …").
  'env.impact.configDir': 'ela já escolhe o diretório de config, e o cam não mexe nisso',
  'env.impact.credman': 'ela move a sessão para o Gerenciador de Credenciais do Windows, que o cam não lê',
  'env.usage': 'uso: cam env <nome> [--shell posix|powershell|fish|cmd]',
  'env.unknownShell': 'shell desconhecido "{shell}"',
  'env.shellList': 'use um destes: posix, powershell, fish, cmd',
  'env.evalHint': 'pode passar para o eval do seu shell',

  // ── picker ───────────────────────────────────────────────────────────
  'pick.header': 'Escolha uma conta:',
  'pick.notty': 'este terminal não expõe um TTY para o Node (MSYS/mintty).',
  'pick.nottyHint': 'Usando o menu numerado — o Windows Terminal mostra o menu completo.',
  'pick.choice': 'opção [{def}]: ',
  'pick.addRow': 'a) adicionar conta',
  'pick.quitRow': 'q) sair',
  'pick.lastUsedTag': '(último uso)',
  'pick.invalid': 'opção inválida',
  'pick.reason.claudecode': 'rodando dentro do Claude Code',
  'pick.reason.noPrompt': 'CAM_NO_PROMPT está definida',
  'pick.reason.ci': 'CI está definida',
  'pick.reason.notATty': 'a entrada não é um terminal',
  'pick.reason.args': 'houve argumentos repassados',
  'pick.reason.askNever': 'ask=never',
  'pick.reason.single': 'só existe uma conta',
  'pick.reason.rawUnavailable': 'o modo raw não está disponível',

  // ── prompts ──────────────────────────────────────────────────────────
  'prompt.footerText': '{enter} continuar · {esc} cancelar',
  'prompt.footerConfirm': 's · n · {enter} usa o padrão · {esc} = não',
  'prompt.yesKey': 's',
  'prompt.noKey': 'n',
  'prompt.yesNo': '[S/n]',
  'prompt.noYes': '[s/N]',
  'prompt.typeToConfirm': 'Digite {word} para confirmar:',
  'prompt.mismatch': 'não confere — nada foi alterado',
  'prompt.cancelled': 'Cancelado.',
  // Dica de qualquer prompt que não roda aqui; não é só do `cam rm`.
  'prompt.needsYes': 'use --yes para seguir sem perguntar',

  // ── add ──────────────────────────────────────────────────────────────
  'add.title': 'Adicionar uma conta',
  'add.namePrompt': 'Dê um nome a esta conta',
  'add.nameHint': 'a–z 0–9 . _ -  ·  máx 32  ·  vira o nome da pasta',
  'add.nameEmpty': 'digite um nome',
  'add.nameTaken': '"{name}" já existe — tente {suggestion}',
  'add.nameChars': 'use só a–z 0–9 . _ -',
  'add.nameTooLong': 'máximo de 32 caracteres',
  'add.nameStart': 'não pode começar com . ou -',
  'add.nameReserved': '"{name}" é um nome reservado',
  'add.checkIsolation': 'Isolamento',
  'add.checkIsolationOk': 'um config novo aparece como desconectado',
  'add.checkFolder': 'Pasta',
  'add.checkSeeded': 'Preparada',
  'add.seededDetail': (v) => `onboarding, tema, pastas confiáveis, ${v.n} servidores MCP`,
  'add.checkShared': 'Compartilhado',
  'add.sharedDetail': '{items}   ({mode})',
  'add.notShared': 'Não compartilhado',
  'add.notSharedDetail': 'o histórico de conversas e as sessões do --resume ficam privados de cada conta, de propósito',
  'add.shareProjectsWarn': '--share-projects: os transcritos passam a ser compartilhados, então o --resume pode abrir a sessão de outra conta.',
  'add.handoff': 'O login do próprio Claude Code abre agora — o mesmo fluxo do `claude auth login`.',
  'add.handoffPrivacy': 'O cam nunca vê sua senha, e entrar aqui não desconecta as contas que você já tem.',
  'add.authHeader': 'claude auth login',
  'add.signedIn': 'Conectado',
  'add.credentials': 'Credenciais',
  'add.credentialsDetail': 'no cofre desta conta — suas outras contas não foram tocadas',
  'add.savedAs': 'Salvo como "{name}"',
  'add.next': 'Próximo',
  'add.nextPick': 'escolha no menu',
  'add.nextUse': 'deixe como padrão',
  'add.noEmail': 'conectado, mas o Claude Code não informou um e-mail',
  'add.dupTitle': 'Esta é a mesma conta de "{name}" (mesmo id de conta).',
  'add.dupBody': 'Dois perfis para uma conta costuma dar confusão depois.',
  'add.dupChoices': '[k] manter as duas   [r] substituir "{name}"   [c] cancelar',
  'add.dupKept': 'Mantidas as duas.',
  'add.dupReplaced': 'Substituída "{name}".',
  'add.dupCancelled': 'Cancelado — nada foi criado.',
  'add.failed': 'O login não foi concluído (claude auth login saiu com {code})',
  'add.removed': 'Removi {dir}',
  'add.nothingElse': 'Nada mais mudou. Para depurar, guarde com: cam add <nome> --keep',
  'add.kept': 'Mantive {dir} para depuração.',
  'add.cancelled': 'Cancelado — nada foi criado.',
  'add.unsafeTitle': 'Não dá para adicionar uma segunda conta com segurança nesta máquina.',
  'add.unsafeBody': 'Um diretório de config descartável apareceu como JÁ CONECTADO, ou seja, todas as contas dividiriam uma credencial e trocar de conta não faria nada — parecendo funcionar.',
  'add.unsafeCause': 'Causa provável',
  'add.unsafeCauseDetail': 'CLAUDE_SECURESTORAGE_CONFIG_DIR está definida',
  'add.unsafeTry': 'Tente',
  'add.unsafeTryDetail': 'remova a variável e rode: cam doctor',
  'add.keychainWarn': 'não deu para confirmar o item de chaveiro deste perfil — rode: cam doctor',
  'add.pendingSwept': (v) => `${v.n} perfis inacabados foram limpos`,

  // ── first run ────────────────────────────────────────────────────────
  'first.title': 'Bem-vindo',
  'first.already': 'Você já está conectado ao Claude Code como',
  'first.identity': '{email}   ·   {plan}',
  'first.stays': 'Esse login continua exatamente onde está. Nada é movido, nada é copiado, nada é desconectado. Ele aparece no menu como "default".',
  'first.ask': 'Fazer o `claude` perguntar qual conta usar?',
  'first.askDetail': 'adiciona 3 linhas em {file}',
  'first.askUndo': 'faz backup antes · desfaça quando quiser com  cam shell uninstall',
  'first.installed': 'Instalado para {shells} — abra um terminal novo.',
  'first.aliasWarn': '{shell}: já existe um alias chamado `claude` e ele venceria a função. Remova com: unalias claude',
  'first.skipped': 'Pulado. Instale depois com: cam shell install',
  'first.next': 'Próximo',
  'first.nextAdd': 'entre com uma segunda conta',
  'first.nextClaude': 'com uma conta só ele não pergunta — só vai',
  'first.noLogin': 'Você ainda não está conectado ao Claude Code.',
  'first.noLoginHint': 'Rode: cam add',

  // ── list ─────────────────────────────────────────────────────────────
  'list.col.account': 'CONTA',
  'list.col.email': 'CONECTADA COMO',
  'list.col.plan': 'PLANO',
  'list.col.org': 'ORG',
  'list.col.token': 'TOKEN',
  'list.col.lastUsed': 'ÚLTIMO USO',
  'list.signedOut': '(desconectada)',
  // 12 colunas — a pasta do perfil sumiu debaixo do cam
  'list.folderMissing': '(pasta sumiu)',
  'list.never': 'nunca',
  'list.footer': (v) => `${v.n} ${v.n === 1 ? 'conta' : 'contas'} · ${v.root}`,
  'list.tokenNote': 'A coluna TOKEN reflete a última vez que cada conta foi usada.',
  'list.empty': 'Nenhuma conta ainda. Adicione com: cam add',

  // ── which ────────────────────────────────────────────────────────────
  'which.chose': 'escolhi',
  'which.dir': 'pasta',
  'which.env': 'env',
  'which.binary': 'binário',
  'which.ambient': 'ambiente',
  'which.wouldRun': 'vai rodar',
  'which.envUnset': 'sem definir (conta nativa default)',
  'which.ambientNone': 'nenhuma variável CLAUDE_* de override está definida',
  'which.ambientSet': '{name} está definida — o cam removeria nesta sessão',
  'which.ambientKept': '{name} está definida — mantida por causa do --keep-env',
  'which.kind.exe': '.exe nativo',
  'which.kind.cmd': 'atalho .cmd do npm',
  'which.kind.script': 'script de shell',
  'which.kind.unknown': 'tipo desconhecido',
  'which.reason.flag': 'escolhida com --cam {name}',
  'which.reason.env': 'escolhida com {var}={name}',
  'which.reason.picked': 'você escolheu no menu',
  'which.reason.last': 'último uso',
  'which.reason.only': 'a única conta',
  'which.reason.default': 'seu login atual do Claude Code',
  'which.reason.askNever': 'ask=never, então o cam repassou direto',
  'which.reason.detail': (v) => `sem --cam, ${v.var} não definida, ask=${v.ask}, ${v.n} ${v.n === 1 ? 'argumento repassado' : 'argumentos repassados'} → repasse direto`,
  'which.reason.detailAsk': 'sem argumentos, {n} contas, terminal interativo → menu',
  // ask=always, ou um --cam sozinho: o menu foi pedido, tendo argumento ou não.
  'which.reason.detailAskAlways': 'menu pedido, {n} contas, terminal interativo → menu',

  // ── doctor ───────────────────────────────────────────────────────────
  'doctor.label.node': 'node',
  'doctor.label.cam': 'cam',
  'doctor.label.claude': 'claude',
  'doctor.label.isolation': 'isolamento',
  'doctor.label.credentials': 'credenciais',
  'doctor.label.ambient': 'ambiente',
  'doctor.label.links': 'links',
  'doctor.label.terminal': 'terminal',
  'doctor.label.permissions': 'permissões',
  'doctor.label.pathLength': 'tamanho do caminho',
  'doctor.label.shellHook': 'hook do shell',
  'doctor.label.backups': 'backups',
  'doctor.label.store': 'store',
  'doctor.label.platform': 'plataforma',
  'doctor.isolationOk': 'um config novo aparece como desconectado — as contas são mesmo separadas nesta máquina',
  'doctor.isolationFail': 'um config descartável apareceu CONECTADO — as contas dividiriam uma credencial',
  'doctor.isolationSkipped': 'ainda não testado — rode: cam doctor --deep',
  'doctor.isolationUnreadable': 'o teste de isolamento não devolveu um status legível',
  'doctor.credentialsFile': 'arquivo  {path}',
  'doctor.credentialsKeychain': 'Chaveiro do macOS — um item por perfil',
  'doctor.credentialsCredman': 'Gerenciador de Credenciais do Windows',
  'doctor.credmanOff': '(credman desligado)',
  'doctor.deepKeychainWarn': 'a checagem profunda lê o Chaveiro do macOS — um pedido de acesso por perfil',
  'doctor.ambientOk': 'sem CLAUDE_CODE_OAUTH_TOKEN / SECURESTORAGE / SELF_HOSTED',
  'doctor.ambientBad': '{names} definida(s) — veja: cam which -v',
  'doctor.linksOk': 'junctions de diretório funcionam sem direitos de administrador',
  'doctor.linksSymlink': 'symlinks funcionam',
  'doctor.linksFail': 'links indisponíveis; as pastas compartilhadas foram copiadas',
  'doctor.terminalRaw': 'modo raw disponível — menu completo',
  'doctor.terminalLine': 'sem modo raw; usando o menu numerado (MSYS/mintty)',
  'doctor.terminalNone': 'sem terminal aqui — o cam nunca vai perguntar',
  'doctor.permissionsOk': 'o store está 0700 e os arquivos 0600',
  'doctor.permissionsWindows': 'chmod não faz nada no Windows; estes arquivos só estão protegidos pela ACL do seu perfil de usuário',
  'doctor.permissionsLoose': '{path} está legível por qualquer usuário',
  'doctor.pathOk': 'a raiz dos perfis tem {len} caracteres — sobra bastante espaço',
  'doctor.pathTight': 'a raiz dos perfis tem {len} caracteres; a folga do MAX_PATH está apertada',
  'doctor.pathFix': 'defina CAM_HOME=C:\\cam',
  'doctor.shellOk': '{targets}',
  'doctor.shellNone': 'não instalado — rode: cam shell install',
  'doctor.storeOk': '{root}',
  'doctor.claudeFound': '{version}   {path} ({kind})',
  'doctor.claudeMissing': 'não encontrado — rode: cam config claudeBin <caminho>',
  'doctor.claudeCmdShim': 'um .cmd não roda direto — o cam executa ele via {bin}',
  'doctor.claudeDrift': 'claude {version} — fora da faixa testada, ou um perfil viu outra',
  'doctor.claudeTested': 'testado contra {min}–{max}',
  'doctor.migrationNote': 'uma troca de versão pode migrar o layout de {path}',
  'doctor.backups': (v) => `~/.claude/backups guarda ${v.n} ${v.n === 1 ? 'cópia' : 'cópias'} do config em texto puro, cada uma com um e-mail de conta. Quem escreve isso é o Claude Code, não o cam. Revise você mesmo.`,
  'doctor.backupsOk': 'nenhuma cópia de config em texto puro',
  'doctor.profileOk': 'conectada · login válido por {days}d · {links} links compartilhados ok · {size}',
  'doctor.profileExpiring': 'o login expira em {days} dias — é só iniciar para renovar',
  'doctor.profileExpired': 'login expirado — rode: cam add {name}',
  'doctor.profileSignedOut': 'desconectada — rode: cam add {name}',
  'doctor.profileUnknown': 'estado do login desconhecido neste cofre de credenciais',
  // a credencial vale, mas o .claude.json não tem oauthAccount
  'doctor.profileHalfIdentity': 'conectada mas anônima — falta a identidade da conta; rode: cam add {name}',
  'doctor.profileLinksBroken': (v) => `${v.n} ${v.n === 1 ? 'link compartilhado quebrado' : 'links compartilhados quebrados'} — rode: cam doctor --fix`,
  'doctor.summary': (v) => `${v.failures} ${v.failures === 1 ? 'falha' : 'falhas'} · ${v.warnings} ${v.warnings === 1 ? 'aviso' : 'avisos'}`,
  'doctor.fixed': 'corrigido: {what}',
  'doctor.fixNothing': 'nada a corrigir',
  'doctor.fixHint': 'rode com --fix para ajustar permissões, links faltando e marcadores antigos',
  'doctor.deepHint': 'rode com --deep para refazer o teste de isolamento',
  'doctor.pendingSwept': (v) => `${v.n} perfis inacabados antigos removidos`,

  // ── ressalvas do cofre de credenciais ────────────────────────────────
  'credstore.securityMissing': 'o comando security do macOS não está aqui — o cam não mexe no chaveiro',
  'credstore.credmanNoRead': 'o cmdkey não lê esse segredo de volta — o item pertence ao Claude Code',

  // ── shell ────────────────────────────────────────────────────────────
  'shell.installed': 'instalado',
  'shell.updated': 'atualizado',
  'shell.unchanged': 'já está atualizado',
  'shell.removed': 'removido',
  'shell.absent': 'não instalado',
  'shell.notFound': 'sem arquivo rc para {shell}',
  'shell.target': '{shell}  {file}',
  'shell.backup': 'backup: {file}',
  'shell.wrote': 'escrevi {file}',
  'shell.dryRun': 'simulação — nada foi escrito',
  'shell.reopen': 'Abra um terminal novo para valer.',
  'shell.conflictAlias': '{shell}: já existe um alias chamado `claude` e ele venceria a função. Remova com: unalias claude',
  'shell.conflictFunction': '{shell}: já existe uma função chamada `claude` definida em {where}',
  'shell.noTargets': 'nenhum arquivo rc de shell compatível foi encontrado',
  'shell.statusHeader': 'hooks de shell',
  'shell.usage': 'uso: cam shell install|uninstall|status [--dry-run] [--shell <id>]',
  'shell.unknownShell': 'shell desconhecido "{shell}"',
  'shell.uninstalled': 'Removi o hook do `claude` de {n} arquivos.',

  // ── remove ───────────────────────────────────────────────────────────
  'rm.confirmHead': '"{name}" ({email} · {plan} · último uso {when})',
  'rm.explain': 'A pasta vai para trash/ e volta com cam restore.',
  'rm.notRevoked': 'Sua conta Claude NÃO é apagada e a sessão continua válida até você encerrá-la em claude.ai → Settings → Sessions.',
  'rm.typeName': 'Digite o nome para confirmar: {name}',
  'rm.mismatch': 'não confere — nada foi removido',
  'rm.done': 'Em quarentena → trash/{id}',
  'rm.undo': 'Desfaça com:  cam restore {name}',
  'rm.purged': 'Apaguei "{name}" — {files} arquivos, {links} links',
  'rm.purgeWarn': '--purge apaga a cópia na hora; não tem como desfazer.',
  'rm.keychainRemoved': 'item do chaveiro removido',
  'rm.refuseDefault': '"default" é o seu login atual do Claude Code; o cam não remove.',
  'rm.cancelled': 'Cancelado — nada foi removido.',
  'rm.needsConfirm': 'não vou remover sem confirmação — use --yes',
  'rm.usage': 'uso: cam rm <nome> [--yes] [--purge]',

  // ── restore ──────────────────────────────────────────────────────────
  'restore.done': 'Restaurei "{name}" → {dir}',
  'restore.notInTrash': 'não há nada chamado "{name}" na lixeira',
  'restore.occupied': 'já existe um perfil chamado "{name}"',
  'restore.usage': 'uso: cam restore <nome>',

  // ── trash ────────────────────────────────────────────────────────────
  'trash.empty': 'a lixeira está vazia',
  'trash.col.name': 'NOME',
  'trash.col.size': 'TAMANHO',
  'trash.col.age': 'IDADE',
  'trash.footer': (v) => `${v.n} ${v.n === 1 ? 'perfil em quarentena' : 'perfis em quarentena'} · ${v.dir}`,
  'trash.confirmEmpty': 'Apagar de vez todos os perfis em quarentena?',
  'trash.emptied': (v) => `${v.n} ${v.n === 1 ? 'perfil apagado' : 'perfis apagados'}`,
  'trash.usage': 'uso: cam trash [--empty] [--yes]',

  // ── config ───────────────────────────────────────────────────────────
  'config.col.key': 'CHAVE',
  'config.col.value': 'VALOR',
  'config.col.default': 'PADRÃO',
  'config.desc.ask': 'quando mostrar o menu de contas (auto|always|never)',
  'config.desc.claudeBin': 'caminho absoluto do binário claude',
  'config.desc.ascii': 'forçar saída 7-bit simples (true|false)',
  'config.set': '{key} = {value}',
  'config.cleared': '{key} limpo',
  'config.unknownKey': 'chave desconhecida "{key}"',
  'config.validKeys': 'chaves válidas: ask, claudeBin, ascii',
  'config.invalidValue': '"{value}" não vale para {key}',
  'config.askValues': 'use um destes: auto, always, never',
  'config.boolValues': 'use true ou false',
  'config.binMissing': 'não existe arquivo em {path}',
  'config.binCmdWarn': 'um .cmd serve — o cam roda ele pelo interpretador de comandos do Windows',
  'config.usage': 'uso: cam config [chave] [valor]',

  // ── health ───────────────────────────────────────────────────────────
  'health.ok': 'ok',
  'health.okShort': 'ok · {days}d',
  'health.warnMenu': '! expira {days}d',
  'health.warnShort': '! {days}d',
  'health.warnLong': 'expira em {days} dias',
  'health.expired': 'expirado',
  'health.expiredAgo': 'expirou {ago}',
  'health.signedout': 'desconectada',
  'health.unknown': '—',
  'health.unknownLong': 'desconhecido neste cofre de credenciais',
  'health.notAdvanced': '{name}: o refresh token não avançou nessa sessão e expira em {days} dias; rode `cam add {name}` para entrar de novo se ele vencer.',

  // ── errors ───────────────────────────────────────────────────────────
  'err.prefix': 'cam:',
  'err.hintLabel': 'dica',
  'err.error': 'Algo deu errado.',
  'err.errorHint': 'rode de novo com --verbose para ver detalhes',
  'err.doctorHint': 'rode: cam doctor',
  'err.usage': 'Esse comando não existe.',
  'err.usageHint': 'rode: cam help',
  'err.notFound': 'Nenhuma conta chamada "{name}".',
  'err.notFoundHint': 'disponíveis: {names}',
  'err.conflict': 'Já existe uma conta chamada "{name}".',
  'err.conflictHint': 'escolha outro nome, ou remova com: cam rm {name}',
  'err.noAccounts': 'Nenhuma conta ainda.',
  'err.noAccountsHint': 'rode: cam add',
  'err.authFailed': 'O login não foi concluído.',
  'err.authFailedHint': 'tente de novo com: cam add {name}',
  'err.unsafe': 'Não dá para isolar contas com segurança nesta máquina.',
  'err.unsafeHint': 'rode: cam doctor',
  'err.noClaude': 'Não encontrei o comando claude.',
  'err.noClaudeHint': 'cam config claudeBin "<caminho do claude>"',
  'err.cancelled': 'Cancelado.',
  'err.cancelledHint': 'nada foi alterado',
  'err.io': 'Não consegui escrever {file}.',
  'err.read': 'Não consegui ler {file}.',
  'err.ioHint': 'algum programa pode estar segurando o arquivo (antivírus, backup, um claude aberto)',
  'err.json': '{file} não é um JSON válido.',
  'err.jsonHint': 'mova o arquivo e deixe o cam recriar',
  'err.nodeVersion': 'o cam precisa do Node 18.17 ou mais novo (achei {version}).',
  'err.nodeVersionHint': 'atualize o Node e tente de novo',
  'err.unexpected': 'Erro inesperado: {message}',
  'err.permission': 'Permissão negada em {file}.',
  'err.permissionHint': 'veja de quem é {file}',

  // ── recusas do sistema de arquivos (estruturais, não conselhos) ──────
  'fsx.refuseOutsideStore': 'Não vou apagar {file}: está fora de {root}.',
  'fsx.refuseClaudeOwned': 'O cam nunca escreve {file}.',
  'fsx.copyIntoItself': 'Não dá para copiar para {file}: está dentro da pasta que está sendo copiada.',

  // ── relative time ────────────────────────────────────────────────────
  'time.now': 'agora',
  'time.minutes': (v) => `há ${v.n}min`,
  'time.hours': (v) => `há ${v.n}h`,
  'time.yesterday': 'ontem',
  'time.days': (v) => `há ${v.n}d`,
  'time.weeks': (v) => `há ${v.n}sem`,
  'time.months': (v) => `há ${v.n}mes`,
  'time.never': 'nunca',
  'time.inDays': (v) => `em ${v.n}d`,
  'time.inHours': (v) => `em ${v.n}h`,

  // ── plans ────────────────────────────────────────────────────────────
  'plan.free': 'free',
  'plan.pro': 'pro',
  'plan.max': 'max',
  'plan.team': 'team',
  'plan.enterprise': 'enterprise',
  'plan.unknown': '—',

  // ── share modes ──────────────────────────────────────────────────────
  'share.mode.junction': 'junction',
  'share.mode.symlink': 'symlink',
  'share.mode.copy': 'cópia',
  'share.mode.skip': 'pulado',

  // ── use / exec ───────────────────────────────────────────────────────
  'use.done': '"{name}" agora é a conta que o `claude` sozinho usa.',
  'use.doneScope': 'É o que o cam inicia da próxima vez; um claude fora do seu shell não muda.',
  'use.cancelled': 'Cancelado — a conta ativa não mudou.',
  'use.usage': 'uso: cam use [nome]',
  'exec.usage': 'uso: cam exec <nome> -- <comando...>',
  'exec.noCommand': 'nada para rodar depois do --',

  // ── help ─────────────────────────────────────────────────────────────
  'help.usage': 'uso: cam [comando] [opções]',
  'help.commands': 'Comandos',
  'help.more': 'Mais comandos',
  'help.moreHint': 'veja todos com: cam help --all',
  'help.options': 'Opções',
  'help.examples': 'Exemplos',
  // Rótulo do bloco `código nome`; vem dois-pontos e os códigos depois.
  'help.exitCodes': 'saída',
  'help.footer': 'Docs: {repo}',
  'help.unknownCommand': 'comando desconhecido "{cmd}"',
  'help.cmd.launch': 'escolher uma conta e iniciar o Claude Code',
  'help.cmd.add': 'entrar com outra conta',
  'help.cmd.ls': 'listar suas contas',
  'help.cmd.use': 'definir a conta que o `claude` sozinho usa',
  'help.cmd.rm': 'colocar uma conta em quarentena',
  'help.cmd.shell': 'instalar o hook do `claude` no shell',
  'help.cmd.doctor': 'checar esta máquina',
  'help.cmd.help': 'mostrar esta ajuda',
  'help.cmd.which': 'mostrar qual conta seria usada, e por quê',
  'help.cmd.env': 'imprimir o ambiente de uma conta',
  'help.cmd.exec': 'rodar qualquer comando sob uma conta',
  'help.cmd.restore': 'trazer de volta uma conta em quarentena',
  'help.cmd.trash': 'listar ou esvaziar a lixeira',
  'help.cmd.config': 'ler ou mudar as três configurações',
  'help.opt.cam': 'usar esta conta por uma execução',
  'help.opt.keepEnv': 'manter as variáveis CLAUDE_* que o cam removeria',
  'help.opt.json': 'saída para máquina',
  'help.opt.yes': 'não pedir confirmação',
  'help.opt.verbose': 'explicar o que o cam está fazendo',
  'help.opt.ascii': 'saída 7-bit simples',
  'help.opt.lang': 'forçar um idioma (en|pt-BR)',
  'help.opt.help': 'mostrar a ajuda',
  'help.opt.version': 'mostrar a versão',
};

/** The complete catalogue, frozen. */
export const MESSAGES = Object.freeze({ en: Object.freeze(EN), 'pt-BR': Object.freeze(PT) });

/**
 * Normalise any BCP-47-ish tag to one of LOCALES.
 * @param {string|undefined|null} tag raw locale tag ('pt_BR.UTF-8', 'en-US', …)
 * @returns {'en'|'pt-BR'|null} a supported locale, or null when the tag is unusable
 */
function normalize(tag) {
  if (typeof tag !== 'string') return null;
  const raw = tag.trim();
  if (!raw) return null;
  const base = raw.split('.')[0].split('@')[0];
  if (/^pt([-_]|$)/i.test(base)) return 'pt-BR';
  if (/^[a-z]{2}([-_]|$)/i.test(base)) return 'en';
  return null;
}

/**
 * Decide which locale to run in.
 * Precedence: --lang flag > CAM_LANG > LC_ALL > LC_MESSAGES > LANG > Intl > 'en'.
 * @param {{ env?: Record<string, string|undefined>, argv?: string[] }} [input] environment and argv
 * @returns {'en'|'pt-BR'} the resolved locale
 */
export function detectLocale(input = {}) {
  const env = input && input.env ? input.env : {};
  const argv = Array.isArray(input && input.argv) ? input.argv : [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a === '--lang' && i + 1 < argv.length) {
      const hit = normalize(argv[i + 1]);
      if (hit) return hit;
    } else if (a.startsWith('--lang=')) {
      const hit = normalize(a.slice('--lang='.length));
      if (hit) return hit;
    }
  }

  for (const name of ['CAM_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const hit = normalize(env[name]);
    if (hit) return hit;
  }

  try {
    const hit = normalize(Intl.DateTimeFormat().resolvedOptions().locale);
    if (hit) return hit;
  } catch {
    // small-icu builds have no usable Intl data; fall through to English.
  }

  return 'en';
}

/**
 * Interpolate {name} placeholders. An absent var is left in place on purpose,
 * so a wiring bug is visible in the output instead of silently blank.
 * @param {string} template the catalogue string
 * @param {Record<string, unknown>} vars interpolation values
 * @returns {string} the interpolated string
 */
function interpolate(template, vars) {
  if (template.indexOf('{') === -1) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined
      ? String(vars[name])
      : whole
  ));
}

/**
 * Build a bound translator for one locale.
 * @param {string} locale one of LOCALES; anything else falls back to 'en'
 * @returns {(key: string, vars?: Record<string, unknown>) => string} the translator
 */
export function createT(locale) {
  const primary = MESSAGES[locale] ? MESSAGES[locale] : MESSAGES.en;
  const fallback = MESSAGES.en;

  /**
   * Translate one key.
   * @param {string} key dot-namespaced catalogue key
   * @param {Record<string, unknown>} [vars] interpolation values
   * @returns {string} the translated string, or the key itself when unknown
   */
  return function t(key, vars = {}) {
    const bag = vars && typeof vars === 'object' ? vars : {};
    let value = Object.prototype.hasOwnProperty.call(primary, key) ? primary[key] : undefined;
    if (value === undefined) {
      value = Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key] : undefined;
    }
    if (value === undefined) {
      MISSING.add(key);
      return key;
    }
    if (typeof value === 'function') {
      try {
        return String(value(bag));
      } catch {
        MISSING.add(key);
        return key;
      }
    }
    return interpolate(String(value), bag);
  };
}

/**
 * Keys requested at runtime that the catalogue did not have.
 * @returns {string[]} sorted missing keys
 */
export function missingKeys() {
  return [...MISSING].sort();
}
