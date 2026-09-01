// src/commands/doctor.js — the portability contract made executable.
// Owns `cam doctor` (every platform assumption in the design, checked here,
// today, on this machine) and `cam shell` (the driver for src/shell.js).

import { readFile, readdir, stat, lstat, mkdir, unlink } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT, fail, describeAmbient } from '../ctx.js';
import {
  ensureDir,
  readJsonSafe,
  linkDir,
  isOurLink,
  rmrf,
  chmodIfPosix,
  pathTooLongRisk
} from '../fsx.js';
import {
  storePaths,
  claudePaths,
  defaultClaudePaths,
  all as allProfiles,
  readMeta,
  refreshMeta,
  health,
  sweepPending,
  loadConfig,
  SHARE_DIRS,
  SHARE_FILES
} from '../profiles.js';
import {
  resolveClaude,
  claudeVersion,
  verifyIsolation,
  authStatus,
  runCapture
} from '../claude.js';
import { detectBackend, securityAvailable } from '../credstore.js';
import { detectCaps, writeCaps, probeRawMode, interactivity, isCI } from '../tty.js';
import { statusLine, padEnd, relativeTime, planLabel, plain } from '../ui.js';
import {
  detectTargets,
  currentShell,
  conflicts as shellConflicts,
  status as shellStatus,
  install as shellInstall,
  uninstall as shellUninstall,
  writeRuntime
} from '../shell.js';

/** Width of the label column in the rendered report. */
const LABEL_COLS = 14;

/** Claude Code range this build was exercised against; package.json overrides it. */
const TESTED_CLAUDE = Object.freeze({ min: '2.1.0', max: '2.1.999' });

/** Variables that relocate or bypass the credential store, checked by name only. */
const CREDMAN_FLAG = 'CLAUDE_CODE_FORCE_WINDOWS_CREDMAN';

/** Reason ids src/tty.js may return that the catalogue can render as prose. */
const PICK_REASONS = new Set([
  'claudecode', 'noPrompt', 'ci', 'notATty', 'args', 'askNever', 'single', 'rawUnavailable'
]);

/**
 * Turn a reason id from src/tty.js into a translated sentence, passing an
 * unrecognised id through unchanged rather than asking for a key that is not
 * in the catalogue (which would pollute i18n.missingKeys()).
 * @param {object} ctx the cam context
 * @param {string} reason a reason id such as 'claudecode', or free text
 * @returns {string} the translated reason, or the id verbatim
 */
function reasonText(ctx, reason) {
  const id = String(reason == null ? '' : reason);
  return PICK_REASONS.has(id) ? ctx.t(`pick.reason.${id}`) : id;
}

/**
 * Read the Node runtime version without reaching for a banned global directly.
 * Tests inject `ctx.nodeVersion`; production falls back to the live runtime.
 * @param {object} ctx the cam context
 * @returns {string} a version string such as 'v24.11.1', or 'unknown'
 */
function nodeVersionOf(ctx) {
  if (typeof ctx.nodeVersion === 'string' && ctx.nodeVersion) return ctx.nodeVersion;
  const g = globalThis;
  const runtime = g && g.process;
  return runtime && typeof runtime.version === 'string' ? runtime.version : 'unknown';
}

/**
 * Read the CPU architecture the same injectable way.
 * @param {object} ctx the cam context
 * @returns {string} an arch string such as 'x64', or 'unknown'
 */
function archOf(ctx) {
  if (typeof ctx.arch === 'string' && ctx.arch) return ctx.arch;
  const g = globalThis;
  const runtime = g && g.process;
  return runtime && typeof runtime.arch === 'string' ? runtime.arch : 'unknown';
}

/**
 * Split a dotted version into comparable numbers.
 * @param {string|null|undefined} v a version string, possibly with a suffix
 * @returns {number[]} up to three numeric components, missing ones as 0
 */
function versionParts(v) {
  const m = String(v == null ? '' : v).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compare two dotted versions.
 * @param {string} a left version
 * @param {string} b right version
 * @returns {number} negative when a < b, 0 when equal, positive when a > b
 */
function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Format a byte count for a report line. Numbers and units are not translated.
 * @param {number} bytes the size in bytes
 * @returns {string} a compact human size such as '84 MB'
 */
function humanSize(bytes) {
  const n = Number.isFinite(bytes) ? bytes : 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * Sum the size of a directory tree WITHOUT following symlinks or junctions,
 * so a shared `plugins` link never inflates a profile's reported size.
 * @param {string} root the directory to measure
 * @returns {Promise<number>} total bytes of real files below root
 */
async function dirSize(root) {
  let total = 0;
  /** @type {string[]} */
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      try {
        const st = await lstat(p);
        if (st.isSymbolicLink()) continue;
        total += st.size;
      } catch {
        /* a file that vanished mid-walk is not a finding */
      }
    }
  }
  return total;
}

/**
 * Does a path exist at all (link or real)?
 * @param {string} p the path to test
 * @returns {Promise<boolean>} true when lstat succeeds
 */
async function exists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build one Check record.
 * @param {string} id stable machine id for --json consumers
 * @param {string} title the translated label shown in the left column
 * @param {'ok'|'warn'|'fail'|'skip'} status the outcome
 * @param {string} detail the translated one-line finding
 * @param {{ hint?: string, fixable?: boolean }} [extra] optional remedy and fixability
 * @returns {{ id: string, title: string, status: string, detail: string, hint?: string, fixable?: boolean }} the check
 */
function check(id, title, status, detail, extra = {}) {
  /** @type {any} */
  const c = { id, title, status, detail };
  if (extra.hint) c.hint = extra.hint;
  if (extra.fixable) c.fixable = true;
  return c;
}

/**
 * Read the tested Claude Code range from package.json, falling back to the
 * constant compiled into this file.
 * @returns {Promise<{ min: string, max: string }>} the tested range
 */
async function testedClaudeRange() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgFile = join(here, '..', '..', 'package.json');
    const raw = await readFile(pkgFile, 'utf8');
    const pkg = JSON.parse(raw);
    const range = pkg && pkg.cam && pkg.cam.testedClaude;
    if (range && typeof range.min === 'string' && typeof range.max === 'string') {
      return { min: range.min, max: range.max };
    }
  } catch {
    /* no package.json in a source checkout; the constant is the contract */
  }
  return { min: TESTED_CLAUDE.min, max: TESTED_CLAUDE.max };
}

/**
 * Parse the flags `cam doctor` understands.
 * @param {string[]} args raw argv for the command
 * @returns {{ deep: boolean, fix: boolean, json: boolean, keepEnv: boolean }} parsed flags
 */
function parseDoctorArgs(args) {
  const list = Array.isArray(args) ? args : [];
  return {
    deep: list.includes('--deep'),
    fix: list.includes('--fix'),
    json: list.includes('--json'),
    keepEnv: list.includes('--keep-env')
  };
}

/**
 * Parse the flags and subcommand `cam shell` understands.
 * @param {string[]} args raw argv for the command
 * @returns {{ sub: string|null, dryRun: boolean, only: string|null, unknown: string[] }} parsed arguments
 */
function parseShellArgs(args) {
  const list = Array.isArray(args) ? args : [];
  let sub = null;
  let dryRun = false;
  let only = null;
  /** @type {string[]} */
  const unknown = [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--dry-run' || a === '-n') {
      dryRun = true;
    } else if (a === '--shell') {
      only = list[i + 1] || null;
      i += 1;
    } else if (a.startsWith('--shell=')) {
      only = a.slice('--shell='.length) || null;
    } else if (a.startsWith('-')) {
      unknown.push(a);
    } else if (sub === null) {
      sub = a;
    } else {
      unknown.push(a);
    }
  }
  return { sub, dryRun, only, unknown };
}

// ── the checks ────────────────────────────────────────────────────────────

/**
 * Repairs that are provably safe: they never touch credentials, never write a
 * Claude Code config, and never delete anything outside the cam store.
 * @param {object} ctx the cam context
 * @param {Array<object>} profiles the profiles as returned by profiles.all
 * @returns {Promise<string[]>} human-readable descriptions of what was repaired
 */
async function applyFixes(ctx, profiles) {
  const paths = storePaths(ctx);
  /** @type {string[]} */
  const done = [];

  // 1. Re-tighten POSIX permissions on the store.
  if (ctx.platform !== 'win32') {
    try {
      await chmodIfPosix(ctx, paths.root, 0o700);
      await chmodIfPosix(ctx, paths.profilesDir, 0o700);
      for (const p of profiles) {
        if (!p.dir) continue;
        await chmodIfPosix(ctx, p.dir, 0o700);
        const cp = claudePaths(ctx, p.dir);
        if (await exists(cp.configFile)) await chmodIfPosix(ctx, cp.configFile, 0o600);
        if (await exists(cp.credentialsFile)) await chmodIfPosix(ctx, cp.credentialsFile, 0o600);
      }
      done.push(ctx.t('doctor.label.permissions'));
    } catch {
      /* a permission repair that fails is reported by the permissions check */
    }
  }

  // 2. Re-create missing share links from the user's real config directory.
  const dflt = defaultClaudePaths(ctx);
  let relinked = 0;
  for (const p of profiles) {
    if (!p.dir) continue;
    for (const name of SHARE_DIRS) {
      const target = join(dflt.configDir, name);
      const linkPath = join(p.dir, name);
      if (await exists(linkPath)) continue;
      if (!(await exists(target))) continue;
      try {
        const mode = await linkDir(ctx, target, linkPath);
        if (mode !== 'skip') relinked += 1;
      } catch {
        /* the links check reports what could not be restored */
      }
    }
  }
  if (relinked > 0) done.push(ctx.t('doctor.label.links'));

  // 3. Sweep stale .cam-pending markers.
  try {
    const swept = await sweepPending(ctx);
    if (swept && swept.length) done.push(ctx.t('add.pendingSwept', { n: swept.length }));
  } catch {
    /* sweeping is best effort */
  }

  // 4. Remove orphaned atomic-write temp files inside the store only.
  let orphans = 0;
  const sweepDirs = [paths.root, paths.profilesDir, ...profiles.filter((p) => p.dir).map((p) => p.dir)];
  for (const dir of sweepDirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.cam-\d+-[a-z0-9]+\.tmp$/i.test(entry.name)) continue;
      try {
        await unlink(join(dir, entry.name));
        orphans += 1;
      } catch {
        /* held open by another process; the next run will get it */
      }
    }
  }
  if (orphans > 0) done.push(`${orphans} .tmp`);

  // 5. Rewrite a missing .cam-meta.json from what is already on disk.
  let metas = 0;
  for (const p of profiles) {
    if (!p.dir) continue;
    const meta = await readMeta(ctx, p.dir);
    if (meta) continue;
    try {
      await refreshMeta(ctx, p, {});
      metas += 1;
    } catch {
      /* the per-profile check reports a profile whose meta cannot be rebuilt */
    }
  }
  if (metas > 0) done.push(`${metas} .cam-meta.json`);

  return done;
}

/**
 * Run every portability check this design depends on, in the documented order.
 * Exported so a test can assert the full matrix runs on a simulated platform.
 * @param {object} ctx the cam context
 * @param {{ deep?: boolean, fix?: boolean, keepEnv?: boolean }} [opts] doctor flags
 * @returns {Promise<Array<{ id: string, title: string, status: string, detail: string, hint?: string, fixable?: boolean }>>} the checks, in report order
 */
export async function checks(ctx, opts = {}) {
  const t = ctx.t;
  const deep = opts.deep === true;
  const wantFix = opts.fix === true;
  const keepEnv = opts.keepEnv === true;
  const now = ctx.now();
  const paths = storePaths(ctx);
  const dflt = defaultClaudePaths(ctx);
  /** @type {Array<any>} */
  const out = [];

  let config = {};
  try {
    config = await loadConfig(ctx);
  } catch {
    config = {};
  }

  /** @type {Array<any>} */
  let profiles = [];
  try {
    profiles = await allProfiles(ctx);
  } catch (e) {
    out.push(check('profiles', t('doctor.label.store'), 'fail', t('err.unexpected', { message: String(e && e.message ? e.message : e) })));
    profiles = [];
  }
  const real = profiles.filter((p) => p && p.dir);

  // ── 0. --fix runs first so the report below describes the repaired state ──
  if (wantFix) {
    const fixed = await applyFixes(ctx, real);
    out.push(fixed.length
      ? check('fix', t('doctor.label.store'), 'ok', t('doctor.fixed', { what: fixed.join(', ') }))
      : check('fix', t('doctor.label.store'), 'ok', t('doctor.fixNothing')));
  }

  // ── 1. node and cam ──────────────────────────────────────────────────────
  const node = nodeVersionOf(ctx);
  const nodeOk = compareVersions(node, '18.17.0') >= 0;
  out.push(check('node', t('doctor.label.node'), nodeOk ? 'ok' : 'fail',
    nodeOk ? node : t('err.nodeVersion', { version: node }),
    nodeOk ? {} : { hint: t('err.nodeVersionHint') }));
  out.push(check('cam', t('doctor.label.cam'), 'ok', String(ctx.version)));

  // ── 2. platform, arch, WSL, CI, current shell ────────────────────────────
  const shellId = currentShell(ctx);
  const wsl = Boolean(ctx.env.WSL_DISTRO_NAME || ctx.env.WSL_INTEROP);
  const ci = isCI(ctx);
  const platformBits = [`${ctx.platform} ${archOf(ctx)}`];
  if (shellId) platformBits.push(shellId);
  if (wsl) platformBits.push('WSL');
  if (ci) platformBits.push('CI');
  out.push(check('platform', t('doctor.label.platform'), 'ok', platformBits.join(' · ')));

  // ── 3. the claude binary and, crucially, its KIND ────────────────────────
  let resolved = { path: null, kind: 'unknown', tried: [] };
  try {
    resolved = resolveClaude(ctx, { config, bin: config.claudeBin });
  } catch {
    resolved = { path: null, kind: 'unknown', tried: [] };
  }
  let claudeVer = null;
  if (resolved.path) {
    try {
      claudeVer = await claudeVersion(ctx, resolved.path);
    } catch {
      claudeVer = null;
    }
  }
  if (resolved.path) {
    const kindLabel = t(`which.kind.${resolved.kind}`);
    // A .cmd shim cannot be spawned directly on Node 24 — say so, because every
    // npm-global Claude Code install on Windows IS claude.cmd.
    const cmdHint = resolved.kind === 'cmd'
      ? t('doctor.claudeCmdShim', { bin: `${ctx.env.ComSpec || 'cmd.exe'} /d /s /c ${basename(resolved.path)}` })
      : null;
    out.push(check('claude', t('doctor.label.claude'), 'ok',
      t('doctor.claudeFound', { version: claudeVer || t('plan.unknown'), path: resolved.path, kind: kindLabel }),
      cmdHint ? { hint: cmdHint } : {}));
  } else {
    const tried = Array.isArray(resolved.tried) ? resolved.tried : [];
    out.push(check('claude', t('doctor.label.claude'), 'fail', t('doctor.claudeMissing'), {
      hint: [t('launch.noClaudeInstall'), ...tried.slice(0, 12)].join('\n')
    }));
  }

  // ── 4. THE ISOLATION SELF-TEST — the primitive the whole tool rests on ────
  if (resolved.path) {
    try {
      const iso = await verifyIsolation(ctx, { bin: resolved.path, force: true });
      if (iso && iso.ok) {
        out.push(check('isolation', t('doctor.label.isolation'), 'ok', t('doctor.isolationOk')));
      } else {
        // The probe fails in two different ways: it proved the config dirs are
        // shared, or it returned nothing readable (a timeout, or output a newer
        // Claude Code changed). Reporting both as isolationFail asserted an
        // observation that was never made, so the probe's own verdict is the
        // headline and only the remedy lines stay in the hint.
        const detail = iso && iso.detail ? String(iso.detail) : t('doctor.isolationFail');
        out.push(check('isolation', t('doctor.label.isolation'), 'fail', detail, {
          hint: [
            t('add.unsafeCause'),
            t('add.unsafeCauseDetail'),
            t('add.unsafeTryDetail')
          ].filter(Boolean).join('\n')
        }));
      }
    } catch (e) {
      // A probe that threw observed nothing either: it is unreadable, not proof.
      // The remedy differs from the proven-shared case — there is nothing to
      // unset here, the probe simply produced no answer — so it gets its own hint.
      out.push(check('isolation', t('doctor.label.isolation'), 'fail', t('doctor.isolationUnreadable'), {
        hint: `${t('doctor.isolationUnreadableHint')}\n${t('err.unexpected', { message: String(e && e.message ? e.message : e) })}`
      }));
    }
  } else {
    out.push(check('isolation', t('doctor.label.isolation'), 'skip', t('doctor.isolationSkipped'), {
      hint: t('doctor.deepHint')
    }));
  }

  // ── 5. credential backend, for the default dir and for each profile ──────
  try {
    const backend = detectBackend(ctx, dflt.configDir);
    let detail;
    if (backend.kind === 'keychain') detail = t('doctor.credentialsKeychain');
    else if (backend.kind === 'credman') detail = t('doctor.credentialsCredman');
    else {
      detail = t('doctor.credentialsFile', { path: backend.location || dflt.credentialsFile });
      if (ctx.platform === 'win32' && !ctx.env[CREDMAN_FLAG]) detail += `  ${t('doctor.credmanOff')}`;
    }
    let status = 'ok';
    /** @type {string[]} */
    const notes = [];

    const mixed = new Set();
    for (const p of real) {
      try {
        const b = detectBackend(ctx, p.dir);
        if (b.kind !== backend.kind) mixed.add(`${p.name}: ${b.kind}`);
      } catch {
        /* a profile whose backend cannot be detected is reported per profile */
      }
    }
    if (mixed.size) {
      status = 'warn';
      notes.push([...mixed].join(', '));
    }

    if (ctx.platform === 'darwin') {
      const secOk = await securityAvailable(ctx);
      if (!secOk) {
        status = 'warn';
        notes.push(t('add.keychainWarn'));
      }
    }

    if (ctx.platform === 'win32' && ctx.env[CREDMAN_FLAG]) {
      try {
        const probe = await runCapture(ctx, 'cmdkey', ['/list'], { timeoutMs: 10000 });
        const hit = /claude|anthropic/i.test(String(probe && probe.stdout ? probe.stdout : ''));
        if (!hit) {
          status = 'warn';
          notes.push(`${CREDMAN_FLAG}=1, cmdkey /list: 0`);
        }
      } catch {
        /* cmdkey missing is not a failure of cam */
      }
    }

    out.push(check('credentials', t('doctor.label.credentials'), status, detail,
      notes.length ? { hint: notes.join('\n') } : {}));
  } catch (e) {
    out.push(check('credentials', t('doctor.label.credentials'), 'warn',
      t('err.unexpected', { message: String(e && e.message ? e.message : e) })));
  }

  // ── 6. ambient environment — names only, never a value ───────────────────
  try {
    const ambient = describeAmbient(ctx);
    const hostile = ambient.filter((v) => v.present && v.hostile);
    if (hostile.length === 0) {
      out.push(check('ambient', t('doctor.label.ambient'), 'ok', t('doctor.ambientOk')));
    } else {
      const names = hostile.map((v) => v.name).join(', ');
      const lines = hostile.map((v) => (keepEnv
        ? t('which.ambientKept', { name: v.name })
        : t('launch.stripped', { name: v.name, impact: v.impact })));
      if (keepEnv) lines.push(t('launch.keepEnv'));
      else lines.push(t('launch.strippedKeep'));
      out.push(check('ambient', t('doctor.label.ambient'), 'fail', t('doctor.ambientBad', { names }), {
        hint: lines.join('\n')
      }));
    }
  } catch (e) {
    out.push(check('ambient', t('doctor.label.ambient'), 'warn',
      t('err.unexpected', { message: String(e && e.message ? e.message : e) })));
  }

  // ── 7. raw-mode capability, with the git-bash/mintty diagnosis ───────────
  try {
    const raw = probeRawMode(ctx);
    const inter = interactivity(ctx, { forwarded: [] });
    if (inter.kind === 'raw') {
      out.push(check('terminal', t('doctor.label.terminal'), 'ok', t('doctor.terminalRaw')));
    } else if (inter.kind === 'line') {
      out.push(check('terminal', t('doctor.label.terminal'), 'warn', t('doctor.terminalLine'), {
        hint: [
          shellId ? `${shellId}: ${t('pick.notty')}` : t('pick.notty'),
          t('pick.nottyHint'),
          raw && raw.reason ? reasonText(ctx, raw.reason) : t('pick.reason.rawUnavailable')
        ].join('\n')
      }));
    } else {
      out.push(check('terminal', t('doctor.label.terminal'), 'warn', t('doctor.terminalNone'), {
        hint: t('launch.cannotAsk', {
          reason: reasonText(ctx, inter.reason) || t('pick.reason.notATty')
        })
      }));
    }
  } catch (e) {
    out.push(check('terminal', t('doctor.label.terminal'), 'warn',
      t('err.unexpected', { message: String(e && e.message ? e.message : e) })));
  }

  // ── 8. the store: existence, size, permissions, MAX_PATH budget ──────────
  let storeBytes = 0;
  try {
    storeBytes = await dirSize(paths.root);
  } catch {
    storeBytes = 0;
  }
  const storeThere = await exists(paths.root);
  out.push(check('store', t('doctor.label.store'), storeThere ? 'ok' : 'warn',
    `${t('doctor.storeOk', { root: paths.root })} · ${humanSize(storeBytes)}`,
    storeThere ? {} : { hint: t('err.noAccountsHint') }));

  if (ctx.platform === 'win32') {
    // chmod is a genuine no-op here; saying otherwise would imply protection
    // that does not exist.
    out.push(check('permissions', t('doctor.label.permissions'), 'warn', t('doctor.permissionsWindows')));
  } else {
    /** @type {string[]} */
    const loose = [];
    const candidates = [paths.root, paths.profilesDir];
    for (const p of real) {
      candidates.push(p.dir);
      const cp = claudePaths(ctx, p.dir);
      candidates.push(cp.configFile, cp.credentialsFile);
    }
    for (const p of candidates) {
      try {
        const st = await stat(p);
        const mode = st.mode & 0o777;
        if (mode & 0o077) loose.push(p);
      } catch {
        /* absent paths are reported by their own check */
      }
    }
    out.push(loose.length
      ? check('permissions', t('doctor.label.permissions'), 'warn',
        t('doctor.permissionsLoose', { path: loose[0] }),
        { hint: loose.slice(1).join('\n') || t('doctor.fixHint'), fixable: true })
      : check('permissions', t('doctor.label.permissions'), 'ok', t('doctor.permissionsOk')));
  }

  try {
    const risk = pathTooLongRisk(ctx, paths.profilesDir);
    out.push(risk && risk.risk
      ? check('pathLength', t('doctor.label.pathLength'), 'warn', t('doctor.pathTight', { len: risk.len }), { hint: t('doctor.pathFix') })
      : check('pathLength', t('doctor.label.pathLength'), 'ok', t('doctor.pathOk', { len: risk ? risk.len : paths.profilesDir.length })));
  } catch {
    out.push(check('pathLength', t('doctor.label.pathLength'), 'ok', t('doctor.pathOk', { len: paths.profilesDir.length })));
  }

  // ── 9. link capability, proven by making and removing one ────────────────
  const probeRoot = join(paths.root, '.cam-linkprobe');
  try {
    await ensureDir(ctx, probeRoot, 0o700);
    const target = join(probeRoot, 'target');
    const linkPath = join(probeRoot, 'link');
    await mkdir(target, { recursive: true });
    const mode = await linkDir(ctx, target, linkPath);
    const ours = mode === 'link' ? await isOurLink(ctx, linkPath) : false;
    if (mode === 'link' && ours) {
      out.push(check('links', t('doctor.label.links'), 'ok',
        ctx.platform === 'win32' ? t('doctor.linksOk') : t('doctor.linksSymlink')));
    } else if (mode === 'copy') {
      out.push(check('links', t('doctor.label.links'), 'warn', t('doctor.linksFail'), {
        hint: t('share.mode.copy')
      }));
    } else {
      out.push(check('links', t('doctor.label.links'), 'warn', t('doctor.linksFail'), {
        hint: t('share.mode.skip')
      }));
    }
  } catch (e) {
    out.push(check('links', t('doctor.label.links'), 'warn', t('doctor.linksFail'), {
      hint: t('err.unexpected', { message: String(e && e.message ? e.message : e) })
    }));
  } finally {
    try {
      await rmrf(ctx, probeRoot);
    } catch {
      /* the probe directory is inside the store and harmless if it lingers */
    }
  }

  // ── 10. per-profile health, share links and the half-identity detector ───
  if (deep && ctx.platform === 'darwin' && real.length) {
    // Say this BEFORE the per-profile loop raises anything.
    out.push(check('deepKeychain', t('doctor.label.credentials'), 'skip',
      t('doctor.deepKeychainWarn'), { hint: t('doctor.credentialsKeychain') }));
  }

  for (const p of real) {
    const id = `profile:${p.name}`;
    const cp = claudePaths(ctx, p.dir);
    if (!(await exists(p.dir))) {
      out.push(check(id, p.name, 'fail', t('doctor.profileSignedOut', { name: p.name })));
      continue;
    }

    const cfg = await readJsonSafe(ctx, cp.configFile, null);
    if (cfg === null && (await exists(cp.configFile))) {
      out.push(check(id, p.name, 'fail', t('err.json', { file: cp.configFile }), { hint: t('err.jsonHint') }));
      continue;
    }
    const hasIdentity = Boolean(cfg && cfg.oauthAccount && cfg.oauthAccount.emailAddress);

    const meta = await readMeta(ctx, p.dir);
    let broken = 0;
    let shareMode = null;
    for (const name of SHARE_DIRS) {
      if (!(await exists(join(p.dir, name)))) broken += 1;
    }
    for (const name of SHARE_FILES) {
      if (!(await exists(join(p.dir, name)))) broken += 1;
    }
    if (meta && meta.share && meta.share.mode) shareMode = t(`share.mode.${meta.share.mode}`);
    const linksOk = SHARE_DIRS.length + SHARE_FILES.length - broken;

    let size = 0;
    try {
      size = await dirSize(p.dir);
    } catch {
      size = 0;
    }

    const h = meta ? health(meta, now) : { status: 'signedout', label: t('health.signedout'), daysLeft: 0 };
    const credsLive = Boolean(meta && meta.refreshTokenExpiresAt && meta.refreshTokenExpiresAt > now);

    /** @type {'ok'|'warn'|'fail'|'skip'} */
    let status = 'ok';
    let detail;
    /** @type {string[]} */
    const hints = [];

    if (!hasIdentity && credsLive) {
      // HALF IDENTITY: credentials validate, but .claude.json has no
      // oauthAccount — the reproduced 'logged in but anonymous' state.
      status = 'warn';
      detail = t('doctor.profileHalfIdentity', { name: p.name });
      hints.push(t('launch.healSignedOut', { name: p.name }));
      hints.push(t('launch.healAction'));
    } else if (h.status === 'signedout' || !hasIdentity) {
      status = 'warn';
      detail = t('doctor.profileSignedOut', { name: p.name });
    } else if (h.status === 'expired') {
      status = 'fail';
      detail = t('doctor.profileExpired', { name: p.name });
    } else if (h.status === 'warn') {
      status = 'warn';
      detail = t('doctor.profileExpiring', { days: h.daysLeft });
    } else if (h.status === 'unknown') {
      status = 'ok';
      detail = t('doctor.profileUnknown');
    } else {
      detail = t('doctor.profileOk', { days: h.daysLeft, links: linksOk, size: humanSize(size) });
    }

    if (broken > 0) {
      if (status === 'ok') status = 'warn';
      hints.push(t('doctor.profileLinksBroken', { n: broken }));
    }
    if (shareMode) hints.push(shareMode);
    if (meta && meta.checkedAt) hints.push(relativeTime(meta.checkedAt, now, t));
    if (meta && meta.plan) hints.push(planLabel(meta.plan));
    if (!meta) hints.push(t('doctor.fixHint'));

    if (deep && resolved.path) {
      try {
        const st = await authStatus(ctx, { configDir: p.dir, bin: resolved.path });
        if (st && st.loggedIn === false) {
          status = 'warn';
          detail = t('doctor.profileSignedOut', { name: p.name });
        } else if (st && st.loggedIn === true && !st.email) {
          status = 'warn';
          detail = t('doctor.profileHalfIdentity', { name: p.name });
        }
      } catch {
        /* a deep probe that cannot run is not a finding about the profile */
      }
    }

    out.push(check(id, p.name, status, detail, {
      hint: hints.length ? hints.join(' · ') : undefined,
      fixable: broken > 0 || !meta
    }));
  }

  // ── 11. Claude Code version drift ────────────────────────────────────────
  if (claudeVer) {
    const range = await testedClaudeRange();
    const belowMin = compareVersions(claudeVer, range.min) < 0;
    const aboveMax = compareVersions(claudeVer, range.max) > 0;
    const seen = new Set();
    for (const p of real) {
      const meta = await readMeta(ctx, p.dir);
      if (meta && meta.claudeVersionSeen) seen.add(meta.claudeVersionSeen);
    }
    const drifted = [...seen].filter((v) => compareVersions(v, claudeVer) !== 0);
    if (belowMin || aboveMax || drifted.length) {
      out.push(check('claudeDrift', t('doctor.label.claude'), 'warn',
        t('doctor.claudeDrift', { version: claudeVer }), {
          hint: [
            t('doctor.claudeTested', { min: range.min, max: range.max }),
            t('doctor.migrationNote', { path: join('<configDir>', '.claude.json') }),
            drifted.length ? drifted.join(', ') : ''
          ].filter(Boolean).join('\n')
        }));
    }
  }

  // ── 12. shell hooks and the conflicts that silently kill them ────────────
  try {
    const st = await shellStatus(ctx);
    const installed = (Array.isArray(st) ? st : []).filter((s) => s && s.installed);
    const names = installed.map((s) => (s.version ? `${s.shell} (${s.version})` : s.shell)).join(' · ');
    /** @type {string[]} */
    const conflictLines = [];
    try {
      const cf = await shellConflicts(ctx);
      for (const c of cf || []) {
        conflictLines.push(c.kind === 'alias'
          ? t('shell.conflictAlias', { shell: c.shell })
          : t('shell.conflictFunction', { shell: c.shell, where: c.where }));
      }
    } catch {
      /* a shell we cannot inspect reports no conflict, not a false one */
    }
    if (installed.length === 0) {
      out.push(check('shellHook', t('doctor.label.shellHook'), 'warn', t('doctor.shellNone'),
        conflictLines.length ? { hint: conflictLines.join('\n') } : {}));
    } else {
      out.push(check('shellHook', t('doctor.label.shellHook'),
        conflictLines.length ? 'warn' : 'ok',
        t('doctor.shellOk', { targets: names }),
        conflictLines.length ? { hint: conflictLines.join('\n') } : {}));
    }
  } catch (e) {
    out.push(check('shellHook', t('doctor.label.shellHook'), 'warn',
      t('err.unexpected', { message: String(e && e.message ? e.message : e) })));
  }

  // ── 13. Claude Code's own plaintext config backups (it writes them, not cam) ──
  try {
    let n = 0;
    const backupsDir = join(dflt.configDir, 'backups');
    try {
      const entries = await readdir(backupsDir);
      n += entries.filter((f) => /^\.claude\.json\.backup(\.\d+)?$/.test(f)).length;
    } catch {
      /* no backups directory is the good case */
    }
    if (await exists(`${dflt.configFile}.backup`)) n += 1;
    out.push(n > 0
      ? check('backups', t('doctor.label.backups'), 'warn', t('doctor.backups', { n }), { hint: backupsDir })
      : check('backups', t('doctor.label.backups'), 'ok', t('doctor.backupsOk')));
  } catch (e) {
    out.push(check('backups', t('doctor.label.backups'), 'warn',
      t('err.unexpected', { message: String(e && e.message ? e.message : e) })));
  }

  return out;
}

/**
 * Render one check as report lines.
 * @param {object} ctx the cam context
 * @param {{ id: string, title: string, status: string, detail: string, hint?: string }} c the check
 * @param {object} caps terminal capabilities from tty.detectCaps
 * @returns {string[]} the rendered lines
 */
function renderCheck(ctx, c, caps) {
  const kind = c.status === 'skip' ? 'info' : c.status;
  const head = `${padEnd(c.title, LABEL_COLS)} ${c.detail}`;
  const lines = [statusLine(kind, head, caps)];
  if (c.hint) {
    const pad = ' '.repeat(LABEL_COLS + 3);
    for (const h of String(c.hint).split('\n')) {
      if (h) lines.push(`${pad}${h}`);
    }
  }
  return lines;
}

/**
 * `cam doctor` — run every check, render it, and exit 1 if anything failed.
 * @param {object} ctx the cam context
 * @param {string[]} args raw argv for the command
 * @returns {Promise<number>} the process exit code
 */
export async function cmdDoctor(ctx, args) {
  const t = ctx.t;
  const flags = parseDoctorArgs(args);
  const list = await checks(ctx, flags);
  const failures = list.filter((c) => c.status === 'fail').length;
  const warnings = list.filter((c) => c.status === 'warn').length;

  if (flags.json) {
    ctx.io.out.write(`${JSON.stringify(list, null, 2)}\n`);
    return failures > 0 ? EXIT.ERROR : EXIT.OK;
  }

  const caps = detectCaps(ctx, ctx.io.out);
  const lines = [];
  for (const c of list) lines.push(...renderCheck(ctx, c, caps));
  lines.push('');
  lines.push(t('doctor.summary', { failures, warnings }));
  if (!flags.fix && list.some((c) => c.fixable)) lines.push(t('doctor.fixHint'));
  if (!flags.deep) lines.push(t('doctor.deepHint'));
  ctx.io.out.write(`${plain(lines.join('\n'), writeCaps(ctx, ctx.io.out))}\n`);

  return failures > 0 ? EXIT.ERROR : EXIT.OK;
}

// ── cam shell ─────────────────────────────────────────────────────────────

/**
 * Translate a shell.js result action into its catalogue label.
 * @param {object} ctx the cam context
 * @param {string} action exactly what src/shell.js emits: created | appended |
 *   upgraded | unchanged | removed | absent | not-installed | conflict
 * @returns {string} the translated label
 */
function actionLabel(ctx, action) {
  // These names come from src/shell.js and are the ONLY ones it emits:
  // created | appended | upgraded | unchanged | removed | absent | conflict |
  // not-installed.
  // An earlier version of this switch invented 'installed' and 'updated', which
  // no code path produces, so every successful install fell through to the
  // default and reported "not installed" — after correctly writing the file.
  switch (String(action || '').toLowerCase()) {
    case 'created':
    case 'appended':
    case 'installed': return ctx.t('shell.installed');
    case 'upgraded':
    case 'updated': return ctx.t('shell.updated');
    case 'unchanged': return ctx.t('shell.unchanged');
    case 'removed': return ctx.t('shell.removed');
    case 'absent':
    // 'conflict' is a whole-file target (claude.fish) that the user wrote
    // themselves, which cam refuses to overwrite: nothing was installed, and
    // the shell.conflict* hints in the status block explain the clash.
    case 'conflict': return ctx.t('shell.conflictFile');
    case 'not-installed': return ctx.t('shell.absent');
    default: return ctx.t('shell.absent');
  }
}

/** The actions that mean cam successfully changed a file. */
const WROTE_ACTIONS = new Set(['created', 'appended', 'upgraded', 'installed', 'updated', 'removed']);

/**
 * `cam shell install|uninstall|status` — the driver for src/shell.js.
 * @param {object} ctx the cam context
 * @param {string[]} args raw argv for the command
 * @returns {Promise<number>} the process exit code
 */
export async function cmdShell(ctx, args) {
  const t = ctx.t;
  const { sub, dryRun, only, unknown } = parseShellArgs(args);
  const caps = detectCaps(ctx, ctx.io.out);

  if (unknown.length || (sub !== null && !['install', 'uninstall', 'status'].includes(sub))) {
    fail('USAGE', t('err.usage'), { hint: t('shell.usage') });
  }
  const action = sub || 'status';

  let targets = [];
  try {
    targets = await detectTargets(ctx);
  } catch {
    targets = [];
  }
  if (only) {
    const wanted = String(only).toLowerCase();
    const filtered = targets.filter((x) => String(x.shell || '').toLowerCase() === wanted);
    if (filtered.length === 0) {
      fail('USAGE', t('shell.unknownShell', { shell: only }), {
        hint: targets.map((x) => x.shell).join(', ') || t('shell.noTargets')
      });
    }
    targets = filtered;
  }

  /** @type {string[]} */
  const lines = [];

  // Conflicts are announced BEFORE anything is written: an alias named `claude`
  // outranks a function and would silently kill the hook.
  /** @type {Array<any>} */
  let conflictList = [];
  try {
    conflictList = await shellConflicts(ctx);
  } catch {
    conflictList = [];
  }
  for (const c of conflictList) {
    lines.push(statusLine('warn', c.kind === 'alias'
      ? t('shell.conflictAlias', { shell: c.shell })
      : t('shell.conflictFunction', { shell: c.shell, where: c.where }), caps));
  }

  if (action === 'status') {
    lines.push(t('shell.statusHeader'));
    let st = [];
    try {
      st = await shellStatus(ctx);
    } catch {
      st = [];
    }
    const rows = only
      ? st.filter((s) => String(s.shell || '').toLowerCase() === String(only).toLowerCase())
      : st;
    if (rows.length === 0) {
      lines.push(statusLine('warn', t('shell.noTargets'), caps));
    } else {
      for (const s of rows) {
        const file = s.file || s.path || '';
        lines.push(statusLine(s.installed ? 'ok' : 'info',
          `${t('shell.target', { shell: s.shell, file })}  ${actionLabel(ctx, s.installed ? 'installed' : 'absent')}`,
          caps));
      }
    }
    ctx.io.out.write(`${plain(lines.join('\n'), writeCaps(ctx, ctx.io.out))}\n`);
    return EXIT.OK;
  }

  if (targets.length === 0) {
    lines.push(statusLine('warn', t('shell.noTargets'), caps));
    ctx.io.out.write(`${plain(lines.join('\n'), writeCaps(ctx, ctx.io.out))}\n`);
    return EXIT.ERROR;
  }

  if (action === 'install') {
    const paths = storePaths(ctx);
    const camBin = ctx.argv0 || 'cam';

    if (dryRun) {
      // Ask the installer itself what it would write, rather than re-deriving
      // it here. A second implementation of the per-shell selection is exactly
      // how this preview came to show every target the POSIX stub pointing at
      // cam.ps1 — and a --dry-run that lies about what it will do to your rc
      // file is worse than having no --dry-run at all.
      const preview = await shellInstall(ctx, targets, {
        version: ctx.version, camBin, dryRun: true
      });
      for (const r of preview || []) {
        if (!r || typeof r.preview !== 'string') continue;
        lines.push(t('shell.target', { shell: r.shell, file: r.file || r.path || '' }));
        lines.push(r.preview);
        lines.push('');
      }
      lines.push(statusLine('info', t('shell.dryRun'), caps));
      ctx.io.out.write(`${plain(lines.join('\n'), writeCaps(ctx, ctx.io.out))}\n`);
      return EXIT.OK;
    }

    try {
      const written = await writeRuntime(ctx, { version: ctx.version, camBin });
      for (const f of written || []) lines.push(statusLine('ok', t('shell.wrote', { file: f }), caps));
    } catch (e) {
      fail('ERROR', t('err.io', { file: paths.shellDir }), {
        hint: t('err.ioHint'),
        cause: e
      });
    }

    const results = await shellInstall(ctx, targets, { version: ctx.version, camBin, dryRun: false });
    for (const r of results || []) {
      const file = r.file || r.path || '';
      lines.push(statusLine(WROTE_ACTIONS.has(String(r.action)) ? 'ok' : 'info',
        `${t('shell.target', { shell: r.shell, file })}  ${actionLabel(ctx, r.action)}`, caps));
      if (r.backup) lines.push(`  ${t('shell.backup', { file: r.backup })}`);
    }
    lines.push('');
    lines.push(t('shell.reopen'));
    lines.push(t('first.askUndo'));
    ctx.io.out.write(`${plain(lines.join('\n'), writeCaps(ctx, ctx.io.out))}\n`);
    return EXIT.OK;
  }

  // action === 'uninstall'
  const results = await shellUninstall(ctx, targets);
  let removed = 0;
  for (const r of results || []) {
    const file = r.file || r.path || '';
    if (r.action === 'removed') removed += 1;
    lines.push(statusLine(r.action === 'removed' ? 'ok' : 'info',
      `${t('shell.target', { shell: r.shell, file })}  ${actionLabel(ctx, r.action)}`, caps));
    if (r.backup) lines.push(`  ${t('shell.backup', { file: r.backup })}`);
  }
  lines.push('');
  lines.push(t('shell.uninstalled', { n: removed }));
  lines.push(t('shell.reopen'));
  ctx.io.out.write(`${plain(lines.join('\n'), writeCaps(ctx, ctx.io.out))}\n`);
  return EXIT.OK;
}
