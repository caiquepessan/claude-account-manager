// src/commands/launch.js — the hot path a bare `claude` exercises: resolve an
// account, optionally ask, sanitize the child environment, spawn the real CLI.
// Also owns the four read-only answers to "what will happen, and why".

import { basename, extname } from 'node:path';
import {
  EXIT,
  fail,
  HOSTILE_ENV,
  dropCamPins,
  envValue,
  sanitizeChildEnv as sanitizeChildEnvFallback,
  describeAmbient as describeAmbientFallback
} from '../ctx.js';
import * as profiles from '../profiles.js';
import * as claude from '../claude.js';
import * as tty from '../tty.js';
import * as ui from '../ui.js';
import * as screen from '../screen.js';

/** The sentinel `cli.splitArgs` returns for a bare `--cam` with no value. */
const ASK_SENTINEL = ' ask';

/** cam flags that consume the next argv item as their value. */
const VALUE_FLAGS = new Set(['cam', 'shell', 'ask', 'email', 'lang', 'claudeBin']);

/** Shell id (from `shell.currentShell`) to the four quoting families. */
const SHELL_FAMILY = Object.freeze({
  sh: 'posix',
  bash: 'posix',
  zsh: 'posix',
  ksh: 'posix',
  dash: 'posix',
  ash: 'posix',
  posix: 'posix',
  'git-bash': 'posix',
  fish: 'fish',
  powershell: 'powershell',
  pwsh: 'powershell',
  'powershell.exe': 'powershell',
  'pwsh.exe': 'powershell',
  cmd: 'cmd',
  'cmd.exe': 'cmd'
});

/** Label width of the `cam which -v` detail block. */
const WHICH_LABEL = 14;

// ── small local helpers ────────────────────────────────────────────────

/**
 * Write one line to stdout.
 * @param {object} ctx the injected context
 * @param {string} text the line, without a trailing newline
 * @returns {void}
 */
function out(ctx, text) {
  // `--ascii` promises 7-bit output, and these one-line summaries bypass the
  // frame builders that would otherwise fold them, so they fold here.
  ctx.io.out.write(`${ui.plain(text, tty.writeCaps(ctx, ctx.io.out))}\n`);
}

/**
 * Write one line to stderr, where every human-facing notice belongs so that
 * `claude -p x | jq` keeps a byte-clean stdout.
 * @param {object} ctx the injected context
 * @param {string} text the line, without a trailing newline
 * @returns {void}
 */
function note(ctx, text) {
  ctx.io.err.write(`${ui.plain(text, tty.writeCaps(ctx, ctx.io.err))}\n`);
}

/**
 * Write a `!` status line to stderr.
 * @param {object} ctx the injected context
 * @param {object} caps terminal capabilities from `tty.detectCaps`
 * @param {string} text the already-translated message
 * @returns {void}
 */
function warnLine(ctx, caps, text) {
  ctx.io.err.write(`${ui.statusLine('warn', text, caps)}\n`);
}

/**
 * Emit a debug line only under `--verbose`.
 * @param {object} ctx the injected context
 * @param {string} text the message
 * @returns {void}
 */
function debug(ctx, text) {
  if (ctx.verbose) ctx.io.err.write(`${ctx.t('launch.prefix')} ${text}\n`);
}

/**
 * Translate a value that may already be a sentence or may be a catalogue key.
 * Sibling modules are free to hand back either; this keeps both correct.
 * @param {object} ctx the injected context
 * @param {unknown} value a translated string, a dotted i18n key, or nothing
 * @returns {string} the display string
 */
function maybeT(ctx, value) {
  if (typeof value !== 'string' || value === '') return '';
  if (/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/.test(value)) return ctx.t(value);
  return value;
}

/**
 * Read the reason string a `tty.interactivity` result carries.
 * @param {object} ctx the injected context
 * @param {unknown} reason the raw reason
 * @returns {string} the display string
 */
function reasonText(ctx, reason) {
  return maybeT(ctx, reason);
}

/**
 * Truthiness for environment switches: `1`, `true`, `yes`, `on`.
 * @param {unknown} value the raw environment value
 * @returns {boolean} whether it reads as enabled
 */
function isTruthy(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Look a boolean flag up under several spellings (`--keep-env`, `keepEnv`).
 * @param {Record<string, unknown>} flags the parsed flag bag
 * @param {...string} names spellings to try
 * @returns {boolean} whether any spelling is set
 */
function flagOn(flags, ...names) {
  for (const name of names) {
    const v = flags[name];
    if (v === true || v === 1) return true;
    if (typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false') return true;
  }
  return false;
}

/**
 * Normalise an `ask` setting from any source.
 * @param {unknown} value the raw value
 * @returns {'auto'|'always'|'never'|null} the setting, or null when absent
 */
function normalizeAsk(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return v === 'auto' || v === 'always' || v === 'never' ? v : null;
}

/**
 * Parse cam's own arguments into flags and positionals.
 * @param {string[]} list the argv slice that belongs to cam
 * @returns {{ flags: Record<string, unknown>, positionals: string[] }} parsed argv
 */
function parseCamArgs(list) {
  const flags = {};
  const positionals = [];
  const items = Array.isArray(list) ? list : [];
  for (let i = 0; i < items.length; i += 1) {
    const arg = items[i];
    if (typeof arg !== 'string' || arg === '' || arg === '--') continue;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) {
        flags[name] = arg.slice(eq + 1);
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
        const next = items[i + 1];
        if (typeof next === 'string' && next !== '' && !next.startsWith('-')) {
          flags[name] = next;
          i += 1;
        } else {
          flags[name] = true;
        }
        continue;
      }
      flags[name] = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) {
        if (ch === 'v') flags.verbose = true;
        else if (ch === 'h') flags.help = true;
        else if (ch === 'y') flags.yes = true;
        else flags[ch] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}

/**
 * Accept either the object `cli.splitArgs` produces or a raw argv array, so a
 * command can be driven from the registry and from a test with equal ease.
 * @param {object|string[]} args the command arguments
 * @returns {{ camArgs: string[], forwarded: string[], camName: string|null, flags: Record<string, unknown>, positionals: string[] }} normalised arguments
 */
function readArgs(args) {
  if (Array.isArray(args)) {
    const camArgs = [];
    const forwarded = [];
    let split = false;
    for (const item of args) {
      if (!split && item === '--') {
        split = true;
        continue;
      }
      (split ? forwarded : camArgs).push(item);
    }
    const parsed = parseCamArgs(camArgs);
    let camName = null;
    if (parsed.flags.cam === true) camName = ASK_SENTINEL;
    else if (typeof parsed.flags.cam === 'string') camName = parsed.flags.cam;
    return { camArgs, forwarded, camName, flags: parsed.flags, positionals: parsed.positionals };
  }
  const bag = args && typeof args === 'object' ? args : {};
  const camArgs = Array.isArray(bag.camArgs) ? bag.camArgs : [];
  const parsed = parseCamArgs(camArgs);
  const flags = { ...parsed.flags, ...(bag.flags && typeof bag.flags === 'object' ? bag.flags : {}) };
  let camName = typeof bag.camName === 'string' && bag.camName !== '' ? bag.camName : null;
  if (camName === null && flags.cam === true) camName = ASK_SENTINEL;
  else if (camName === null && typeof flags.cam === 'string' && flags.cam !== '') camName = flags.cam;
  let positionals = parsed.positionals.length
    ? parsed.positionals
    : (Array.isArray(bag.positionals) ? bag.positionals : []);
  // A registry that hands the verb back inside camArgs must not turn it into
  // an account name: `cam use work` may arrive as ['use','work'].
  if (typeof bag.cmd === 'string' && positionals[0] === bag.cmd) positionals = positionals.slice(1);
  return {
    camArgs,
    forwarded: Array.isArray(bag.forwarded) ? bag.forwarded : [],
    camName,
    flags,
    positionals
  };
}

/**
 * Build the child environment, preferring the sanitizer hung on ctx.
 * The pin sweep is finished here rather than in the sanitizer: the reserved
 * `default` account returns its environment byte-for-byte, which is deliberate
 * for the user's own CLAUDE_* variables but not for cam's own CAM_PROFILE /
 * CAM_ACCOUNT / CAM_TTY — a nested `claude` inheriting one of those resolves to
 * a DIFFERENT account than the session it was started from.
 * @param {object} ctx the injected context
 * @param {{ profile: object, keepEnv?: boolean }} opts the profile and keep-env switch
 * @returns {{ env: Record<string, string|undefined>, stripped: object[], notes: unknown[], kept: object[] }} the sanitised result
 */
function sanitize(ctx, opts) {
  const fn = typeof ctx.sanitizeChildEnv === 'function' ? ctx.sanitizeChildEnv : sanitizeChildEnvFallback;
  const result = fn(ctx, opts) || {};
  const env = result.env && typeof result.env === 'object' ? result.env : { ...ctx.env };
  dropCamPins(ctx, env);
  return {
    env,
    stripped: Array.isArray(result.stripped) ? result.stripped : [],
    notes: Array.isArray(result.notes) ? result.notes : [],
    kept: Array.isArray(result.kept) ? result.kept : []
  };
}

/**
 * Describe the ambient CLAUDE_* variables, preferring the ctx-hung version.
 * @param {object} ctx the injected context
 * @returns {Array<{ name: string, present: boolean, impact?: string, hostile?: boolean }>} one row per known variable
 */
function ambientRows(ctx) {
  const fn = typeof ctx.describeAmbient === 'function' ? ctx.describeAmbient : describeAmbientFallback;
  const rows = fn(ctx);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Find the documented impact of a hostile variable by name.
 * @param {object} ctx the injected context
 * @param {string} name the environment variable name
 * @returns {string} the translated impact clause, or an empty string
 */
function impactFor(ctx, name) {
  const list = Array.isArray(HOSTILE_ENV) ? HOSTILE_ENV : [];
  const hit = list.find((h) => h && h.name === name);
  return hit ? maybeT(ctx, hit.impact) : '';
}

/**
 * Identity line for a profile: `name · email · plan`, degrading gracefully.
 * @param {object} ctx the injected context
 * @param {object} profile the profile
 * @returns {string} the one-line identity
 */
function identityLine(ctx, profile) {
  const meta = (profile && profile.meta) || {};
  const email = meta.email || meta.emailAddress || '';
  const rawPlan = meta.plan || meta.subscriptionType || '';
  const plan = rawPlan ? ui.planLabel(rawPlan) : '';
  const name = profile ? profile.name : '';
  if (email && plan) return ctx.t('launch.banner', { name, email, plan });
  if (plan) return ctx.t('launch.bannerNoEmail', { name, plan });
  return ctx.t('launch.bannerPlain', { name });
}

/**
 * Whether the caller named an account outright, by flag or by environment.
 * @param {object} ctx the injected context
 * @param {string|null} camName the value `cli.splitArgs` extracted from --cam
 * @returns {boolean} true when the account was chosen explicitly
 */
function namedExplicitly(ctx, camName) {
  if (typeof camName === 'string' && camName !== '' && camName !== ASK_SENTINEL) return true;
  return ['CAM_PROFILE', 'CAM_ACCOUNT'].some((n) => envText(ctx, n) !== null);
}

/**
 * Read a cam switch out of the environment, case-insensitively on Windows.
 * `ctx.env` is a plain copy of the real environment, so a lower-cased
 * `cam_profile` — the same variable to Windows — is invisible to `ctx.env.X`.
 * @param {object} ctx the injected context
 * @param {string} name the canonical variable name
 * @returns {string|null} the trimmed value, or null when unset or blank
 */
function envText(ctx, name) {
  const raw = envValue(ctx, name);
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value === '' ? null : value;
}

/**
 * Join the short reason and its detail into one sentence. Either half may be
 * empty — there is no catalogue key yet for "the first account on the list", and
 * an empty half must not render as a stray `(…)` or a leading separator.
 * @param {string} short the headline reason
 * @param {string} detail the parenthesised elaboration
 * @returns {string} the joined reason, possibly empty
 */
function joinReason(short, detail) {
  if (short && detail) return `${short} (${detail})`;
  return short || detail || '';
}

/**
 * Health of a profile, never throwing on a malformed meta file.
 * @param {object} profile the profile
 * @param {number} now the injected clock reading
 * @returns {{ status: string, label: string, daysLeft: number|null }} the health verdict
 */
function safeHealth(profile, now) {
  try {
    const h = profiles.health((profile && profile.meta) || null, now);
    if (h && typeof h.status === 'string') return h;
  } catch {
    // a cached number must never be able to break a launch
  }
  return { status: 'unknown', label: '', daysLeft: null };
}

/**
 * Decide what a picker returned: a profile, the add row, or a cancel.
 * @param {unknown} item whatever `screen.pick` resolved to
 * @param {object[]} accounts the account list the picker was given
 * @returns {{ kind: 'profile'|'add'|'none', profile: object|null }} the classification
 */
function classifyItem(item, accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (item === null || item === undefined) return { kind: 'none', profile: null };
  if (typeof item === 'string') {
    if (item === 'add' || item === '+') return { kind: 'add', profile: null };
    const byName = list.find((p) => p.name === item) || null;
    return byName ? { kind: 'profile', profile: byName } : { kind: 'none', profile: null };
  }
  if (typeof item !== 'object') return { kind: 'none', profile: null };
  const tag = item.action || item.id || item.type || (typeof item.kind === 'string' ? item.kind : '');
  if (tag === 'add') return { kind: 'add', profile: null };
  if (tag === 'quit' || tag === 'cancel') return { kind: 'none', profile: null };
  if (item.profile && typeof item.profile === 'object' && item.profile.name) {
    return { kind: 'profile', profile: item.profile };
  }
  if (typeof item.name === 'string') {
    const byName = list.find((p) => p.name === item.name);
    if (byName) return { kind: 'profile', profile: byName };
    if (item.name === 'add') return { kind: 'add', profile: null };
    if (Object.prototype.hasOwnProperty.call(item, 'dir')) return { kind: 'profile', profile: item };
  }
  return { kind: 'none', profile: null };
}

/**
 * Report every environment variable cam removed, every one it deliberately let
 * through, and every note the sanitizer raised. Nothing is ever removed
 * silently: a user who set one meant it. And nothing that OUTRANKS the account
 * cam just chose is silent either — on the `default` account and under
 * --keep-env the variable survives and decides the session, so the banner alone
 * would be a lie by omission.
 * @param {object} ctx the injected context
 * @param {object} caps terminal capabilities
 * @param {{ stripped: object[], notes: unknown[], keepEnv: boolean, kept?: object[] }} result the sanitizer output
 * @returns {void}
 */
function reportEnv(ctx, caps, { stripped, notes, keepEnv, kept }) {
  const said = new Set();
  for (const entry of stripped) {
    const name = typeof entry === 'string' ? entry : (entry && entry.name);
    if (!name) continue;
    const impact = (entry && typeof entry === 'object' && maybeT(ctx, entry.impact)) || impactFor(ctx, name);
    const line = ctx.t('launch.stripped', { name, impact });
    if (said.has(line)) continue;
    said.add(line);
    warnLine(ctx, caps, line);
  }
  for (const entry of Array.isArray(kept) ? kept : []) {
    const name = typeof entry === 'string' ? entry : (entry && entry.name);
    if (!name) continue;
    const impact = (entry && typeof entry === 'object' && maybeT(ctx, entry.impact)) || impactFor(ctx, name);
    // Says plainly that cam is NOT removing this one and that the account named
    // in the banner below may therefore not be the one that actually runs.
    const line = impact ? ctx.t('launch.kept', { name, impact }) : name;
    if (said.has(line)) continue;
    said.add(line);
    warnLine(ctx, caps, line);
  }
  if (stripped.length > 0) note(ctx, `  ${ctx.t('launch.strippedKeep')}`);
  for (const raw of notes) {
    const text = maybeT(ctx, typeof raw === 'string' ? raw : (raw && (raw.text || raw.key || raw.message)));
    if (!text || said.has(text)) continue;
    said.add(text);
    note(ctx, `${ctx.t('launch.prefix')} ${text}`);
  }
  if (keepEnv) {
    const text = ctx.t('launch.keepEnv');
    if (!said.has(text)) warnLine(ctx, caps, text);
  }
}

/**
 * Ask, add and re-ask until the user starts an account or gives up.
 * @param {object} ctx the injected context
 * @param {{ accounts: object[], active: object|null }} state the list and the preselected row
 * @returns {Promise<{ profile: object|null, accounts: object[] }>} the choice
 */
async function pickLoop(ctx, { accounts, active }) {
  let list = accounts;
  let activeName = active ? active.name : null;
  for (;;) {
    const index = Math.max(0, list.findIndex((p) => p.name === activeName));
    const sc = screen.createScreen(ctx);
    let item = null;
    try {
      item = await screen.pick(ctx, sc, {
        items: list,
        index,
        active: activeName,
        allowAdd: true,
        mode: 'launch'
      });
    } finally {
      try {
        sc.erase();
      } catch {
        // the frame may already be gone; the cursor still gets restored below
      }
      try {
        sc.teardown();
      } catch {
        // teardown is best-effort by design
      }
      screen.restoreCursorSync();
    }
    const choice = classifyItem(item, list);
    if (choice.kind === 'add') {
      const account = await import('./account.js');
      await account.cmdAdd(ctx, { cmd: 'add', camArgs: [], forwarded: [], camName: null, flags: {} });
      list = await profiles.all(ctx);
      activeName = (await profiles.getLast(ctx)) || activeName;
      continue;
    }
    if (choice.kind === 'profile') return { profile: choice.profile, accounts: list };
    return { profile: null, accounts: list };
  }
}

/**
 * Sign an account back in, in place, without moving anything.
 * @param {object} ctx the injected context
 * @param {object} caps terminal capabilities
 * @param {{ profile: object, health: object, claudeBin: string|undefined }} opts the profile to heal
 * @returns {Promise<{ ok: boolean, exitCode: number }>} whether the launch may continue
 */
async function healProfile(ctx, caps, { profile, health, claudeBin }) {
  const meta = profile.meta || {};
  if (health.status === 'signedout') {
    warnLine(ctx, caps, ctx.t('launch.healSignedOut', { name: profile.name }));
  } else {
    const at = typeof meta.refreshTokenExpiresAt === 'number' ? meta.refreshTokenExpiresAt : null;
    // ui.relativeTime defaults to the English catalogue, so the translator has
    // to be passed explicitly or a pt-BR session prints "4 days ago" mid-sentence.
    const ago = at ? ui.relativeTime(at, ctx.now(), ctx.t) : (health.label || '');
    warnLine(ctx, caps, ctx.t('launch.healExpired', { name: profile.name, ago }));
  }
  note(ctx, `  ${ctx.t('launch.healAction')}`);
  const bin = claude.requireClaude(ctx, { claudeBin });
  const login = await claude.authLogin(ctx, { configDir: profile.dir, bin: bin.path });
  const loginCode = login && typeof login.exitCode === 'number' ? login.exitCode : EXIT.AUTH_FAILED;
  if (loginCode !== 0) {
    warnLine(ctx, caps, ctx.t('launch.healFailed'));
    return { ok: false, exitCode: loginCode };
  }
  const status = await claude.authStatus(ctx, { configDir: profile.dir, bin: bin.path });
  if (!status || status.loggedIn !== true) {
    warnLine(ctx, caps, ctx.t('launch.healFailed'));
    return { ok: false, exitCode: EXIT.AUTH_FAILED };
  }
  note(ctx, ctx.t('launch.healDone'));
  try {
    await profiles.refreshMeta(ctx, profile, {});
  } catch (e) {
    debug(ctx, String((e && e.message) || e));
  }
  return { ok: true, exitCode: EXIT.OK };
}

/**
 * Refresh a profile's metadata after a session. Best-effort by contract: it
 * may never throw and may never change the exit code of the session.
 * @param {object} ctx the injected context
 * @param {object} caps terminal capabilities
 * @param {object} profile the profile that just ran
 * @param {number} sessionMs how long the session lasted
 * @returns {Promise<void>} always resolves
 */
async function syncBack(ctx, caps, profile, sessionMs) {
  if (!profile || !profile.dir) return;
  try {
    const result = await profiles.refreshMeta(ctx, profile, { sessionMs });
    const warning = result && maybeT(ctx, result.warning);
    if (warning) warnLine(ctx, caps, warning);
  } catch (e) {
    debug(ctx, String((e && e.message) || e));
  }
}

/**
 * The exit code of a finished child, however the runner reported it.
 * @param {{ code: number|null, signal: string|null, exitCode?: number }} result the runner result
 * @returns {number} the process exit code to propagate
 */
function exitCodeOf(result) {
  if (result && typeof result.exitCode === 'number') return result.exitCode;
  try {
    return claude.exitCodeFor(result || { code: null, signal: null });
  } catch {
    return EXIT.ERROR;
  }
}

// ── resolution ─────────────────────────────────────────────────────────

/**
 * The resolution ladder: which account a launch would use, and why. Pure apart
 * from one stderr warning when the remembered account has been removed.
 * An unknown explicit name is always an error — never a silent fallback,
 * because that is how a prompt reaches the wrong organisation.
 * @param {object} ctx the injected context
 * @param {{ accounts: object[], forwarded?: string[], camName?: string|null, flags?: object, config?: object, mode?: object, last?: string|null }} opts the inputs
 * @returns {{ kind: 'launch'|'pick'|'firstrun', profile: object|null, reason: string, short: string, detail: string, chain: string[] }} the verdict
 */
export function resolveTarget(ctx, opts = {}) {
  const accounts = Array.isArray(opts.accounts) ? opts.accounts : [];
  const forwarded = Array.isArray(opts.forwarded) ? opts.forwarded : [];
  const flags = opts.flags && typeof opts.flags === 'object' ? opts.flags : {};
  const config = opts.config && typeof opts.config === 'object' ? opts.config : {};
  const mode = opts.mode && typeof opts.mode === 'object' ? opts.mode : { kind: 'none', reason: '' };
  const camName = typeof opts.camName === 'string' && opts.camName !== '' ? opts.camName : null;
  const names = accounts.map((p) => p.name);
  // Case-insensitive, exactly like profiles.get(): profile directory names are
  // always lower-cased by validName, so `cam use Work` resolves and `--cam Work`
  // must too. An exact match here made the hot path the only place that failed.
  const find = (n) => accounts.find((p) => String(p.name).toLowerCase() === String(n).toLowerCase()) || null;
  const unknown = (n) => fail('NOT_FOUND', ctx.t('err.notFound', { name: n }), {
    hint: ctx.t('err.notFoundHint', { names: names.join(', ') })
  });

  // a — the --cam flag wins over everything.
  if (camName !== null && camName !== ASK_SENTINEL) {
    const wanted = camName.trim();
    const hit = find(wanted);
    if (!hit) unknown(wanted);
    const short = ctx.t('which.reason.flag', { name: wanted });
    return { kind: 'launch', profile: hit, reason: short, short, detail: '', chain: [short] };
  }
  const forcedAsk = camName === ASK_SENTINEL;

  // b — CAM_PROFILE / CAM_ACCOUNT.
  const envVar = ['CAM_PROFILE', 'CAM_ACCOUNT'].find((n) => envText(ctx, n) !== null) || null;
  if (!forcedAsk && envVar) {
    const wanted = envText(ctx, envVar);
    const hit = find(wanted);
    if (!hit) unknown(wanted);
    const short = ctx.t('which.reason.env', { var: envVar, name: wanted });
    return { kind: 'launch', profile: hit, reason: short, short, detail: '', chain: [short] };
  }

  // c — nothing to launch at all.
  const real = accounts.filter((p) => p && p.dir);
  const fallback = accounts.find((p) => p && !p.dir) || null;
  const defaultIdentity = !!(fallback && fallback.meta && (fallback.meta.email || fallback.meta.accountUuid));
  if (accounts.length === 0 || (real.length === 0 && !defaultIdentity)) {
    const short = ctx.t('launch.noAccounts');
    return { kind: 'firstrun', profile: fallback, reason: short, short, detail: '', chain: [short] };
  }

  // e — the active account, computed first because the picker preselects it.
  const last = typeof opts.last === 'string' && opts.last !== ''
    ? opts.last
    : (typeof config.last === 'string' && config.last !== '' ? config.last : null);
  let profile = null;
  let short = '';
  const lastHit = last ? find(last) : null;
  if (lastHit) {
    profile = lastHit;
    short = ctx.t('which.reason.last');
  }
  if (!profile && real.length === 1) {
    profile = real[0];
    short = ctx.t('which.reason.only');
  }
  if (!profile) {
    profile = fallback || accounts[0] || null;
    // `which.reason.default` names the reserved default login, so it may only be
    // used when that is what was actually chosen. With no default row this is
    // just the first account on the list, and claiming "your existing Claude
    // Code login" describes an account that does not exist in this store; the
    // truthful label for anything else is "the first account on the list".
    short = profile && !profile.dir
      ? ctx.t('which.reason.default')
      : ctx.t('which.reason.first');
  }
  // The "last account is gone" notice is emitted only now, because it names what
  // happens next: `launch.lastMissing` hardcodes the word "default", which is
  // true only when the fallback really is the reserved default account.
  if (last && !lastHit) {
    const missing = profile && !profile.dir
      ? ctx.t('launch.lastMissing', { name: last })
      : ctx.t('launch.lastMissingProfile', {
        name: last,
        fallback: profile ? profile.name : '',
      });
    note(ctx, `${ctx.t('launch.prefix')} ${missing}`);
  }

  // d — may cam ask, and does it want to?
  const ask = normalizeAsk(flags.ask)
    || normalizeAsk(envValue(ctx, 'CAM_ASK'))
    || normalizeAsk(config.ask)
    || 'auto';
  const canAsk = mode.kind === 'raw' || mode.kind === 'line';
  let wantPick;
  if (forcedAsk) wantPick = true;
  else if (ask === 'never') wantPick = false;
  else if (ask === 'always') wantPick = true;
  else wantPick = forwarded.length === 0 && accounts.length >= 2;

  if (wantPick && canAsk) {
    // detailAsk says "no arguments", which is only the auto case; ask=always and
    // a bare --cam also land here, and those two asked for the menu outright.
    const detail = (forcedAsk || ask === 'always')
      ? ctx.t('which.reason.detailAskAlways', { n: accounts.length })
      : ctx.t('which.reason.detailAsk', { n: accounts.length });
    return {
      kind: 'pick',
      profile,
      reason: joinReason(short, detail),
      short,
      detail,
      chain: [short, detail].filter(Boolean)
    };
  }

  let detail;
  if (wantPick && !canAsk) detail = ctx.t('launch.cannotAsk', { reason: reasonText(ctx, mode.reason) });
  else if (ask === 'never') detail = ctx.t('which.reason.askNever');
  else detail = ctx.t('which.reason.detail', { var: envVar || 'CAM_PROFILE', ask, n: forwarded.length });

  return {
    kind: 'launch',
    profile,
    reason: joinReason(short, detail),
    short,
    detail,
    chain: [short, detail].filter(Boolean)
  };
}

// ── the hot path ───────────────────────────────────────────────────────

/**
 * `cam launch [-- <args>]` — the whole point of the program. The step order is
 * load-bearing: ask, heal, sanitize, restore the terminal, remember, spawn.
 * @param {object} ctx the injected context
 * @param {object|string[]} args the command arguments
 * @returns {Promise<number>} the exit code to propagate
 */
export async function run(ctx, args) {
  const parsed = readArgs(args);
  const { forwarded, flags } = parsed;
  const keepEnv = flagOn(flags, 'keep-env', 'keepEnv') || isTruthy(envValue(ctx, 'CAM_KEEP_ENV'));
  const caps = tty.detectCaps(ctx, ctx.io.err);

  // 1 — the list, with no subprocess and no network.
  let accounts = await profiles.all(ctx);
  const config = await profiles.loadConfig(ctx);
  const last = await profiles.getLast(ctx);

  // 2 — how, if at all, cam may ask.
  const mode = tty.interactivity(ctx, { forwarded });

  // 3 — who runs.
  const target = resolveTarget(ctx, {
    accounts,
    forwarded,
    camName: parsed.camName,
    flags,
    config,
    mode,
    last
  });

  // 4 — nothing set up yet.
  if (target.kind === 'firstrun') {
    if (mode.kind === 'none') {
      fail('NO_ACCOUNTS', ctx.t('err.noAccounts'), { hint: ctx.t('err.noAccountsHint') });
    }
    const account = await import('./account.js');
    return account.firstRun(ctx);
  }

  let profile = target.profile;

  // 5 — the menu.
  if (target.kind === 'pick') {
    const picked = await pickLoop(ctx, { accounts, active: profile });
    accounts = picked.accounts;
    if (!picked.profile) return EXIT.OK;
    profile = picked.profile;
  } else if (mode.kind === 'none' && accounts.length > 1 && !namedExplicitly(ctx, parsed.camName)) {
    // Silence here is the failure mode this program exists to avoid — but a
    // user who typed --cam already knows which account they asked for.
    const modeWhy = reasonText(ctx, mode.reason);
    const why = target.short ? `${target.short}; ${modeWhy}` : modeWhy;
    const prefix = ctx.t('launch.prefix');
    note(ctx, `${prefix} ${ctx.t('launch.using', { name: profile.name, reason: why })}`);
    note(ctx, `${' '.repeat(prefix.length + 1)}${ctx.t('launch.switchHint')}`);
  }

  if (!profile) fail('NO_ACCOUNTS', ctx.t('err.noAccounts'), { hint: ctx.t('err.noAccountsHint') });

  // 6 — self-heal, never block.
  const health = safeHealth(profile, ctx.now());
  if (profile.dir && (health.status === 'signedout' || health.status === 'expired')) {
    const healed = await healProfile(ctx, caps, { profile, health, claudeBin: config.claudeBin });
    if (!healed.ok) return healed.exitCode;
    const fresh = await profiles.get(ctx, profile.name);
    if (fresh) profile = fresh;
  }

  // 7 — the child environment, with every removal reported.
  const sanitized = sanitize(ctx, { profile, keepEnv });
  reportEnv(ctx, caps, {
    stripped: sanitized.stripped,
    notes: sanitized.notes,
    kept: sanitized.kept,
    keepEnv
  });

  // 8 — hand the terminal back before anything else can touch it.
  screen.restoreCursorSync();

  // The banner is the line that survives into scrollback saying which account
  // you got. It belongs to a CHOICE, not to every launch: on the pass-through
  // path `claude <args>` must be as quiet as it was before cam existed, or
  // every scripted `claude -p …` grows a line of stderr it never had. So print
  // it when the user actually picked this run, when they named an account
  // explicitly, or when the account is not the one they used last — the three
  // cases where the answer is not already obvious to them.
  // `last !== profile.name` covers the first run too: with no `last` file yet,
  // null never equals a profile name, so the banner shows once and then the
  // path goes quiet.
  const announce = target.kind === 'pick'
    || namedExplicitly(ctx, parsed.camName)
    || last !== profile.name;
  if (announce) note(ctx, ui.banner(profile, caps));

  // 9 — remember the choice before the spawn, so Ctrl+C still counts.
  try {
    await profiles.setLast(ctx, profile.name);
  } catch (e) {
    debug(ctx, String((e && e.message) || e));
  }

  // 10 — the session itself.
  const bin = claude.requireClaude(ctx, { claudeBin: config.claudeBin });
  debug(ctx, ctx.t('launch.spawning', { bin: bin.path }));
  const startedAt = ctx.now();
  const result = await claude.runInherit(ctx, bin.path, forwarded, { env: sanitized.env, kind: bin.kind });
  const sessionMs = ctx.now() - startedAt;

  // 11 — the verifiable half of the sync-back guarantee.
  await syncBack(ctx, caps, profile, sessionMs);

  // 12 — the child's code is cam's code.
  const code = exitCodeOf(result);
  debug(ctx, ctx.t('launch.exited', { code }));
  return code;
}

// ── the read-only commands ─────────────────────────────────────────────

/**
 * `cam use [name]` — set the account cam launches next, without launching.
 * @param {object} ctx the injected context
 * @param {object|string[]} args the command arguments
 * @returns {Promise<number>} the exit code
 */
export async function cmdUse(ctx, args) {
  const parsed = readArgs(args);
  const caps = tty.detectCaps(ctx, ctx.io.err);
  const accounts = await profiles.all(ctx);
  if (accounts.length === 0) {
    fail('NO_ACCOUNTS', ctx.t('err.noAccounts'), { hint: ctx.t('err.noAccountsHint') });
  }
  let name = parsed.positionals[0] || null;
  if (!name && parsed.camName && parsed.camName !== ASK_SENTINEL) name = parsed.camName;

  if (!name) {
    const mode = tty.interactivity(ctx, { forwarded: [] });
    if (mode.kind === 'none') {
      note(ctx, ctx.t('use.usage'));
      return EXIT.USAGE;
    }
    const last = await profiles.getLast(ctx);
    const index = Math.max(0, accounts.findIndex((p) => p.name === last));
    const sc = screen.createScreen(ctx);
    let item = null;
    try {
      item = await screen.pick(ctx, sc, {
        items: accounts,
        index,
        active: last,
        allowAdd: false,
        mode: 'select'
      });
    } finally {
      try {
        sc.erase();
      } catch {
        // nothing painted, nothing to erase
      }
      try {
        sc.teardown();
      } catch {
        // best-effort
      }
      screen.restoreCursorSync();
    }
    const choice = classifyItem(item, accounts);
    if (!choice.profile) {
      note(ctx, ctx.t('use.cancelled'));
      return EXIT.OK;
    }
    name = choice.profile.name;
  }

  const profile = await profiles.get(ctx, name);
  if (!profile) {
    fail('NOT_FOUND', ctx.t('err.notFound', { name }), {
      hint: ctx.t('err.notFoundHint', { names: accounts.map((p) => p.name).join(', ') })
    });
  }
  await profiles.setLast(ctx, profile.name);
  out(ctx, ui.banner(profile, caps));
  out(ctx, ctx.t('use.done', { name: profile.name }));
  out(ctx, ctx.t('use.doneScope'));
  return EXIT.OK;
}

/**
 * `cam which [-v] [--json]` — the primary debugging surface for a mechanism
 * whose whole implementation is one invisible environment variable. Never
 * prompts, never launches, never fails in a pipe.
 * @param {object} ctx the injected context
 * @param {object|string[]} args the command arguments
 * @returns {Promise<number>} the exit code
 */
export async function cmdWhich(ctx, args) {
  const parsed = readArgs(args);
  const { flags, forwarded } = parsed;
  const verbose = flagOn(flags, 'verbose', 'v') || ctx.verbose === true;
  const asJson = flagOn(flags, 'json');
  const keepEnv = flagOn(flags, 'keep-env', 'keepEnv') || isTruthy(envValue(ctx, 'CAM_KEEP_ENV'));

  const accounts = await profiles.all(ctx);
  const config = await profiles.loadConfig(ctx);
  const last = await profiles.getLast(ctx);
  const mode = tty.interactivity(ctx, { forwarded });
  const target = resolveTarget(ctx, {
    accounts,
    forwarded,
    camName: parsed.camName,
    flags,
    config,
    mode,
    last
  });
  const profile = target.profile;
  if (!profile) {
    // The message is the no-accounts pair, so the code must be too: `cam launch`
    // and `cam use` both answer 6 for this exact state, and `cam help` publishes
    // the table a setup script branches on.
    fail('NO_ACCOUNTS', ctx.t('err.noAccounts'), { hint: ctx.t('err.noAccountsHint') });
  }

  const sanitized = sanitize(ctx, { profile, keepEnv });
  const configDir = sanitized.env ? sanitized.env.CLAUDE_CONFIG_DIR : undefined;
  // What cam WILL do, not what describeAmbient can see: on the reserved default
  // account sanitizeChildEnv removes nothing at all, so "cam would remove it"
  // was a written promise cam never kept.
  const strippedNames = new Set(sanitized.stripped
    .map((entry) => (typeof entry === 'string' ? entry : (entry && entry.name)))
    .filter(Boolean));
  const bin = claude.resolveClaude(ctx, { claudeBin: config.claudeBin });
  const kindKey = `which.kind.${bin.kind === 'exe' || bin.kind === 'cmd' || bin.kind === 'script' ? bin.kind : 'unknown'}`;
  const present = ambientRows(ctx).filter((row) => row && row.present);
  const meta = profile.meta || {};
  const runName = bin.path ? basename(bin.path) : 'claude';
  const wouldRun = forwarded.length ? `${runName} ${forwarded.join(' ')}` : runName;

  if (asJson) {
    out(ctx, JSON.stringify({
      name: profile.name,
      dir: profile.dir || null,
      email: meta.email || meta.emailAddress || null,
      org: meta.orgName || null,
      plan: meta.plan || meta.subscriptionType || null,
      kind: target.kind,
      reason: target.reason,
      chain: target.chain,
      configDir: configDir || null,
      claudeBin: bin.path || null,
      claudeKind: bin.kind,
      keepEnv,
      forwarded,
      ambient: present.map((row) => ({
        name: row.name,
        hostile: !!row.hostile,
        stripped: strippedNames.has(row.name)
      }))
    }, null, 2));
    return EXIT.OK;
  }

  const label = (key) => `  ${ui.padEnd(ctx.t(key), WHICH_LABEL)}`;
  const cont = `  ${' '.repeat(WHICH_LABEL)}`;
  out(ctx, identityLine(ctx, profile));

  if (verbose) {
    out(ctx, `${label('which.chose')}${target.reason}`);
    if (profile.dir) out(ctx, `${label('which.dir')}${profile.dir}`);
  }

  out(ctx, `${label('which.env')}${configDir ? `CLAUDE_CONFIG_DIR=${configDir}` : ctx.t('which.envUnset')}`);

  if (verbose) {
    out(ctx, `${label('which.binary')}${bin.path ? `${bin.path}   (${ctx.t(kindKey)})` : ctx.t('launch.noClaudeTitle')}`);
    if (present.length === 0) {
      out(ctx, `${label('which.ambient')}${ctx.t('which.ambientNone')}`);
    } else {
      present.forEach((row, i) => {
        let text;
        if (strippedNames.has(row.name)) text = ctx.t('which.ambientSet', { name: row.name });
        else if (keepEnv && row.hostile) text = ctx.t('which.ambientKept', { name: row.name });
        // Anything else survives into the child: the reserved default account,
        // and the report-only variables cam never touches. Say so outright
        // rather than promising a removal that will not happen — an earlier
        // version printed "cam would remove it for this session" here, which
        // was simply false for the default account.
        else if (row.hostile) text = ctx.t('which.ambientPassed', { name: row.name });
        else text = row.impact ? `${row.name}: ${row.impact}` : row.name;
        out(ctx, `${i === 0 ? label('which.ambient') : cont}${text}`);
      });
    }
    out(ctx, `${label('which.wouldRun')}${wouldRun}`);
  }
  return EXIT.OK;
}

/**
 * Quote a value for a POSIX shell.
 * @param {string} value the raw value
 * @returns {string} a single-quoted literal
 */
function quotePosix(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Quote a value for PowerShell.
 * @param {string} value the raw value
 * @returns {string} a single-quoted literal
 */
function quotePwsh(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Quote a value for fish.
 * @param {string} value the raw value
 * @returns {string} a single-quoted literal
 */
function quoteFish(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Render one `set` and the matching `unset` lines for a shell family.
 * @param {string} family one of posix, powershell, fish, cmd
 * @param {string|null} dir the CLAUDE_CONFIG_DIR value, or null to unset it
 * @param {string[]} unset variable names to clear
 * @returns {string[]} the lines, in order
 */
function envLines(family, dir, unset) {
  const lines = [];
  if (family === 'powershell') {
    if (dir) lines.push(`$env:CLAUDE_CONFIG_DIR=${quotePwsh(dir)}`);
    else lines.push('Remove-Item Env:\\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue');
    for (const name of unset) lines.push(`Remove-Item Env:\\${name} -ErrorAction SilentlyContinue`);
    return lines;
  }
  if (family === 'fish') {
    if (dir) lines.push(`set -gx CLAUDE_CONFIG_DIR ${quoteFish(dir)}`);
    else lines.push('set -e CLAUDE_CONFIG_DIR');
    for (const name of unset) lines.push(`set -e ${name}`);
    return lines;
  }
  if (family === 'cmd') {
    if (dir) lines.push(`set "CLAUDE_CONFIG_DIR=${String(dir).replace(/"/g, '')}"`);
    else lines.push('set "CLAUDE_CONFIG_DIR="');
    for (const name of unset) lines.push(`set "${name}="`);
    return lines;
  }
  if (dir) lines.push(`export CLAUDE_CONFIG_DIR=${quotePosix(dir)}`);
  else lines.push('unset CLAUDE_CONFIG_DIR');
  for (const name of unset) lines.push(`unset ${name}`);
  return lines;
}

/**
 * `cam env <name> [--shell …]` — the documented escape hatch. Writes nothing
 * but assignments to stdout, so it is safe to eval.
 * @param {object} ctx the injected context
 * @param {object|string[]} args the command arguments
 * @returns {Promise<number>} the exit code
 */
export async function cmdEnv(ctx, args) {
  const parsed = readArgs(args);
  const caps = tty.detectCaps(ctx, ctx.io.err);
  let name = parsed.positionals[0] || null;
  if (!name && parsed.camName && parsed.camName !== ASK_SENTINEL) name = parsed.camName;
  if (!name) {
    note(ctx, ctx.t('env.usage'));
    return EXIT.USAGE;
  }

  let family = null;
  const wanted = typeof parsed.flags.shell === 'string' ? parsed.flags.shell.trim().toLowerCase() : '';
  if (wanted) {
    family = SHELL_FAMILY[wanted] || null;
    if (!family) {
      note(ctx, `${ctx.t('err.prefix')} ${ctx.t('env.unknownShell', { shell: wanted })}`);
      note(ctx, `  ${ctx.t('env.shellList')}`);
      return EXIT.USAGE;
    }
  } else {
    const shell = await import('../shell.js');
    const current = shell.currentShell(ctx);
    family = (current && SHELL_FAMILY[String(current).toLowerCase()])
      || (ctx.platform === 'win32' ? 'powershell' : 'posix');
  }

  const profile = await profiles.get(ctx, name);
  if (!profile) {
    const accounts = await profiles.all(ctx);
    fail('NOT_FOUND', ctx.t('err.notFound', { name }), {
      hint: ctx.t('err.notFoundHint', { names: accounts.map((p) => p.name).join(', ') })
    });
  }

  const sanitized = sanitize(ctx, { profile, keepEnv: false });
  const stripped = sanitized.stripped
    .map((entry) => (typeof entry === 'string' ? entry : (entry && entry.name)))
    .filter((n) => typeof n === 'string' && n !== '');
  for (const line of envLines(family, profile.dir || null, stripped)) out(ctx, line);
  if (caps.isTTY) note(ctx, `${ctx.t('launch.prefix')} ${ctx.t('env.evalHint')}`);
  return EXIT.OK;
}

/**
 * Classify the command `cam exec` was asked to run, so Windows `.cmd` shims
 * reach the same correct spawn path the launcher uses.
 * @param {object} ctx the injected context
 * @param {string} file the command as typed
 * @param {string|undefined} override the configured claude binary, if any
 * @returns {{ file: string, kind: 'exe'|'cmd'|'script'|'unknown' }} what to spawn and how
 */
function targetKind(ctx, file, override) {
  const base = basename(String(file)).toLowerCase();
  const stem = base.replace(/\.(exe|cmd|bat|ps1|sh|js|mjs|cjs)$/i, '');
  const bare = String(file) === base;
  if (bare && stem === 'claude') {
    const found = claude.resolveClaude(ctx, { claudeBin: override });
    if (found && found.path) return { file: found.path, kind: found.kind };
  }
  const ext = extname(base).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return { file, kind: 'cmd' };
  if (ext === '.ps1' || ext === '.sh' || ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.py') {
    return { file, kind: 'script' };
  }
  // On Windows an extensionless command means a PATHEXT lookup, and libuv's own
  // PATH search only appends .com and .exe — so every .cmd shim (npm, npx, yarn,
  // pnpm, tsc, eslint) failed ENOENT and `cam exec` answered a bare 127. Route
  // them through ComSpec, which is what claude.classifyKind already answers for
  // an extensionless path on win32.
  if (ext === '' && ctx.isWindows === true) return { file, kind: 'script' };
  return { file, kind: 'exe' };
}

/**
 * `cam exec <name> -- <cmd…>` — run anything under one account's sanitized
 * environment. The supported CI, cmd.exe and IDE-terminal entry point.
 * @param {object} ctx the injected context
 * @param {object|string[]} args the command arguments
 * @returns {Promise<number>} the command's exit code
 */
export async function cmdExec(ctx, args) {
  const parsed = readArgs(args);
  const caps = tty.detectCaps(ctx, ctx.io.err);
  let name = parsed.positionals[0] || null;
  if (!name && parsed.camName && parsed.camName !== ASK_SENTINEL) name = parsed.camName;
  if (!name) {
    note(ctx, ctx.t('exec.usage'));
    return EXIT.USAGE;
  }
  const command = parsed.forwarded.filter((a) => typeof a === 'string');
  if (command.length === 0) {
    note(ctx, `${ctx.t('err.prefix')} ${ctx.t('exec.noCommand')}`);
    note(ctx, ctx.t('exec.usage'));
    return EXIT.USAGE;
  }

  const profile = await profiles.get(ctx, name);
  if (!profile) {
    const accounts = await profiles.all(ctx);
    fail('NOT_FOUND', ctx.t('err.notFound', { name }), {
      hint: ctx.t('err.notFoundHint', { names: accounts.map((p) => p.name).join(', ') })
    });
  }

  const config = await profiles.loadConfig(ctx);
  const keepEnv = flagOn(parsed.flags, 'keep-env', 'keepEnv') || isTruthy(envValue(ctx, 'CAM_KEEP_ENV'));
  const sanitized = sanitize(ctx, { profile, keepEnv });
  reportEnv(ctx, caps, {
    stripped: sanitized.stripped,
    notes: sanitized.notes,
    kept: sanitized.kept,
    keepEnv
  });

  const spawnTarget = targetKind(ctx, command[0], config.claudeBin);
  const startedAt = ctx.now();
  const result = await claude.runInherit(ctx, spawnTarget.file, command.slice(1), {
    env: sanitized.env,
    kind: spawnTarget.kind
  });
  // A child that never started reports code null with exitCode 127; a child that
  // ran and chose to exit 127 reports code 127. Only the first is cam's to
  // explain, and it used to be explained with nothing at all.
  if (result && result.code === null && result.exitCode === EXIT.NO_CLAUDE) {
    warnLine(ctx, caps, ctx.t('exec.notFound', { cmd: command[0] }));
    note(ctx, `  ${ctx.t('err.hintLabel')}: ${ctx.t('err.errorHint')}`);
  }
  await syncBack(ctx, caps, profile, ctx.now() - startedAt);
  return exitCodeOf(result);
}
