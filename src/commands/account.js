// src/commands/account.js — everything that creates, lists or removes an account.
// Owns `cam add` (section D of the switch algorithm), the first-run wizard,
// `cam ls`, `cam rm`, `cam restore`, `cam trash` and the three-key `cam config`.

import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { EXIT, fail } from '../ctx.js';
import * as fsx from '../fsx.js';
import * as profiles from '../profiles.js';
import * as claude from '../claude.js';
import * as credstore from '../credstore.js';
import * as shell from '../shell.js';
import * as tty from '../tty.js';
import * as ui from '../ui.js';
import * as screenMod from '../screen.js';

/** Settings cam owns, with their factory defaults. Exactly three, on purpose. */
const CONFIG_KEYS = Object.freeze(['ask', 'claudeBin', 'ascii']);
const CONFIG_DEFAULTS = Object.freeze({ ask: 'auto', claudeBin: null, ascii: false });
const ASK_VALUES = Object.freeze(['auto', 'always', 'never']);
/** Flags that consume the next token when written as `--flag value`. */
const VALUE_FLAGS = Object.freeze(['email', 'shell', 'lang']);
/** Width of the left-hand label column in the `cam add` check lines. */
const LABEL_COLS = 20;

// ── argument plumbing ───────────────────────────────────────────────────────

/**
 * Turn `--some-flag` into `someFlag` so flags read naturally in JS.
 * @param {string} name raw flag name without leading dashes
 * @returns {string} camelCased flag name
 */
function camel(name) {
  return String(name).replace(/-([a-zA-Z0-9])/g, (_whole, c) => c.toUpperCase());
}

/**
 * Parse a raw token list into positionals and flags.
 * @param {string[]} tokens argv slice belonging to this command
 * @returns {{ positional: string[], flags: Record<string, string|boolean> }} parsed arguments
 */
function parseTokens(tokens) {
  const positional = [];
  const flags = {};
  let literal = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (typeof tok !== 'string') continue;
    if (literal) { positional.push(tok); continue; }
    if (tok === '--') { literal = true; continue; }
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[camel(body.slice(0, eq))] = body.slice(eq + 1);
        continue;
      }
      if (body.startsWith('no-')) {
        flags[camel(body)] = true;
        flags[camel(body.slice(3))] = false;
        continue;
      }
      if (VALUE_FLAGS.includes(camel(body)) && i + 1 < tokens.length) {
        flags[camel(body)] = tokens[i + 1];
        i += 1;
        continue;
      }
      flags[camel(body)] = true;
      continue;
    }
    if (tok.length > 1 && tok.startsWith('-')) {
      for (const ch of tok.slice(1)) {
        if (ch === 'y') flags.yes = true;
        else if (ch === 'v') flags.verbose = true;
        else if (ch === 'j') flags.json = true;
        else flags[ch] = true;
      }
      continue;
    }
    positional.push(tok);
  }
  return { positional, flags };
}

/**
 * Accept either a raw argv slice or the object cli.js hands a command, so this
 * module works whichever shape the router passes.
 * @param {string[]|{camArgs?: string[], args?: string[], argv?: string[], positional?: string[], flags?: Record<string, unknown>}} args command arguments
 * @returns {{ positional: string[], flags: Record<string, any> }} parsed arguments
 */
function normalizeArgs(args) {
  if (Array.isArray(args)) return parseTokens(args);
  if (args && typeof args === 'object') {
    const tokens = Array.isArray(args.camArgs) ? args.camArgs
      : Array.isArray(args.args) ? args.args
        : Array.isArray(args.argv) ? args.argv
          : Array.isArray(args.positional) ? args.positional
            : [];
    const parsed = parseTokens(tokens);
    if (args.flags && typeof args.flags === 'object') {
      parsed.flags = { ...parsed.flags, ...args.flags };
    }
    return parsed;
  }
  return { positional: [], flags: {} };
}

// ── output plumbing ─────────────────────────────────────────────────────────

/**
 * Write one line to stdout (machine-readable output and data tables).
 * @param {any} ctx the injected context
 * @param {string} [text] the line, without a trailing newline
 * @returns {void}
 */
function out(ctx, text = '') {
  // `--ascii` promises 7-bit output; the table and summary lines here are
  // written straight to the stream, so they fold at the point of writing.
  ctx.io.out.write(`${ui.plain(text, tty.writeCaps(ctx, ctx.io.out))}\n`);
}

/**
 * Write one line to stderr (status, prompts and progress).
 * @param {any} ctx the injected context
 * @param {string} [text] the line, without a trailing newline
 * @returns {void}
 */
function err(ctx, text = '') {
  ctx.io.err.write(`${ui.plain(text, tty.writeCaps(ctx, ctx.io.err))}\n`);
}

/**
 * Render a ✓ / ! / ✗ / · status line for stderr.
 * @param {any} ctx the injected context
 * @param {any} caps terminal capabilities for the stderr stream
 * @param {'ok'|'warn'|'fail'|'info'} kind which marker to use
 * @param {string} text the already-translated message
 * @returns {void}
 */
function say(ctx, caps, kind, text) {
  err(ctx, ui.statusLine(kind, text, caps));
}

/**
 * Compose the two-column `label   detail` body of an `add` check line.
 * @param {string} label the short left-hand label
 * @param {string} detail the right-hand explanation
 * @returns {string} the padded line body
 */
function pair(label, detail) {
  return `${ui.padEnd(label, LABEL_COLS)}${detail}`;
}

/**
 * Apply the ascii fallback to text cam composed itself.
 * @param {any} caps terminal capabilities
 * @param {string} text text possibly containing box/marker glyphs
 * @returns {string} text safe for this terminal
 */
function glyphSafe(caps, text) {
  return caps && caps.ascii ? ui.asciify(text) : text;
}

/**
 * A full-width horizontal rule with a label in the middle, fitted to the
 * terminal — used to frame the handover to `claude auth login`.
 * @param {any} caps terminal capabilities
 * @param {string} [label] already-translated label, or '' for a plain rule
 * @returns {string} the rule
 */
function rule(caps, label = '') {
  const cols = Math.max(24, Math.min(Number(caps && caps.cols) || 78, 78));
  const text = label ? ` ${label} ` : '';
  const dashes = Math.max(2, cols - ui.width(text));
  const left = Math.floor(dashes / 2);
  return glyphSafe(caps, `${'─'.repeat(left)}${text}${'─'.repeat(dashes - left)}`);
}

// ── shared account helpers ──────────────────────────────────────────────────

/**
 * Read a profile's metadata whichever way the store nested it.
 * @param {any} profile a Profile from src/profiles.js
 * @returns {Record<string, any>} the metadata object (never null)
 */
function metaOf(profile) {
  if (!profile) return {};
  if (profile.meta && typeof profile.meta === 'object') return profile.meta;
  return profile;
}

/**
 * The email a profile signed in with, if it has one.
 * @param {any} profile a Profile
 * @returns {string|null} the email address or null
 */
function emailOf(profile) {
  const m = metaOf(profile);
  return m.email || m.emailAddress || profile.email || null;
}

/**
 * The organisation name a profile belongs to, if known.
 * @param {any} profile a Profile
 * @returns {string|null} the org name or null
 */
function orgOf(profile) {
  const m = metaOf(profile);
  return m.orgName || m.organizationName || null;
}

/**
 * The plan/subscription of a profile, as the raw Claude value.
 * @param {any} profile a Profile
 * @returns {string|null} 'max' | 'team' | … or null
 */
function planOf(profile) {
  const m = metaOf(profile);
  return m.plan || m.subscriptionType || null;
}

/**
 * The account uuid recorded for a profile, if any.
 * @param {any} profile a Profile
 * @returns {string|null} the account uuid or null
 */
function uuidOf(profile) {
  const m = metaOf(profile);
  return m.accountUuid || m.accountUUID || null;
}

/**
 * Milliseconds of the last launch of a profile.
 * @param {any} profile a Profile
 * @returns {number|null} epoch ms, or null when never used
 */
function lastUsedOf(profile) {
  const m = metaOf(profile);
  const v = m.lastUsedAt != null ? m.lastUsedAt : m.usedAt;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Decide which account a bare `claude` would use, for the ● marker in `cam ls`.
 * @param {any[]} accounts every account, `default` first
 * @param {string|null} last the name recorded in the `last` file
 * @returns {string|null} the active account name
 */
function activeName(accounts, last) {
  if (last && accounts.some((p) => p.name === last)) return last;
  const named = accounts.filter((p) => p.name !== 'default');
  if (named.length === 1) return named[0].name;
  return accounts.length ? accounts[0].name : null;
}

/**
 * Does this profile's directory still exist on disk?
 * @param {any} profile a Profile
 * @returns {Promise<boolean>} true when the folder is gone
 */
async function folderMissing(profile) {
  if (!profile || !profile.dir) return false;
  if (profile.missing === true || profile.exists === false) return true;
  try {
    const st = await stat(profile.dir);
    return !st.isDirectory();
  } catch {
    return true;
  }
}

/**
 * Translate a health status into a short, localised token-column cell.
 * @param {any} ctx the injected context
 * @param {{status: string, daysLeft: number|null}} h the result of profiles.health
 * @returns {string} the translated cell
 */
function healthCell(ctx, h) {
  const days = h && h.daysLeft != null ? Math.max(0, Math.round(h.daysLeft)) : 0;
  switch (h && h.status) {
    case 'ok': return ctx.t('health.okShort', { days });
    case 'warn': return ctx.t('health.warnShort', { days });
    case 'expired': return ctx.t('health.expired');
    case 'signedout': return ctx.t('health.signedout');
    default: return ctx.t('health.unknown');
  }
}

/**
 * Turn `profiles.validName`'s machine reason into a translated sentence.
 * @param {any} ctx the injected context
 * @param {string} name the name that failed validation
 * @param {string} reason the reason code from validName
 * @param {string} suggestion an alternative name to offer
 * @returns {string} the translated message
 */
function nameReason(ctx, name, reason, suggestion) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('empty') || r.includes('blank')) return ctx.t('add.nameEmpty');
  if (r.includes('reserv')) return ctx.t('add.nameReserved', { name });
  if (r.includes('long') || r.includes('max')) return ctx.t('add.nameTooLong');
  if (r.includes('start') || r.includes('lead') || r.includes('dot') || r.includes('dash')) {
    return ctx.t('add.nameStart');
  }
  if (r.includes('taken') || r.includes('exists')) {
    return ctx.t('add.nameTaken', { name, suggestion });
  }
  return ctx.t('add.nameChars');
}

/**
 * Validate one candidate account name against the store and the rules.
 * @param {any} ctx the injected context
 * @param {string} name the candidate
 * @param {string[]} taken names already in use
 * @returns {string|null} a translated error, or null when the name is good
 */
function checkName(ctx, name, taken) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return ctx.t('add.nameEmpty');
  const verdict = profiles.validName(trimmed);
  const suggestion = profiles.suggestName(trimmed, taken);
  if (verdict && verdict.ok === false) {
    return nameReason(ctx, trimmed, verdict.reason, suggestion);
  }
  if (taken.includes(trimmed)) {
    return ctx.t('add.nameTaken', { name: trimmed, suggestion });
  }
  return null;
}

/**
 * Coerce a seed/share result field into a list of item names.
 * @param {any} v an array of names, an array of records, or a count
 * @returns {string[]} the names, possibly empty
 */
function listOf(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x : (x && (x.name || x.item || x.path)) || ''))
    .filter(Boolean)
    .map((x) => basename(String(x)));
}

/**
 * Count a seed/share result field that may be a list or already a number.
 * @param {any} v an array or a count
 * @returns {number} how many items it represents
 */
function countOf(v) {
  if (Array.isArray(v)) return v.length;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Human-readable byte size. Units are symbols, not prose, so they are not translated.
 * @param {number} bytes the size in bytes
 * @returns {string} e.g. '84 MB'
 */
function formatSize(bytes) {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const rounded = value >= 10 || i === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/**
 * Build a screen when the terminal can take one, else null.
 * @param {any} ctx the injected context
 * @returns {{ screen: any, mode: {kind: string, reason: string} }} the screen (null when not interactive) and the interactivity verdict
 */
function openScreen(ctx) {
  const mode = tty.interactivity(ctx, { forwarded: [] });
  if (mode.kind === 'none') return { screen: null, mode };
  return { screen: screenMod.createScreen(ctx, { stream: ctx.io.err }), mode };
}

/**
 * Tear a screen down without ever masking the original failure.
 * @param {any} screen a Screen, or null
 * @returns {void}
 */
function closeScreen(screen) {
  if (!screen) return;
  try {
    screen.teardown();
  } catch {
    // teardown is best-effort; the cursor is also restored on process exit.
  }
}

/**
 * Is the `claude` shell hook installed anywhere?
 * @param {any} ctx the injected context
 * @returns {Promise<boolean>} true when at least one rc file carries the block
 */
async function hookInstalled(ctx) {
  try {
    const rows = await shell.status(ctx);
    if (!Array.isArray(rows)) return false;
    return rows.some((r) => r && (r.installed === true || r.state === 'installed' || r.action === 'installed'));
  } catch {
    return false;
  }
}

/**
 * Name every shell the hook was written for, for the "Installed for …" line.
 * @param {any[]} results the results of shell.install
 * @returns {string} a `·`-joined shell list
 */
function shellNames(results) {
  if (!Array.isArray(results)) return '';
  const names = results
    .map((r) => (r && (r.shell || r.id || r.name)) || '')
    .filter(Boolean);
  return [...new Set(names)].join(' · ');
}

/**
 * Offer to install the `claude` shell hook, and install it when accepted.
 * Shared by the first-run wizard and the tail of `cam add`.
 * @param {any} ctx the injected context
 * @param {any} screen an open Screen
 * @param {any} caps terminal capabilities for stderr
 * @returns {Promise<void>} resolves once the offer has been handled
 */
async function offerHook(ctx, screen, caps) {
  let targets = [];
  try {
    targets = await shell.detectTargets(ctx);
  } catch {
    targets = [];
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    say(ctx, caps, 'warn', ctx.t('shell.noTargets'));
    return;
  }
  const first = targets[0] || {};
  err(ctx, '');
  err(ctx, `  ${ctx.t('first.ask')} ${ctx.t('prompt.yesNo')}`);
  err(ctx, `    ${ctx.t('first.askDetail', { file: first.file || first.path || '' })}`);
  err(ctx, `    ${ctx.t('first.askUndo')}`);
  const yes = await screenMod.confirm(ctx, screen, {
    question: ctx.t('first.ask'),
    def: true,
  });
  if (yes !== true) {
    say(ctx, caps, 'info', ctx.t('first.skipped'));
    return;
  }
  let results = [];
  try {
    results = await shell.install(ctx, targets, { version: ctx.version, camBin: ctx.argv0 });
  } catch (e) {
    say(ctx, caps, 'fail', ctx.t('err.io', { file: first.file || first.path || '' }));
    if (ctx.verbose) err(ctx, `  ${ctx.t('err.hintLabel')}: ${String(e && e.message ? e.message : e)}`);
    return;
  }
  say(ctx, caps, 'ok', ctx.t('first.installed', { shells: shellNames(results) || ctx.t('shell.statusHeader') }));
  err(ctx, `  ${ctx.t('shell.reopen')}`);
  try {
    const clashes = await shell.conflicts(ctx);
    for (const c of Array.isArray(clashes) ? clashes : []) {
      if (!c) continue;
      if (c.kind === 'alias') say(ctx, caps, 'warn', ctx.t('first.aliasWarn', { shell: c.shell }));
      else say(ctx, caps, 'warn', ctx.t('shell.conflictFunction', { shell: c.shell, where: c.where }));
    }
  } catch {
    // conflict detection is advisory; never let it break the install report.
  }
}

// ── cam add ─────────────────────────────────────────────────────────────────

/**
 * Ask for (or accept) the account name. The name must be final BEFORE login:
 * on macOS the Keychain service is hashed from the profile path, so a
 * create-then-rename flow yields an account that is instantly signed out.
 * @param {any} ctx the injected context
 * @param {any} screen an open Screen, or null when not interactive
 * @param {string|null} given the positional name, if one was typed
 * @param {string[]} taken names already in use
 * @returns {Promise<string|null>} the final name, or null when cancelled
 */
async function resolveName(ctx, screen, given, taken) {
  if (given) {
    const problem = checkName(ctx, given, taken);
    if (problem) {
      fail('CONFLICT', problem, { hint: ctx.t('err.conflictHint', { name: given }) });
    }
    return String(given).trim();
  }
  if (!screen) {
    fail('USAGE', ctx.t('add.nameEmpty'), { hint: ctx.t('help.cmd.add') });
  }
  const initial = profiles.suggestName(null, taken);
  const answer = await screenMod.textPrompt(ctx, screen, {
    label: ctx.t('add.namePrompt'),
    initial,
    hint: ctx.t('add.nameHint'),
    validate: (value) => checkName(ctx, value, taken),
  });
  if (answer == null) return null;
  const trimmed = String(answer).trim();
  const problem = checkName(ctx, trimmed, taken);
  if (problem) {
    fail('CONFLICT', problem, { hint: ctx.t('err.conflictHint', { name: trimmed }) });
  }
  return trimmed;
}

/**
 * Print the refusal block for a machine where account isolation cannot be
 * PROVEN. The probe has three outcomes, not two — proven-isolated,
 * proven-shared, and "no readable status" — and only the middle one may be
 * described with add.unsafeBody, which states as observed fact that a throwaway
 * config directory reported SIGNED IN. Anything else the probe reported becomes
 * the body itself, so cam never claims an observation it did not make.
 * @param {any} ctx the injected context
 * @param {any} caps terminal capabilities for stderr
 * @param {string} detail what the isolation probe actually reported
 * @returns {void}
 */
function reportUnsafe(ctx, caps, detail) {
  const observed = typeof detail === 'string' && detail.trim() !== '' ? detail : null;
  const provenShared = observed === null || observed === ctx.t('doctor.isolationFail');
  const lines = [
    provenShared ? ctx.t('add.unsafeBody') : observed,
    '',
    pair(ctx.t('add.unsafeCause'), ctx.t('add.unsafeCauseDetail')),
    pair(ctx.t('add.unsafeTry'), ctx.t('add.unsafeTryDetail')),
    pair('', ctx.t('app.repo')),
  ];
  if (observed && provenShared && ctx.verbose) lines.push('', observed);
  const block = ui.errorBlock({ title: ctx.t('add.unsafeTitle'), lines }, caps);
  for (const line of block) err(ctx, line);
}

/**
 * Find an existing profile that is the same Claude account as the new one.
 * @param {any} ctx the injected context
 * @param {string} name the profile being created (excluded from the search)
 * @param {string|null} accountUuid the new profile's account uuid
 * @param {string|null} fingerprint the new profile's refresh-token fingerprint
 * @returns {Promise<any|null>} the duplicate profile, or null
 */
async function findDuplicate(ctx, name, accountUuid, fingerprint) {
  let existing = [];
  try {
    existing = await profiles.list(ctx);
  } catch {
    return null;
  }
  for (const p of existing) {
    if (!p || p.name === name || !p.dir) continue;
    const m = metaOf(p);
    if (accountUuid && uuidOf(p) && uuidOf(p) === accountUuid) return p;
    if (fingerprint && m.tokenFingerprint && m.tokenFingerprint === fingerprint) return p;
  }
  return null;
}

/**
 * Ask what to do about a duplicate account: keep both, replace, or cancel.
 * @param {any} ctx the injected context
 * @param {any} screen an open Screen, or null
 * @param {string} otherName the existing profile with the same account
 * @returns {Promise<'keep'|'replace'|'cancel'>} the user's choice
 */
async function askDuplicate(ctx, screen, otherName) {
  if (!screen) return 'keep';
  const answer = await screenMod.textPrompt(ctx, screen, {
    label: ctx.t('add.dupBody'),
    initial: '',
    hint: ctx.t('add.dupChoices', { name: otherName }),
    validate: (value) => {
      const c = String(value || '').trim().toLowerCase().slice(0, 1);
      return c === 'k' || c === 'r' || c === 'c' ? null : ctx.t('pick.invalid');
    },
  });
  if (answer == null) return 'cancel';
  const c = String(answer).trim().toLowerCase().slice(0, 1);
  if (c === 'r') return 'replace';
  if (c === 'c') return 'cancel';
  return 'keep';
}

/**
 * Create a new account: name it, prove isolation, build the profile directory
 * in place, hand the terminal to `claude auth login`, verify, and publish.
 * Any failure between the first mkdir and the final publish removes the whole
 * directory — there is no code path that leaves a tokenless profile visible.
 * @param {any} ctx the injected context
 * @param {string[]|object} args command arguments
 * @returns {Promise<number>} the process exit code
 */
export async function cmdAdd(ctx, args) {
  const { positional, flags } = normalizeArgs(args);
  const caps = tty.detectCaps(ctx, ctx.io.err);
  const { screen, mode } = openScreen(ctx);
  let created = null;

  try {
    err(ctx, ctx.t('add.title'));
    try {
      const swept = await profiles.sweepPending(ctx);
      if (Array.isArray(swept) && swept.length > 0) {
        say(ctx, caps, 'info', ctx.t('add.pendingSwept', { n: swept.length }));
      }
    } catch {
      // a failed sweep must never stop an add.
    }

    const existing = await profiles.list(ctx);
    const taken = existing.map((p) => p.name).filter(Boolean);
    const name = await resolveName(ctx, screen, positional[0] || null, taken);
    if (name == null) {
      say(ctx, caps, 'info', ctx.t('add.cancelled'));
      return EXIT.CANCELLED;
    }

    err(ctx, '');
    const bin = claude.requireClaude(ctx);

    // ── 2. isolation must be provable before a second account may exist ──
    const iso = await claude.verifyIsolation(ctx, { bin: bin.path, force: Boolean(flags.deep) });
    if (!iso || iso.ok !== true) {
      reportUnsafe(ctx, caps, iso ? iso.detail : null);
      return EXIT.UNSAFE;
    }
    say(ctx, caps, 'ok', pair(ctx.t('add.checkIsolation'), ctx.t('add.checkIsolationOk')));

    // ── 3. build in place; publish by removing the pending marker ────────
    const begun = await profiles.beginCreate(ctx, name);
    created = { name, dir: begun.dir };
    say(ctx, caps, 'ok', pair(ctx.t('add.checkFolder'), begun.dir));

    if (flags.seed !== false && flags.noSeed !== true) {
      const seeded = await profiles.seedConfig(ctx, begun.dir, {
        shareProjects: flags.shareProjects === true,
      });
      const paths = profiles.claudePaths(ctx, begun.dir);
      const cfg = await fsx.readJsonSafe(ctx, paths.configFile, null);
      const mcp = cfg && cfg.mcpServers && typeof cfg.mcpServers === 'object'
        ? Object.keys(cfg.mcpServers).length
        : countOf(seeded && seeded.mcpServers);
      say(ctx, caps, 'ok', pair(ctx.t('add.checkSeeded'), ctx.t('add.seededDetail', { n: mcp })));
    }

    // What was shared is published WITH the profile: `cam doctor` reads
    // meta.share to report it, so a record that never leaves this block makes
    // every profile look unshared. Left null by --no-share, which finishCreate
    // reads as "nothing shared".
    let share = null;
    if (flags.share !== false && flags.noShare !== true) {
      // seedShare's transcript switch is `projects`. The old `shareProjects`
      // key matched nothing there, so --share-projects printed its warning and
      // then shared no transcripts at all.
      const shared = await profiles.seedShare(ctx, begun.dir, {
        projects: flags.shareProjects === true,
      });
      const linked = listOf(shared && shared.linked);
      const copied = listOf(shared && shared.copied);
      const items = [...linked, ...copied].join(', ')
        || [...(profiles.SHARE_DIRS || []), ...(profiles.SHARE_FILES || [])].join(', ');
      // seedShare answers the generic 'link'; the catalogue names the platform
      // primitive, and only junction/symlink/copy/skip have a key.
      let mode = 'skip';
      if (linked.length > 0) mode = ctx.platform === 'win32' ? 'junction' : 'symlink';
      else if (copied.length > 0) mode = 'copy';
      const shareFiles = new Set(profiles.SHARE_FILES || []);
      share = {
        mode,
        dirs: [...linked, ...copied].filter((n) => !shareFiles.has(n)),
        files: copied.filter((n) => shareFiles.has(n)),
      };
      say(ctx, caps, 'ok', pair(ctx.t('add.checkShared'), ctx.t('add.sharedDetail', {
        items,
        mode: ctx.t(`share.mode.${mode}`),
      })));
    }

    say(ctx, caps, 'info', pair(ctx.t('add.notShared'), ctx.t('add.notSharedDetail')));
    if (flags.shareProjects === true) {
      say(ctx, caps, 'warn', ctx.t('add.shareProjectsWarn'));
    }

    // ── 4. tell the user what happens next, before yielding the terminal ─
    err(ctx, '');
    err(ctx, `  ${ctx.t('add.handoff')}`);
    err(ctx, `  ${ctx.t('add.handoffPrivacy')}`);
    err(ctx, '');

    // ── 5. hand over: no spinner, no raw mode, stdio fully inherited ─────
    if (screen) {
      try {
        screen.erase();
      } catch {
        // an erase failure must not stop the login.
      }
      closeScreen(screen);
    }
    err(ctx, rule(caps, ctx.t('add.authHeader')));
    const loginMode = flags.console ? 'console' : flags.sso ? 'sso' : flags.email ? 'email' : 'claudeai';
    const login = await claude.authLogin(ctx, {
      configDir: begun.dir,
      bin: bin.path,
      mode: loginMode,
      email: typeof flags.email === 'string' ? flags.email : undefined,
    });
    err(ctx, rule(caps));

    if (!login || login.exitCode !== 0) {
      say(ctx, caps, 'fail', ctx.t('add.failed', { code: login ? login.exitCode : 1 }));
      await profiles.abortCreate(ctx, name, { keep: flags.keep === true });
      say(ctx, caps, 'info', flags.keep === true
        ? ctx.t('add.kept', { dir: begun.dir })
        : ctx.t('add.removed', { dir: begun.dir }));
      err(ctx, `  ${ctx.t('add.nothingElse')}`);
      created = null;
      return EXIT.AUTH_FAILED;
    }

    // ── 6. verify: authStatus prints valid JSON even when it exits 1 ─────
    const status = await claude.authStatus(ctx, { configDir: begun.dir, bin: bin.path });
    if (!status || status.loggedIn !== true) {
      say(ctx, caps, 'fail', ctx.t('err.authFailed'));
      err(ctx, `  ${ctx.t('err.authFailedHint', { name })}`);
      await profiles.abortCreate(ctx, name, { keep: flags.keep === true });
      created = null;
      return EXIT.AUTH_FAILED;
    }
    if (!status.email) {
      say(ctx, caps, 'fail', ctx.t('add.noEmail'));
      await profiles.abortCreate(ctx, name, { keep: flags.keep === true });
      created = null;
      return EXIT.AUTH_FAILED;
    }

    const paths = profiles.claudePaths(ctx, begun.dir);
    const identity = await profiles.claudeIdentity(ctx, paths.configFile);
    const cred = await credstore.summary(ctx, begun.dir);
    const fingerprint = cred && typeof cred.fingerprint === 'string' ? cred.fingerprint : null;
    const accountUuid = (identity && identity.accountUuid) || null;

    // ── 7. one Claude account should not become two rows ─────────────────
    const dup = await findDuplicate(ctx, name, accountUuid, fingerprint);
    if (dup) {
      err(ctx, '');
      say(ctx, caps, 'warn', ctx.t('add.dupTitle', { name: dup.name }));
      const choice = await (async () => {
        const again = openScreen(ctx);
        try {
          return await askDuplicate(ctx, again.screen, dup.name);
        } finally {
          closeScreen(again.screen);
        }
      })();
      if (choice === 'cancel') {
        await profiles.abortCreate(ctx, name, { keep: flags.keep === true });
        created = null;
        say(ctx, caps, 'info', ctx.t('add.dupCancelled'));
        return EXIT.CANCELLED;
      }
      if (choice === 'replace') {
        await profiles.trashProfile(ctx, dup.name);
        say(ctx, caps, 'ok', ctx.t('add.dupReplaced', { name: dup.name }));
      } else {
        say(ctx, caps, 'info', ctx.t('add.dupKept'));
      }
    }

    // ── 8. on macOS the credential namespace must actually be distinct ───
    if (ctx.platform === 'darwin') {
      try {
        const service = credstore.keychainService(ctx, begun.dir);
        const defaults = profiles.defaultClaudePaths(ctx);
        const defService = credstore.keychainService(ctx, defaults.configDir);
        const present = await credstore.keychainHasItem(ctx, service);
        if (service === defService || present !== true) {
          say(ctx, caps, 'warn', ctx.t('add.keychainWarn'));
        }
      } catch {
        say(ctx, caps, 'warn', ctx.t('add.keychainWarn'));
      }
    }

    // ── 9. publish ───────────────────────────────────────────────────────
    const profile = await profiles.finishCreate(ctx, name, {
      accountUuid,
      email: status.email,
      emailAddress: status.email,
      orgId: status.orgId || null,
      orgName: status.orgName || null,
      organizationName: status.orgName || null,
      plan: status.subscriptionType || (identity && identity.subscriptionType) || null,
      subscriptionType: status.subscriptionType || null,
      seatTier: (identity && identity.seatTier) || null,
      backend: (cred && cred.backend) || null,
      expiresAt: (cred && cred.expiresAt) || null,
      refreshTokenExpiresAt: (cred && cred.refreshTokenExpiresAt) || null,
      tokenFingerprint: fingerprint,
      share,
    });
    created = null;
    await profiles.setLast(ctx, name);

    const org = status.orgName ? ` · ${status.orgName}` : '';
    const plan = ui.planLabel(status.subscriptionType);
    err(ctx, '');
    say(ctx, caps, 'ok', pair(ctx.t('add.signedIn'), `${status.email}${org} · ${plan}`));
    say(ctx, caps, 'ok', pair(ctx.t('add.credentials'), ctx.t('add.credentialsDetail')));
    say(ctx, caps, 'ok', ctx.t('add.savedAs', { name: (profile && profile.name) || name }));
    err(ctx, '');
    err(ctx, `  ${ui.padEnd(ctx.t('add.next'), 7)}${ui.padEnd('claude', 20)}${ctx.t('add.nextPick')}`);
    err(ctx, `  ${ui.padEnd('', 7)}${ui.padEnd(`cam use ${name}`, 20)}${ctx.t('add.nextUse')}`);

    if (mode.kind !== 'none' && !(await hookInstalled(ctx))) {
      const again = openScreen(ctx);
      try {
        if (again.screen) await offerHook(ctx, again.screen, caps);
      } finally {
        closeScreen(again.screen);
      }
    }
    return EXIT.OK;
  } catch (e) {
    if (created) {
      try {
        await profiles.abortCreate(ctx, created.name, { keep: flags.keep === true });
        say(ctx, caps, 'info', flags.keep === true
          ? ctx.t('add.kept', { dir: created.dir })
          : ctx.t('add.removed', { dir: created.dir }));
      } catch {
        // rollback is best-effort; the original error is what matters.
      }
      created = null;
    }
    throw e;
  } finally {
    closeScreen(screen);
  }
}

// ── first run ───────────────────────────────────────────────────────────────

/**
 * The welcome wizard: explain that the existing Claude Code login is untouched,
 * offer the shell hook, and point at `cam add`. Never runs without a terminal.
 * @param {any} ctx the injected context
 * @returns {Promise<number>} the process exit code
 */
export async function firstRun(ctx) {
  const caps = tty.detectCaps(ctx, ctx.io.err);
  const mode = tty.interactivity(ctx, { forwarded: [] });
  if (mode.kind === 'none') {
    fail('NO_ACCOUNTS', ctx.t('err.noAccounts'), { hint: ctx.t('err.noAccountsHint') });
  }

  const base = await profiles.defaultProfile(ctx);
  const email = base ? emailOf(base) : null;
  if (!base || !email) {
    say(ctx, caps, 'warn', ctx.t('first.noLogin'));
    err(ctx, `  ${ctx.t('first.noLoginHint')}`);
    return EXIT.NO_ACCOUNTS;
  }

  const block = ui.errorBlock({
    title: ctx.t('first.title'),
    lines: [
      ctx.t('first.already'),
      '',
      `     ${ctx.t('first.identity', { email, plan: ui.planLabel(planOf(base)) })}`,
      '',
      ctx.t('first.stays'),
    ],
  }, caps);
  for (const line of block) err(ctx, line);

  const screen = screenMod.createScreen(ctx, { stream: ctx.io.err });
  try {
    await offerHook(ctx, screen, caps);
  } finally {
    closeScreen(screen);
  }

  err(ctx, '');
  err(ctx, `  ${ui.padEnd(ctx.t('first.next'), 7)}${ui.padEnd('cam add', 12)}${ctx.t('first.nextAdd')}`);
  err(ctx, `  ${ui.padEnd('', 7)}${ui.padEnd('claude', 12)}${ctx.t('first.nextClaude')}`);
  return EXIT.OK;
}

// ── cam ls ──────────────────────────────────────────────────────────────────

/**
 * List every account as an aligned table on stdout, or as JSON with `--json`.
 * No token material is ever emitted, in either format.
 * @param {any} ctx the injected context
 * @param {string[]|object} args command arguments
 * @returns {Promise<number>} the process exit code
 */
export async function cmdList(ctx, args) {
  const { flags } = normalizeArgs(args);
  const caps = tty.detectCaps(ctx, ctx.io.out);
  const accounts = await profiles.all(ctx);
  const last = await profiles.getLast(ctx);
  const active = activeName(accounts, last);
  const now = ctx.now();
  const store = profiles.storePaths(ctx);

  const rows = [];
  for (const p of accounts) {
    const meta = metaOf(p);
    const missing = await folderMissing(p);
    const mail = emailOf(p);
    const h = profiles.health(meta, now);
    rows.push({
      profile: p,
      missing,
      health: h,
      email: missing ? ctx.t('list.folderMissing') : (mail || ctx.t('list.signedOut')),
      plan: planOf(p) ? ui.planLabel(planOf(p)) : ctx.t('plan.unknown'),
      org: orgOf(p) || ctx.t('plan.unknown'),
      token: p.dir === null ? ctx.t('health.unknown') : healthCell(ctx, h),
      lastUsed: lastUsedOf(p) ? ui.relativeTime(lastUsedOf(p), now, ctx.t) : ctx.t('list.never'),
    });
  }

  if (flags.json === true) {
    const payload = {
      accounts: rows.map((r) => {
        const p = r.profile;
        const meta = metaOf(p);
        return {
          name: p.name,
          dir: p.dir || null,
          active: p.name === active,
          missing: r.missing,
          email: emailOf(p) || null,
          orgId: meta.orgId || null,
          orgName: orgOf(p) || null,
          plan: planOf(p) || null,
          backend: meta.backend || null,
          health: {
            status: r.health ? r.health.status : 'unknown',
            daysLeft: r.health && r.health.daysLeft != null ? r.health.daysLeft : null,
            asOf: meta.checkedAt || null,
          },
          createdAt: meta.createdAt || null,
          lastUsedAt: lastUsedOf(p),
          launchCount: typeof meta.launchCount === 'number' ? meta.launchCount : 0,
        };
      }),
      active,
      root: store.root,
    };
    out(ctx, JSON.stringify(payload, null, 2));
    return EXIT.OK;
  }

  if (rows.length === 0) {
    out(ctx, ctx.t('list.empty'));
    return EXIT.OK;
  }

  const marker = glyphSafe(caps, '● ');
  const blank = ' '.repeat(ui.width(marker));
  const table = ui.buildTable({
    columns: [
      { key: 'account', label: ctx.t('list.col.account') },
      { key: 'email', label: ctx.t('list.col.email') },
      { key: 'plan', label: ctx.t('list.col.plan') },
      { key: 'org', label: ctx.t('list.col.org') },
      { key: 'token', label: ctx.t('list.col.token') },
      { key: 'lastUsed', label: ctx.t('list.col.lastUsed') },
    ],
    rows: rows.map((r) => ({
      account: `${r.profile.name === active ? marker : blank}${r.profile.name}`,
      email: r.email,
      plan: r.plan,
      org: r.org,
      token: r.token,
      lastUsed: r.lastUsed,
    })),
  }, caps);
  for (const line of table) out(ctx, line);
  out(ctx, '');
  out(ctx, ctx.t('list.footer', { n: rows.length, root: store.root }));
  out(ctx, ctx.t('list.tokenNote'));
  return EXIT.OK;
}

// ── cam rm ──────────────────────────────────────────────────────────────────

/**
 * Quarantine an account: rename its directory into trash/, never recursively
 * delete it, because a recursive delete can follow a shared junction out of
 * the store and into the user's real ~/.claude.
 * @param {any} ctx the injected context
 * @param {string[]|object} args command arguments
 * @returns {Promise<number>} the process exit code
 */
export async function cmdRemove(ctx, args) {
  const { positional, flags } = normalizeArgs(args);
  const caps = tty.detectCaps(ctx, ctx.io.err);
  const name = positional[0];
  if (!name) {
    fail('USAGE', ctx.t('err.usage'), { hint: ctx.t('rm.usage') });
  }
  if (name === 'default') {
    // The same refusal in credstore.remove is UNSAFE with err.unsafeHint; a
    // shell-install usage line was never a remedy for "you cannot remove this".
    // Not err.unsafeHint ("run: cam doctor") — nothing about this machine is
    // wrong. The remedy is to name one of the accounts cam actually created.
    fail('UNSAFE', ctx.t('rm.refuseDefault'), { hint: ctx.t('rm.refuseDefaultHint') });
  }

  const all = await profiles.all(ctx);
  const profile = await profiles.get(ctx, name);
  if (!profile || !profile.dir) {
    fail('NOT_FOUND', ctx.t('err.notFound', { name }), {
      hint: ctx.t('err.notFoundHint', { names: all.map((p) => p.name).join(', ') }),
    });
  }

  const now = ctx.now();
  const used = lastUsedOf(profile);
  err(ctx, ui.statusLine('warn', ctx.t('rm.confirmHead', {
    name: profile.name,
    email: emailOf(profile) || ctx.t('list.signedOut'),
    plan: ui.planLabel(planOf(profile)),
    when: used ? ui.relativeTime(used, now, ctx.t) : ctx.t('time.never'),
  }), caps));
  err(ctx, `  ${ctx.t('rm.explain')}`);
  err(ctx, `  ${ctx.t('rm.notRevoked')}`);
  if (flags.purge === true) err(ctx, `  ${ctx.t('rm.purgeWarn')}`);

  const { screen, mode } = openScreen(ctx);
  try {
    if (flags.yes !== true) {
      if (mode.kind === 'none' || !screen) {
        fail('USAGE', ctx.t('rm.needsConfirm'), { hint: ctx.t('rm.usage') });
      }
      const ok = await screenMod.confirm(ctx, screen, {
        question: ctx.t('rm.typeName', { name: profile.name }),
        def: false,
        typed: profile.name,
      });
      if (ok !== true) {
        say(ctx, caps, 'info', ok === false ? ctx.t('rm.mismatch') : ctx.t('rm.cancelled'));
        return EXIT.CANCELLED;
      }
    }
  } finally {
    closeScreen(screen);
  }

  const originalDir = profile.dir;
  const { trashPath } = await profiles.trashProfile(ctx, profile.name);
  say(ctx, caps, 'ok', ctx.t('rm.done', { id: basename(trashPath) }));
  err(ctx, `  ${ctx.t('rm.undo', { name: profile.name })}`);

  if (flags.purge === true) {
    const counts = await fsx.purgeTree(ctx, trashPath);
    say(ctx, caps, 'ok', ctx.t('rm.purged', {
      name: profile.name,
      files: counts && counts.files != null ? counts.files : 0,
      links: counts && counts.links != null ? counts.links : 0,
    }));
    if (ctx.platform === 'darwin') {
      try {
        const gone = await credstore.remove(ctx, originalDir);
        if (gone === true) say(ctx, caps, 'ok', ctx.t('rm.keychainRemoved'));
      } catch {
        // the profile is already gone; a keychain leftover is a doctor finding.
      }
    }
  }
  return EXIT.OK;
}

// ── cam restore ─────────────────────────────────────────────────────────────

/**
 * Bring a quarantined profile back to its ORIGINAL path — which is what makes
 * a macOS Keychain item, whose service is hashed from that path, resolve again.
 * @param {any} ctx the injected context
 * @param {string[]|object} args command arguments
 * @returns {Promise<number>} the process exit code
 */
export async function cmdRestore(ctx, args) {
  const { positional } = normalizeArgs(args);
  const caps = tty.detectCaps(ctx, ctx.io.err);
  const name = positional[0];
  if (!name) {
    fail('USAGE', ctx.t('err.usage'), { hint: ctx.t('restore.usage') });
  }

  const entries = await profiles.listTrash(ctx);
  const hit = (Array.isArray(entries) ? entries : []).find((e) => e && e.name === name);
  if (!hit) {
    fail('NOT_FOUND', ctx.t('restore.notInTrash', { name }), { hint: ctx.t('trash.usage') });
  }

  const clash = await profiles.get(ctx, name);
  if (clash && clash.dir) {
    fail('CONFLICT', ctx.t('restore.occupied', { name }), {
      hint: ctx.t('err.conflictHint', { name }),
    });
  }

  const restored = await profiles.restoreProfile(ctx, name);
  say(ctx, caps, 'ok', ctx.t('restore.done', {
    name: (restored && restored.name) || name,
    dir: (restored && restored.dir) || join(profiles.storePaths(ctx).profilesDir, name),
  }));
  return EXIT.OK;
}

// ── cam trash ───────────────────────────────────────────────────────────────

/**
 * List quarantined profiles, or purge them all with the link-safe walk.
 * @param {any} ctx the injected context
 * @param {string[]|object} args command arguments
 * @returns {Promise<number>} the process exit code
 */
export async function cmdTrash(ctx, args) {
  const { flags } = normalizeArgs(args);
  const capsOut = tty.detectCaps(ctx, ctx.io.out);
  const capsErr = tty.detectCaps(ctx, ctx.io.err);
  const store = profiles.storePaths(ctx);
  const entries = await profiles.listTrash(ctx);
  const rows = Array.isArray(entries) ? entries : [];
  const now = ctx.now();

  if (flags.empty === true) {
    if (rows.length === 0) {
      say(ctx, capsErr, 'info', ctx.t('trash.empty'));
      return EXIT.OK;
    }
    const { screen, mode } = openScreen(ctx);
    try {
      if (flags.yes !== true) {
        if (mode.kind === 'none' || !screen) {
          fail('USAGE', ctx.t('rm.needsConfirm'), { hint: ctx.t('trash.usage') });
        }
        const ok = await screenMod.confirm(ctx, screen, {
          question: ctx.t('trash.confirmEmpty'),
          def: false,
        });
        if (ok !== true) {
          say(ctx, capsErr, 'info', ctx.t('rm.cancelled'));
          return EXIT.CANCELLED;
        }
      }
    } finally {
      closeScreen(screen);
    }
    let purged = 0;
    for (const e of rows) {
      await profiles.purgeTrash(ctx, e.id || e.name);
      purged += 1;
    }
    say(ctx, capsErr, 'ok', ctx.t('trash.emptied', { n: purged }));
    return EXIT.OK;
  }

  if (rows.length === 0) {
    out(ctx, ctx.t('trash.empty'));
    return EXIT.OK;
  }

  const table = ui.buildTable({
    columns: [
      { key: 'name', label: ctx.t('trash.col.name') },
      { key: 'size', label: ctx.t('trash.col.size') },
      { key: 'age', label: ctx.t('trash.col.age') },
    ],
    rows: rows.map((e) => ({
      name: e.id || e.name,
      size: formatSize(e.size),
      // listTrash names the timestamp removedAt; reading any other key made
      // every row print "never" and left the column useless.
      age: typeof e.removedAt === 'number'
        ? ui.relativeTime(e.removedAt, now, ctx.t)
        : ctx.t('time.never'),
    })),
  }, capsOut);
  for (const line of table) out(ctx, line);
  out(ctx, '');
  out(ctx, ctx.t('trash.footer', { n: rows.length, dir: store.trashDir }));
  return EXIT.OK;
}

// ── cam config ──────────────────────────────────────────────────────────────

/**
 * Render a config value for display, translating "unset".
 * @param {any} ctx the injected context
 * @param {any} value the stored value
 * @returns {string} a printable cell
 */
function configCell(ctx, value) {
  if (value === null || value === undefined || value === '') return ctx.t('plan.unknown');
  return String(value);
}

/**
 * Validate and coerce one config value.
 * @param {any} ctx the injected context
 * @param {string} key one of ask | claudeBin | ascii
 * @param {string} raw the value as typed
 * @returns {Promise<any>} the coerced value (null clears the key)
 */
async function coerceConfig(ctx, key, raw) {
  const value = String(raw);
  if (key === 'ask') {
    const v = value.trim().toLowerCase();
    if (!ASK_VALUES.includes(v)) {
      fail('USAGE', ctx.t('config.invalidValue', { value, key }), { hint: ctx.t('config.askValues') });
    }
    return v;
  }
  if (key === 'ascii') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return fail('USAGE', ctx.t('config.invalidValue', { value, key }), { hint: ctx.t('config.boolValues') });
  }
  if (key === 'claudeBin') {
    const v = value.trim();
    if (v === '' || v === '-' || v.toLowerCase() === 'null') return null;
    let isFile = false;
    try {
      const st = await stat(v);
      isFile = st.isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      return fail('USAGE', ctx.t('config.binMissing', { path: v }), { hint: ctx.t('config.usage') });
    }
    return v;
  }
  return fail('USAGE', ctx.t('config.unknownKey', { key }), { hint: ctx.t('config.validKeys') });
}

/**
 * Read or change the three settings cam owns: ask, claudeBin and ascii.
 * @param {any} ctx the injected context
 * @param {string[]|object} args command arguments
 * @returns {Promise<number>} the process exit code
 */
export async function cmdConfig(ctx, args) {
  const { positional } = normalizeArgs(args);
  const capsOut = tty.detectCaps(ctx, ctx.io.out);
  const capsErr = tty.detectCaps(ctx, ctx.io.err);
  const cfg = await profiles.loadConfig(ctx);
  const [key, ...rest] = positional;

  if (!key) {
    const table = ui.buildTable({
      columns: [
        { key: 'name', label: ctx.t('config.col.key') },
        { key: 'value', label: ctx.t('config.col.value') },
        { key: 'def', label: ctx.t('config.col.default') },
      ],
      rows: CONFIG_KEYS.map((k) => ({
        name: k,
        value: configCell(ctx, cfg ? cfg[k] : undefined),
        def: configCell(ctx, CONFIG_DEFAULTS[k]),
      })),
    }, capsOut);
    for (const line of table) out(ctx, line);
    out(ctx, '');
    out(ctx, `${ui.padEnd('ask', 12)}${ctx.t('config.desc.ask')}`);
    out(ctx, `${ui.padEnd('claudeBin', 12)}${ctx.t('config.desc.claudeBin')}`);
    out(ctx, `${ui.padEnd('ascii', 12)}${ctx.t('config.desc.ascii')}`);
    return EXIT.OK;
  }

  if (!CONFIG_KEYS.includes(key)) {
    fail('USAGE', ctx.t('config.unknownKey', { key }), { hint: ctx.t('config.validKeys') });
  }

  if (rest.length === 0) {
    out(ctx, ctx.t('config.set', { key, value: configCell(ctx, cfg ? cfg[key] : undefined) }));
    return EXIT.OK;
  }

  const value = await coerceConfig(ctx, key, rest.join(' '));
  const next = { ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  if (value === null) delete next[key];
  else next[key] = value;
  await profiles.saveConfig(ctx, next);

  if (value === null) {
    say(ctx, capsErr, 'ok', ctx.t('config.cleared', { key }));
    return EXIT.OK;
  }
  if (key === 'claudeBin' && ctx.platform === 'win32' && /\.cmd$/i.test(String(value))) {
    // A .cmd is accepted; runInherit routes it through ComSpec.
    say(ctx, capsErr, 'info', ctx.t('config.binCmdWarn'));
  }
  say(ctx, capsErr, 'ok', ctx.t('config.set', { key, value: String(value) }));
  return EXIT.OK;
}
