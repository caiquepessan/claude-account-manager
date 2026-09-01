// test/fs.test.js — every test that touches a filesystem or spawns a process.
//
// Items 12-19 of the agreed test plan: atomic writes and the one-time backup,
// store tolerance, profile-creation atomicity, THE CATASTROPHIC-DELETE GUARD,
// the shell install cycle, shell snippet content, launch end-to-end, and the
// no-token-leak sweep.
//
// ISOLATION CONTRACT FOR THIS FILE
//   * Every byte written lives under one mkdtemp() directory per suite.
//   * The user's home directory is NEVER read and NEVER derived: this file does
//     not call os.homedir(), and a test at the bottom proves it by scanning its
//     own source. `ctx.home` is always a temp directory, so `~/.claude` and
//     `~/.claude-account-manager` are structurally unreachable.
//   * `claude` is never the real binary: a Node script stands in for it and is
//     started as `process.execPath <script>` — no shell, no Claude Code.
//   * POSIX-only assertions (0600/0700, directory fsync) are skipped on win32
//     and Windows-only ones skipped elsewhere; a guard that cannot run is
//     skipped OUT LOUD with t.skip(reason), never silently passed.

import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as account from '../src/commands/account.js';
import * as claude from '../src/claude.js';
import { createCtx, EXIT } from '../src/ctx.js';
import * as fsx from '../src/fsx.js';
import * as launch from '../src/commands/launch.js';
import * as profiles from '../src/profiles.js';
import * as shell from '../src/shell.js';

// ── platform switches ────────────────────────────────────────────────────────

const WIN = process.platform === 'win32';
const POSIX = !WIN;

// ── sandbox lifecycle ────────────────────────────────────────────────────────

/** Every temp root this file created, torn down in the single `after` hook. */
const ROOTS = [];

/**
 * A throwaway directory under the OS temp dir. Never derived from a home path.
 * @param {string} label short suite tag, only for human-readable temp names
 * @returns {string} the absolute root
 */
function mkRoot(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), `cam-test-${label}-`)));
  ROOTS.push(root);
  return root;
}

after(() => {
  // Runs even when a test above failed. Junctions/symlinks are unlinked first
  // so a recursive remove can never be tempted to walk through one.
  for (const root of ROOTS.reverse()) {
    try {
      unlinkAllLinks(root, 0);
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* a locked temp dir is the OS's problem, not the test's */
    }
  }
});

/**
 * Remove every link under `dir` without following any of them. Mirrors the rule
 * the production code follows, so cleanup can never be the thing that deletes
 * something outside the sandbox.
 * @param {string} dir directory to sweep
 * @param {number} depth recursion guard
 * @returns {void}
 */
function unlinkAllLinks(dir, depth) {
  if (depth > 24) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        fs.unlinkSync(p);
      } catch {
        try {
          fs.rmdirSync(p);
        } catch {
          /* ignore */
        }
      }
      continue;
    }
    if (entry.isDirectory()) unlinkAllLinks(p, depth + 1);
  }
}

// ── context construction ─────────────────────────────────────────────────────

/**
 * The handful of ambient variables a spawned `node` genuinely needs. Everything
 * else about the environment is invented by the test, so each ctx is a clean
 * fake machine (createCtx REPLACES env rather than merging it).
 */
const PASSTHROUGH = WIN
  ? ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'PATH', 'Path', 'NUMBER_OF_PROCESSORS']
  : ['PATH'];

/**
 * @param {Record<string, string>} [extra] variables this test wants
 * @returns {Record<string, string>} the child-safe environment
 */
function baseEnv(extra = {}) {
  const env = {};
  for (const key of PASSTHROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.LANG = 'en_US.UTF-8';
  env.NO_COLOR = '1';
  return { ...env, ...extra };
}

/**
 * A collecting stand-in for a non-TTY stream.
 * @returns {{isTTY: boolean, columns: number, rows: number, write: Function, text: Function}} the stream
 */
function memStream() {
  const chunks = [];
  return {
    isTTY: false,
    columns: 80,
    rows: 24,
    write(s) {
      chunks.push(String(s));
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}

/**
 * Build a cam context pinned to a sandbox. `now` advances only when a test asks.
 * @param {{home: string, env?: object, platform?: string, now?: number, spawn?: Function}} opts inputs
 * @returns {{ctx: object, io: object, advance: Function, at: Function}} the harness
 */
function makeCtx(opts) {
  const io = { out: memStream(), err: memStream(), in: { isTTY: false } };
  let clock = Number.isFinite(opts.now) ? opts.now : 1_700_000_000_000;
  const ctx = createCtx({
    argv: [process.execPath, 'cam'],
    platform: opts.platform || process.platform,
    home: opts.home,
    cwd: opts.home,
    locale: 'en',
    env: baseEnv(opts.env || {}),
    io,
    now: () => clock,
    spawn: opts.spawn || nodeSpawn,
    version: '9.9.9',
    verbose: false,
    ascii: true,
  });
  return {
    ctx,
    io,
    advance: (ms) => {
      clock += ms;
    },
    at: () => clock,
  };
}

// ── the fake claude binary ───────────────────────────────────────────────────

/**
 * A stand-in for Claude Code, written into the sandbox and started as
 * `process.execPath <script>`. It honours `--version`, `auth status --json`,
 * `auth login`, and a bare invocation, and it records the environment it was
 * handed — which is how the child-environment assertions are made.
 */
const FAKE_CLAUDE_SRC = `'use strict';
// Stand-in for Claude Code. Never the real thing; started as: node this.cjs ...
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const env = process.env;
const dir = env.CLAUDE_CONFIG_DIR || null;

// 108 characters each, exactly like the real ones, so the leak sweep has
// something real to catch if cam ever copies one into a file it owns.
const TOKEN_ACCESS = 'sk-ant-oat01-' + 'A'.repeat(95);
const TOKEN_REFRESH = 'sk-ant-ort01-' + 'R'.repeat(95);

function dump(kind) {
  const base = env.CAM_FAKE_DUMP;
  if (!base) return;
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.writeFileSync(base + '.' + kind + '.json', JSON.stringify({
    kind: kind,
    argv: argv,
    cwd: process.cwd(),
    hasConfigDir: Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CONFIG_DIR'),
    configDir: dir,
    env: Object.assign({}, env)
  }, null, 2));
}

function identity() {
  return {
    uuid: env.CAM_FAKE_UUID || '11111111-2222-3333-4444-555555555555',
    email: env.CAM_FAKE_EMAIL || 'fake@example.com',
    org: env.CAM_FAKE_ORG || 'Fake Org'
  };
}

if (argv.indexOf('--version') !== -1) {
  process.stdout.write('9.9.9 (Claude Code)\\n');
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  dump('auth-status');
  const ok = !!(dir && fs.existsSync(path.join(dir, '.credentials.json')));
  const id = identity();
  process.stdout.write(JSON.stringify({
    loggedIn: ok,
    authMethod: ok ? 'claude.ai' : 'none',
    apiProvider: null,
    analyticsDisabled: false,
    projectsDirectory: null,
    email: ok ? id.email : null,
    orgId: ok ? 'org-fake-1' : null,
    orgName: ok ? id.org : null,
    subscriptionType: ok ? 'max' : null
  }) + '\\n');
  // Verified behaviour of the real binary: exits 1 when logged out, but the
  // JSON on stdout is still valid.
  process.exit(ok ? 0 : 1);
}

if (argv[0] === 'auth' && argv[1] === 'login') {
  dump('auth-login');
  const code = Number(env.CAM_FAKE_LOGIN_EXIT || 0);
  if (code !== 0) process.exit(code);
  if (!dir) process.exit(1);
  const id = identity();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: TOKEN_ACCESS,
      refreshToken: TOKEN_REFRESH,
      expiresAt: Number(env.CAM_FAKE_EXPIRES || 0) || (Date.now() + 8 * 3600 * 1000),
      refreshTokenExpiresAt: Number(env.CAM_FAKE_REFRESH_EXPIRES || 0)
        || (Date.now() + 30 * 86400 * 1000),
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max'
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
    userID: 'fake-user-id',
    hasCompletedOnboarding: true,
    oauthAccount: {
      accountUuid: id.uuid,
      emailAddress: id.email,
      organizationName: id.org,
      organizationType: 'claude_max',
      organizationUuid: 'org-fake-1'
    }
  }, null, 2));
  process.exit(0);
}

dump('launch');
if (env.CAM_FAKE_SIGNAL) {
  process.kill(process.pid, env.CAM_FAKE_SIGNAL);
  setTimeout(function () { process.exit(99); }, 5000);
} else {
  process.exit(Number(env.CAM_FAKE_EXIT || 0));
}
`;

/**
 * Drop the fake binary into a sandbox.
 * The path cam resolves carries a `.exe` extension on Windows and none on POSIX
 * so that `classifyKind` answers 'exe' on both, which keeps `spawnSpec` from
 * routing the spawn through cmd.exe. The file itself is never executed: the
 * injected `ctx.spawn` swaps it for `process.execPath <script>`.
 * @param {string} root sandbox root
 * @returns {{bin: string, script: string, dumpBase: string}} the fake install
 */
function installFakeClaude(root) {
  const binDir = path.join(root, 'fakebin');
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, 'fake-claude.cjs');
  fs.writeFileSync(script, FAKE_CLAUDE_SRC, 'utf8');
  const bin = path.join(binDir, WIN ? 'claude.exe' : 'claude');
  fs.writeFileSync(bin, '# stand-in; never executed directly\n', 'utf8');
  if (POSIX) fs.chmodSync(bin, 0o755);
  return { bin, script, dumpBase: path.join(root, 'dump', 'run') };
}

/**
 * A `ctx.spawn` that redirects the fake binary to `node <script>`.
 * @param {{bin: string, script: string}} fake the fake install
 * @returns {Function} a spawn function
 */
function fakeSpawner(fake) {
  const same = (a, b) => (WIN
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b));
  return (file, args, options) => {
    if (typeof file === 'string' && same(file, fake.bin)) {
      return nodeSpawn(process.execPath, [fake.script, ...(args || [])], options);
    }
    return nodeSpawn(file, args, options);
  };
}

/**
 * Read one of the fake's environment dumps.
 * @param {string} dumpBase the CAM_FAKE_DUMP prefix
 * @param {string} kind 'launch' | 'auth-login' | 'auth-status'
 * @returns {object|null} the record, or null when the fake never ran that way
 */
function readDump(dumpBase, kind) {
  const file = `${dumpBase}.${kind}.json`;
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Delete every dump so the next assertion cannot read a stale one.
 * @param {string} dumpBase the CAM_FAKE_DUMP prefix
 * @returns {void}
 */
function clearDumps(dumpBase) {
  const dir = path.dirname(dumpBase);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true });
}

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * Write a plausible pre-existing Claude Code home: the 78 KB-shaped global
 * config plus a ~/.claude with shareable directories.
 * @param {string} home the sandbox home
 * @returns {void}
 */
function seedHome(home) {
  fs.writeFileSync(path.join(home, '.claude.json'), `${JSON.stringify({
    userID: 'default-user-id',
    hasCompletedOnboarding: true,
    numStartups: 412,
    firstStartTime: '2025-01-01T00:00:00.000Z',
    machineID: 'machine-abcdef',
    oauthAccount: {
      accountUuid: '00000000-1111-2222-3333-444444444444',
      emailAddress: 'default@example.com',
      organizationName: 'Default Org',
      organizationType: 'claude_max',
      organizationUuid: 'org-default',
    },
    mcpServers: { demo: { command: 'demo-server' } },
    projects: {
      '/work/repo': {
        hasTrustDialogAccepted: true,
        allowedTools: ['Bash(rm -rf /)'],
        history: [{ display: 'a previous prompt' }],
      },
    },
  }, null, 2)}\n`, 'utf8');
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'plugin.txt'), 'plugin payload', 'utf8');
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'skill.md'), '# skill', 'utf8');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# shared memory', 'utf8');
}

/**
 * Create a published profile directory by hand.
 * @param {string} store the CAM_HOME root
 * @param {string} name account name
 * @param {object} meta the .cam-meta.json body (merged over the defaults)
 * @param {{identity?: object|null|false, credentials?: object|null}} [extra] on-disk Claude files
 * @returns {string} the profile directory
 */
function seedProfile(store, name, meta, extra = {}) {
  const dir = path.join(store, 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  if (meta !== null) {
    fs.writeFileSync(
      path.join(dir, '.cam-meta.json'),
      `${JSON.stringify({ schema: 1, name, ...meta }, null, 2)}\n`,
      'utf8'
    );
  }
  if (extra.identity !== undefined && extra.identity !== false) {
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      extra.identity === null ? '{ this is not json' : `${JSON.stringify(extra.identity, null, 2)}\n`,
      'utf8'
    );
  }
  if (extra.credentials) {
    fs.writeFileSync(
      path.join(dir, '.credentials.json'),
      `${JSON.stringify(extra.credentials, null, 2)}\n`,
      'utf8'
    );
  }
  return dir;
}

// ── small utilities ──────────────────────────────────────────────────────────

/**
 * A content fingerprint of a whole tree that never follows a link.
 * @param {string} root directory to snapshot
 * @returns {string[]} sorted "relpath|kind|sha256" lines
 */
function snapshot(root) {
  const out = [];
  const walk = (dir, rel, depth) => {
    if (depth > 24) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        out.push(`${r}|link|${(() => {
          try {
            return fs.readlinkSync(p);
          } catch {
            return '?';
          }
        })()}`);
        continue;
      }
      if (entry.isDirectory()) {
        out.push(`${r}|dir|`);
        walk(p, r, depth + 1);
        continue;
      }
      out.push(`${r}|file|${createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
    }
  };
  walk(root, '', 0);
  return out.sort();
}

/**
 * Every regular file under a tree, links never followed.
 * @param {string} root directory to walk
 * @returns {string[]} absolute file paths
 */
function filesUnder(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 24) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.isFile()) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Create a directory link, answering how (or whether) it could be done. Windows
 * junctions need no elevation; a `dir` symlink does without Developer Mode.
 * @param {string} target the directory to point at
 * @param {string} linkPath where the link goes
 * @returns {'junction'|'dir'|null} the link type, or null when unsupported
 */
function tryLinkDir(target, linkPath) {
  for (const type of WIN ? ['junction', 'dir'] : ['dir']) {
    try {
      fs.symlinkSync(target, linkPath, type);
      return type;
    } catch {
      /* try the next flavour */
    }
  }
  return null;
}

/**
 * Run `fn` while counting the renames the production code performs. Every
 * durable write in cam ends in exactly one rename, so a count of 0 is a
 * machine-checkable proof that nothing was written.
 * @param {Function} fn the async body
 * @returns {Promise<{renames: number, value: any}>} the count and the result
 */
async function countingRenames(fn) {
  const real = fsp.rename;
  let renames = 0;
  fsp.rename = (...args) => {
    renames += 1;
    return real(...args);
  };
  try {
    const value = await fn();
    return { renames, value };
  } finally {
    fsp.rename = real;
  }
}

/**
 * @param {number} mode a stat mode
 * @returns {number} just the permission bits
 */
function perms(mode) {
  return mode & 0o777;
}

// ═════════════════════════════════════════════════════════════════════════════
// 12 — ATOMIC WRITE AND ONE-TIME BACKUP
// ═════════════════════════════════════════════════════════════════════════════

describe('12 — writeFileAtomic / backupOnce', () => {
  let root;
  let work;
  let h;

  before(() => {
    root = mkRoot('fsx');
    work = path.join(root, 'work');
    fs.mkdirSync(work, { recursive: true });
    h = makeCtx({ home: root, env: { CAM_HOME: path.join(root, 'store') } });
  });

  it('leaves no .tmp behind on success', async () => {
    const file = path.join(work, 'ok.json');
    await fsx.writeFileAtomic(h.ctx, file, 'hello\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello\n');
    const leftovers = fs.readdirSync(work).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'a .tmp file survived a successful write');
  });

  it('creates the parent directory when it is missing', async () => {
    const file = path.join(work, 'deep', 'nested', 'x.json');
    await fsx.writeJsonAtomic(h.ctx, file, { a: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  });

  it('a failed rename leaves the original byte-identical and removes the tmp', async () => {
    const file = path.join(work, 'precious.txt');
    const original = 'ORIGINAL CONTENT\n';
    fs.writeFileSync(file, original, 'utf8');
    const before = fs.readFileSync(file);

    const real = fsp.rename;
    fsp.rename = async () => {
      // EIO is deliberately NOT in fsx's RETRYABLE set, so this fails at once
      // rather than burning the bounded backoff loop.
      const err = new Error('simulated rename failure');
      err.code = 'EIO';
      throw err;
    };
    try {
      await assert.rejects(
        () => fsx.writeFileAtomic(h.ctx, file, 'REPLACEMENT\n'),
        (err) => err && err.name === 'CamError' && err.code === 'IO'
      );
    } finally {
      fsp.rename = real;
    }

    assert.deepEqual(fs.readFileSync(file), before, 'the original was damaged by a failed write');
    const leftovers = fs.readdirSync(work).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'the tmp file survived a failed rename');
  });

  it('backupOnce copies once and never overwrites the pre-cam original', async () => {
    const file = path.join(work, 'rc.txt');
    fs.writeFileSync(file, 'FIRST\n', 'utf8');

    const first = await fsx.backupOnce(h.ctx, file);
    assert.equal(first, `${file}.cam-backup`);
    assert.equal(fs.readFileSync(first, 'utf8'), 'FIRST\n');

    fs.writeFileSync(file, 'SECOND\n', 'utf8');
    const second = await fsx.backupOnce(h.ctx, file);
    assert.equal(second, null, 'backupOnce reported a second backup');
    assert.equal(
      fs.readFileSync(first, 'utf8'),
      'FIRST\n',
      'the one-time backup was overwritten with the later content'
    );
  });

  it('backupOnce answers null for a file that does not exist', async () => {
    assert.equal(await fsx.backupOnce(h.ctx, path.join(work, 'no-such-file')), null);
  });

  it('writeFileAtomic with backupOnce backs up exactly once across two writes', async () => {
    const file = path.join(work, 'seeded.json');
    fs.writeFileSync(file, '{"v":0}\n', 'utf8');
    await fsx.writeJsonAtomic(h.ctx, file, { v: 1 }, { backupOnce: true });
    await fsx.writeJsonAtomic(h.ctx, file, { v: 2 }, { backupOnce: true });
    assert.equal(fs.readFileSync(`${file}.cam-backup`, 'utf8'), '{"v":0}\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 2 });
  });

  it('refuses outright to write the three Claude-owned files', async () => {
    for (const target of [
      path.join(root, '.claude.json'),
      path.join(root, '.claude', '.claude.json'),
      path.join(root, '.claude', '.credentials.json'),
    ]) {
      await assert.rejects(
        () => fsx.writeFileAtomic(h.ctx, target, 'nope'),
        (err) => err && err.name === 'CamError' && err.code === 'UNSAFE',
        `writeFileAtomic did not refuse ${target}`
      );
      assert.equal(fs.existsSync(target), false, `${target} was created`);
    }
  });

  it('POSIX: honours the 0600 / 0700 mode bits', async (t) => {
    if (WIN) {
      t.skip('POSIX permission bits do not exist on win32; the store is protected by the NTFS profile ACL');
      return;
    }
    const dir = path.join(work, 'modes');
    await fsx.ensureDir(h.ctx, dir, 0o700);
    assert.equal(perms(fs.statSync(dir).mode), 0o700);

    const file = path.join(dir, 'secret.json');
    await fsx.writeJsonAtomic(h.ctx, file, { a: 1 }, { mode: 0o600 });
    assert.equal(perms(fs.statSync(file).mode), 0o600);

    fs.writeFileSync(path.join(dir, 'src.txt'), 'x', { mode: 0o644 });
    await fsx.copyFileIfExists(h.ctx, path.join(dir, 'src.txt'), path.join(dir, 'dst.txt'), 0o600);
    assert.equal(perms(fs.statSync(path.join(dir, 'dst.txt')).mode), 0o600);
  });

  it('win32: never chmods, because Windows has no chmod to honour', async (t) => {
    if (POSIX) {
      t.skip('this assertion is about the win32 branch of chmodIfPosix');
      return;
    }
    let chmods = 0;
    const real = fsp.chmod;
    fsp.chmod = (...args) => {
      chmods += 1;
      return real(...args);
    };
    try {
      await fsx.writeJsonAtomic(h.ctx, path.join(work, 'winmode.json'), { a: 1 }, { mode: 0o600 });
    } finally {
      fsp.chmod = real;
    }
    assert.equal(chmods, 0, 'chmod was called on win32');
  });

  it('attempts the directory fsync on POSIX and skips it on win32', async () => {
    // Both branches are driven on ANY host by handing fsx a ctx that claims the
    // other platform: fsyncDir keys off ctx.isPosix, and its failure is swallowed.
    const dir = path.join(work, 'fsync');
    fs.mkdirSync(dir, { recursive: true });

    const observe = async (platform) => {
      const opens = [];
      const real = fsp.open;
      fsp.open = (p, flags, mode) => {
        opens.push({ p: String(p), flags });
        return real(p, flags, mode);
      };
      try {
        const hh = makeCtx({ home: root, platform, env: { CAM_HOME: path.join(root, 'store') } });
        await fsx.writeFileAtomic(hh.ctx, path.join(dir, `${platform}.txt`), 'x');
      } finally {
        fsp.open = real;
      }
      return opens.some((o) => path.resolve(o.p) === path.resolve(dir) && o.flags === 'r');
    };

    assert.equal(await observe('linux'), true, 'no directory fsync was attempted on a POSIX ctx');
    assert.equal(await observe('win32'), false, 'a directory fsync was attempted on a win32 ctx');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13 — STORE TOLERANCE
// ═════════════════════════════════════════════════════════════════════════════

describe('13 — profiles.list tolerance', () => {
  let root;
  let store;
  let h;

  before(() => {
    root = mkRoot('store');
    store = path.join(root, 'store');
    seedHome(root);
    h = makeCtx({ home: root, env: { CAM_HOME: store } });

    // a valid meta
    seedProfile(store, 'alpha', {
      createdAt: 1000,
      lastUsedAt: 2000,
      accountUuid: 'uuid-alpha',
      email: 'alpha@example.com',
      orgName: 'Alpha Org',
      plan: 'max',
      backend: 'file',
      refreshTokenExpiresAt: 9_999_999_999_999,
    });

    // no meta, but a valid .claude.json to rebuild it from
    seedProfile(store, 'beta', null, {
      identity: {
        oauthAccount: {
          accountUuid: 'uuid-beta',
          emailAddress: 'beta@example.com',
          organizationName: 'Beta Org',
          organizationType: 'claude_max',
        },
      },
    });

    // no meta and an unparseable .claude.json
    seedProfile(store, 'gamma', null, { identity: null });

    // a half-made profile: hidden by its pending marker
    const pending = seedProfile(store, 'pendingone', { createdAt: 5 });
    fs.writeFileSync(
      path.join(pending, '.cam-pending'),
      JSON.stringify({ pid: process.pid, startedAt: 1, host: '' }),
      'utf8'
    );

    // a dot-prefixed directory: cam's own, never an account
    fs.mkdirSync(path.join(store, 'profiles', '.scratch'), { recursive: true });
    fs.writeFileSync(path.join(store, 'profiles', '.scratch', 'junk'), 'x', 'utf8');
  });

  it('lists the valid profile, rebuilds a missing meta and survives a corrupt one', async () => {
    const list = await profiles.list(h.ctx);
    const names = list.map((p) => p.name);
    assert.deepEqual(names.slice().sort(), ['alpha', 'beta', 'gamma']);

    const alpha = list.find((p) => p.name === 'alpha');
    assert.equal(alpha.email, 'alpha@example.com');
    assert.equal(alpha.signedOut, false);
    assert.equal(alpha.health.status, 'ok');

    const beta = list.find((p) => p.name === 'beta');
    assert.equal(beta.email, 'beta@example.com', 'the meta was not rebuilt from .claude.json');
    assert.equal(beta.accountUuid, 'uuid-beta');
    assert.equal(
      fs.existsSync(path.join(store, 'profiles', 'beta', '.cam-meta.json')),
      true,
      'the rebuilt meta was not persisted'
    );

    const gamma = list.find((p) => p.name === 'gamma');
    assert.equal(gamma.signedOut, true, 'a corrupt .claude.json must render as signed-out');
    assert.equal(gamma.health.status, 'signedout');
  });

  it('hides a .cam-pending directory and ignores a dot-prefixed one', async () => {
    const names = (await profiles.list(h.ctx)).map((p) => p.name);
    assert.equal(names.includes('pendingone'), false, 'an unpublished profile was listed');
    assert.equal(names.includes('.scratch'), false, 'a dot directory was listed as an account');
  });

  it('order is stable across repeated calls and unaffected by lastUsedAt', async () => {
    const first = (await profiles.list(h.ctx)).map((p) => p.name);
    const second = (await profiles.list(h.ctx)).map((p) => p.name);
    assert.deepEqual(second, first, 'the order moved between two identical calls');
    assert.equal(first[0], 'alpha', 'the oldest account is not first');

    // Recency must never reorder the menu: a list that reshuffles between
    // invocations sends a digit hotkey to the wrong organisation.
    const metaFile = path.join(store, 'profiles', 'alpha', '.cam-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.lastUsedAt = 9_000_000_000_000;
    fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    const third = (await profiles.list(h.ctx)).map((p) => p.name);
    assert.deepEqual(third, first, 'lastUsedAt changed the order');
  });

  it('an unreadable store yields an empty list rather than a crash', async () => {
    const empty = makeCtx({ home: root, env: { CAM_HOME: path.join(root, 'no-such-store') } });
    assert.deepEqual(await profiles.list(empty.ctx), []);
  });

  it('profiles.all puts the synthetic default account first', async () => {
    const all = await profiles.all(h.ctx);
    assert.equal(all[0].name, 'default');
    assert.equal(all[0].dir, null, 'the default account must have dir === null');
    assert.equal(all[0].isDefault, true);
    assert.equal(all[0].email, 'default@example.com');
    assert.deepEqual(all.slice(1).map((p) => p.name), ['alpha', 'beta', 'gamma']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 14 — CREATE IS ATOMIC AND macOS-SAFE
// ═════════════════════════════════════════════════════════════════════════════

describe('14 — profile creation: atomic, and never renamed', () => {
  /**
   * A fresh sandbox per test, because `cam add` mutates the whole store.
   * @param {Record<string, string>} [env] extra environment for the ctx
   * @returns {object} the harness plus the sandbox paths
   */
  const sandbox = (env = {}) => {
    const root = mkRoot('add');
    const store = path.join(root, 'store');
    seedHome(root);
    fs.mkdirSync(path.join(store, 'profiles'), { recursive: true });
    const fake = installFakeClaude(root);
    const h = makeCtx({
      home: root,
      spawn: fakeSpawner(fake),
      env: {
        CAM_HOME: store,
        CAM_CLAUDE_BIN: fake.bin,
        CAM_NO_PROMPT: '1',
        CAM_FAKE_DUMP: fake.dumpBase,
        ...env,
      },
    });
    return { root, store, fake, ...h };
  };

  it('a login that exits non-zero leaves profiles/ byte-identical', async () => {
    const sb = sandbox({ CAM_FAKE_LOGIN_EXIT: '3' });
    seedProfile(sb.store, 'existing', {
      createdAt: 10,
      accountUuid: 'uuid-existing',
      email: 'existing@example.com',
      backend: 'file',
    });
    const before = snapshot(path.join(sb.store, 'profiles'));

    const code = await account.cmdAdd(sb.ctx, ['newone']);
    assert.equal(code, EXIT.AUTH_FAILED, `cmdAdd returned ${code}; stderr: ${sb.io.err.text()}`);

    const login = readDump(sb.fake.dumpBase, 'auth-login');
    assert.ok(login, 'the fake login never ran');
    assert.equal(
      path.resolve(login.configDir),
      path.resolve(path.join(sb.store, 'profiles', 'newone')),
      'the login did not run inside profiles/<name>'
    );

    assert.deepEqual(
      snapshot(path.join(sb.store, 'profiles')),
      before,
      'a failed login left something behind in profiles/'
    );
  });

  it('--keep preserves the half-made directory with its pending marker', async () => {
    const sb = sandbox({ CAM_FAKE_LOGIN_EXIT: '3' });
    const code = await account.cmdAdd(sb.ctx, ['kept', '--keep', '--no-share']);
    assert.equal(code, EXIT.AUTH_FAILED, sb.io.err.text());

    const dir = path.join(sb.store, 'profiles', 'kept');
    assert.equal(fs.existsSync(dir), true, '--keep did not preserve the directory');
    assert.equal(
      fs.existsSync(path.join(dir, '.cam-pending')),
      true,
      'the kept directory lost its pending marker and would show up as an account'
    );
    // And it must still be invisible to the menu.
    assert.equal((await profiles.list(sb.ctx)).map((p) => p.name).includes('kept'), false);
  });

  it('a successful add publishes IN PLACE — no rename anywhere in the create path', async () => {
    const sb = sandbox({ CAM_FAKE_EMAIL: 'work@example.com', CAM_FAKE_UUID: 'uuid-work' });
    const expected = path.join(sb.store, 'profiles', 'work');

    // Every rename that happens between beginCreate and finishCreate is
    // recorded; the macOS Keychain service name is hashed from the directory
    // path, so a rename of the profile directory orphans the credential the
    // login just wrote. None may touch profiles/work.
    const { renames, value } = await countingRenames(() => account.cmdAdd(sb.ctx, ['work']));
    assert.equal(value, EXIT.OK, `cmdAdd returned ${value}; stderr: ${sb.io.err.text()}`);
    assert.ok(renames > 0, 'no atomic write happened at all, so the counter proves nothing');

    const login = readDump(sb.fake.dumpBase, 'auth-login');
    assert.ok(login, 'the fake login never ran');
    assert.equal(
      path.resolve(login.configDir),
      path.resolve(expected),
      'the login ran somewhere other than the final directory'
    );

    const published = await profiles.get(sb.ctx, 'work');
    assert.ok(published, 'the account was not published');
    assert.equal(
      path.resolve(published.dir),
      path.resolve(login.configDir),
      'THE macOS REGRESSION GUARD: the published directory is not the directory that was logged into'
    );
    assert.equal(published.email, 'work@example.com');
    assert.equal(published.accountUuid, 'uuid-work');
    assert.equal(
      fs.existsSync(path.join(expected, '.cam-pending')),
      false,
      'the pending marker survived publication'
    );
    assert.equal(await profiles.getLast(sb.ctx), 'work');
  });

  it('the login child is handed the profile directory, never the real home', async () => {
    const sb = sandbox({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-AMBIENTTOKENAMBIENTTOKENAMBIENT' });
    const code = await account.cmdAdd(sb.ctx, ['iso', '--no-share']);
    assert.equal(code, EXIT.OK, sb.io.err.text());

    const login = readDump(sb.fake.dumpBase, 'auth-login');
    assert.equal(login.env.CLAUDE_CONFIG_DIR, path.join(sb.store, 'profiles', 'iso'));
    assert.equal(
      Object.prototype.hasOwnProperty.call(login.env, 'CLAUDE_CODE_OAUTH_TOKEN'),
      false,
      'an ambient OAuth token reached the login child and would have made an empty directory look signed in'
    );
  });

  it('sweepPending removes a dead marker and keeps a live one', async () => {
    const sb = sandbox();
    const long = 25 * 60 * 60 * 1000;
    const startedAt = sb.at() - long;

    const dead = seedProfile(sb.store, 'deadone', null);
    fs.writeFileSync(path.join(dead, 'payload.txt'), 'x', 'utf8');
    fs.writeFileSync(
      path.join(dead, '.cam-pending'),
      JSON.stringify({ pid: 0x7ffffffe, startedAt, host: '' }),
      'utf8'
    );

    const live = seedProfile(sb.store, 'liveone', null);
    fs.writeFileSync(
      path.join(live, '.cam-pending'),
      JSON.stringify({ pid: process.pid, startedAt, host: '' }),
      'utf8'
    );

    const swept = await profiles.sweepPending(sb.ctx);
    assert.deepEqual(swept, ['deadone'], `sweepPending swept ${JSON.stringify(swept)}`);
    assert.equal(fs.existsSync(dead), false, 'the dead pending directory survived');
    assert.equal(fs.existsSync(live), true, 'a LIVE creation was swept out from under another cam process');
  });

  it('sweepPending leaves a young marker alone even when its pid is dead', async () => {
    const sb = sandbox();
    const young = seedProfile(sb.store, 'youngone', null);
    fs.writeFileSync(
      path.join(young, '.cam-pending'),
      JSON.stringify({ pid: 0x7ffffffe, startedAt: sb.at() - 1000, host: '' }),
      'utf8'
    );
    assert.deepEqual(await profiles.sweepPending(sb.ctx), []);
    assert.equal(fs.existsSync(young), true);
  });

  it('beginCreate refuses a second claim on the same name', async () => {
    const sb = sandbox();
    await profiles.beginCreate(sb.ctx, 'twice');
    await assert.rejects(
      () => profiles.beginCreate(sb.ctx, 'twice'),
      (err) => err && err.name === 'CamError' && err.code === 'CONFLICT'
    );
  });

  it('abortCreate is link-safe: it unlinks a shared junction instead of walking it', async (t) => {
    const sb = sandbox();
    const { dir } = await profiles.beginCreate(sb.ctx, 'shared');
    const target = path.join(sb.root, '.claude', 'plugins');
    const kind = tryLinkDir(target, path.join(dir, 'plugins'));
    if (!kind) {
      t.skip('this platform/user cannot create a directory symlink or junction (Windows without Developer Mode)');
      return;
    }
    await profiles.abortCreate(sb.ctx, 'shared');
    assert.equal(fs.existsSync(dir), false, 'the rolled-back directory survived');
    assert.equal(
      fs.existsSync(path.join(target, 'plugin.txt')),
      true,
      'the rollback followed the junction and deleted the shared plugins directory'
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 15 — THE CATASTROPHIC-DELETE GUARD
//
// This is the single most important test in the repository. A profile holds
// junctions/symlinks into the user's real ~/.claude/plugins and ~/.claude/skills.
// If the recursive delete followed one, `cam trash` + `cam purge` would destroy
// the user's real Claude Code installation. Every entry must be lstat'd first
// and every link unlinked WITHOUT recursion.
// ═════════════════════════════════════════════════════════════════════════════

describe('15 — purgeTree / rmrf never follow a link out of the store', () => {
  let root;
  let store;
  let h;
  let sentinel;

  before(() => {
    root = mkRoot('purge');
    store = path.join(root, 'store');
    fs.mkdirSync(path.join(store, 'trash'), { recursive: true });
    fs.mkdirSync(path.join(store, 'profiles'), { recursive: true });
    h = makeCtx({ home: root, env: { CAM_HOME: store } });

    // Stands in for the user's real ~/.claude: OUTSIDE the store, and full of
    // things whose loss would be unrecoverable.
    sentinel = path.join(root, 'real-claude');
    fs.mkdirSync(path.join(sentinel, 'plugins', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(sentinel, 'plugins', 'a.txt'), 'PLUGIN A', 'utf8');
    fs.writeFileSync(path.join(sentinel, 'plugins', 'deep', 'b.txt'), 'PLUGIN B', 'utf8');
    fs.writeFileSync(path.join(sentinel, 'credentials-ish.json'), 'PRECIOUS', 'utf8');
  });

  /**
   * Assert the sentinel and everything in it is untouched.
   * @returns {void}
   */
  const sentinelIntact = () => {
    assert.equal(fs.existsSync(sentinel), true, 'the sentinel directory itself was deleted');
    assert.equal(fs.readFileSync(path.join(sentinel, 'plugins', 'a.txt'), 'utf8'), 'PLUGIN A');
    assert.equal(fs.readFileSync(path.join(sentinel, 'plugins', 'deep', 'b.txt'), 'utf8'), 'PLUGIN B');
    assert.equal(fs.readFileSync(path.join(sentinel, 'credentials-ish.json'), 'utf8'), 'PRECIOUS');
  };

  it('purgeTree unlinks a link to an outside directory and does not recurse through it', async (t) => {
    const entry = path.join(store, 'trash', 'victim-1700000000000');
    fs.mkdirSync(path.join(entry, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(entry, 'trash-meta.json'), '{"id":"victim"}', 'utf8');
    fs.writeFileSync(path.join(entry, 'projects', 'session.json'), '{}', 'utf8');

    const linkPath = path.join(entry, 'plugins');
    const kind = tryLinkDir(path.join(sentinel, 'plugins'), linkPath);
    if (!kind) {
      t.skip('this platform/user cannot create a directory symlink or junction (Windows without Developer Mode); the guard could NOT be verified here');
      return;
    }
    // A nested one too, because the walk recurses before it deletes.
    const nestedLink = path.join(entry, 'projects', 'shared');
    const nestedKind = tryLinkDir(sentinel, nestedLink);

    const counts = await fsx.purgeTree(h.ctx, entry);

    assert.equal(fs.existsSync(entry), false, 'the trash entry survived the purge');
    assert.equal(counts.links, nestedKind ? 2 : 1, `links unlinked: ${JSON.stringify(counts)}`);
    // Exactly the two real files inside the entry. If the walk had descended
    // through either link it would have counted the sentinel's three files too.
    assert.equal(counts.files, 2, `the walk descended through a link: ${JSON.stringify(counts)}`);
    sentinelIntact();
  });

  it('rmrf unlinks a link to an outside directory and does not recurse through it', async (t) => {
    const doomed = path.join(store, 'profiles', 'doomed');
    fs.mkdirSync(doomed, { recursive: true });
    fs.writeFileSync(path.join(doomed, '.cam-meta.json'), '{}', 'utf8');

    const linkPath = path.join(doomed, 'skills');
    const kind = tryLinkDir(path.join(sentinel, 'plugins'), linkPath);
    if (!kind) {
      t.skip('this platform/user cannot create a directory symlink or junction (Windows without Developer Mode); the guard could NOT be verified here');
      return;
    }

    await fsx.rmrf(h.ctx, doomed);
    assert.equal(fs.existsSync(doomed), false, 'rmrf did not remove the directory');
    sentinelIntact();
  });

  it('a file symlink pointing outside the store is unlinked, never truncated', async (t) => {
    const entry = path.join(store, 'trash', 'victim-file-1700000000001');
    fs.mkdirSync(entry, { recursive: true });
    const linkPath = path.join(entry, 'creds-link.json');
    try {
      fs.symlinkSync(path.join(sentinel, 'credentials-ish.json'), linkPath, 'file');
    } catch {
      t.skip('this platform/user cannot create a file symlink (Windows without Developer Mode)');
      return;
    }
    const counts = await fsx.purgeTree(h.ctx, entry);
    assert.equal(counts.links, 1, JSON.stringify(counts));
    assert.equal(counts.files, 0, 'the link was counted (and deleted) as a real file');
    sentinelIntact();
  });

  it('purgeTree refuses any path that is not inside <store>/trash', async () => {
    for (const outside of [
      sentinel,
      path.join(store, 'profiles', 'alpha'),
      path.join(root, '..'),
      store,
    ]) {
      await assert.rejects(
        () => fsx.purgeTree(h.ctx, outside),
        (err) => err && err.name === 'CamError' && err.code === 'UNSAFE',
        `purgeTree agreed to delete ${outside}`
      );
    }
    sentinelIntact();
  });

  it('rmrf refuses any path outside the store root', async () => {
    for (const outside of [sentinel, root, path.join(root, 'real-claude', 'plugins')]) {
      await assert.rejects(
        () => fsx.rmrf(h.ctx, outside),
        (err) => err && err.name === 'CamError' && err.code === 'UNSAFE',
        `rmrf agreed to delete ${outside}`
      );
    }
    sentinelIntact();
  });

  it('a trash entry reached through a link is still refused by path, not by inode', async (t) => {
    // storePaths()/purgeTree compare resolved PATHS. A link whose own path sits
    // outside trash/ must be refused even though its target is inside.
    const alias = path.join(root, 'trash-alias');
    const kind = tryLinkDir(path.join(store, 'trash'), alias);
    if (!kind) {
      t.skip('this platform/user cannot create a directory symlink or junction');
      return;
    }
    await assert.rejects(
      () => fsx.purgeTree(h.ctx, path.join(alias, 'anything')),
      (err) => err && err.name === 'CamError' && err.code === 'UNSAFE'
    );
    // Remove the alias WITHOUT following it. `rmSync` refuses a directory
    // unless `recursive: true`, and a Windows junction reports as a directory —
    // but recursing is precisely what this test exists to forbid. unlink clears
    // a POSIX symlink; rmdir clears a junction without touching its target.
    try {
      fs.unlinkSync(alias);
    } catch {
      fs.rmdirSync(alias);
    }
    assert.equal(fs.existsSync(alias), false, 'the alias survived cleanup');
  });

  it('the end-to-end trash -> purge path is link-safe too', async (t) => {
    const sb = mkRoot('purge-e2e');
    const st = path.join(sb, 'store');
    fs.mkdirSync(path.join(st, 'profiles'), { recursive: true });
    const guard = path.join(sb, 'real-claude', 'plugins');
    fs.mkdirSync(guard, { recursive: true });
    fs.writeFileSync(path.join(guard, 'keep.txt'), 'KEEP', 'utf8');

    const hh = makeCtx({ home: sb, env: { CAM_HOME: st } });
    const dir = seedProfile(st, 'goner', {
      createdAt: 1,
      accountUuid: 'uuid-goner',
      email: 'goner@example.com',
      backend: 'file',
    });
    const kind = tryLinkDir(guard, path.join(dir, 'plugins'));
    if (!kind) {
      t.skip('this platform/user cannot create a directory symlink or junction');
      return;
    }

    const { id } = await profiles.trashProfile(hh.ctx, 'goner');
    assert.equal(fs.existsSync(dir), false, 'trashProfile did not move the directory');
    await profiles.purgeTrash(hh.ctx, id);

    assert.equal(fs.existsSync(path.join(st, 'trash', id)), false, 'the trash entry survived the purge');
    assert.equal(
      fs.readFileSync(path.join(guard, 'keep.txt'), 'utf8'),
      'KEEP',
      'cam purge followed a shared junction and destroyed data outside its store'
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 16 — THE SHELL INSTALL CYCLE
// ═════════════════════════════════════════════════════════════════════════════

describe('16 — the managed block: install, re-install, upgrade, uninstall', () => {
  let root;
  let h;
  let rcDir;

  const USER_HEAD = '# my prompt\r\nexport PS1="$ "\r\n';
  const USER_TAIL = 'alias ll="ls -la"\r\n';

  before(() => {
    root = mkRoot('shell');
    rcDir = path.join(root, 'rc');
    fs.mkdirSync(rcDir, { recursive: true });
    h = makeCtx({ home: root, env: { CAM_HOME: path.join(root, 'store') } });
  });

  /**
   * A fresh CRLF rc file with real user content around the block.
   * @param {string} name file name
   * @returns {string} the absolute path
   */
  const freshRc = (name) => {
    const file = path.join(rcDir, name);
    fs.writeFileSync(file, USER_HEAD + USER_TAIL, 'utf8');
    return file;
  };

  /**
   * @param {string} file the rc file
   * @returns {string[]} its `<file>.cam-backup-*` siblings
   */
  const backupsOf = (file) => fs
    .readdirSync(path.dirname(file))
    .filter((n) => n.startsWith(`${path.basename(file)}.cam-backup-`))
    .sort();

  it('runs the whole cycle on a CRLF file with pre-existing content', async () => {
    const file = freshRc('.bashrc');
    const original = fs.readFileSync(file, 'utf8');
    const runtimePath = path.join(root, 'store', 'shell', 'cam.sh');
    const v1 = shell.renderPosixStub(h.ctx, { version: '1.0.0', runtimePath });
    const v2 = shell.renderPosixStub(h.ctx, { version: '2.0.0', runtimePath });

    // 1 — install
    h.advance(1000);
    const a = await shell.patchFile(h.ctx, file, v1);
    assert.equal(a.action, 'appended');
    let text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith(USER_HEAD + USER_TAIL), 'the user content was rewritten');
    assert.ok(text.includes(shell.BEGIN) && text.includes(shell.END));
    assert.ok(text.includes('cam:1.0.0'));
    assert.equal(/(?<!\r)\n/.test(text), false, 'a bare LF was introduced into a CRLF file');
    assert.equal(backupsOf(file).length, 1, 'no backup was taken before the first modification');

    // 2 — install again: unchanged, and provably no write at all
    h.advance(1000);
    const backupsBefore = backupsOf(file);
    const { renames, value: b } = await countingRenames(() => shell.patchFile(h.ctx, file, v1));
    assert.equal(b.action, 'unchanged');
    assert.equal(renames, 0, 'a byte-identical re-install still wrote the file');
    assert.deepEqual(backupsOf(file), backupsBefore, 're-install created a spurious backup');
    assert.equal(fs.readFileSync(file, 'utf8'), text);

    // 3 — upgrade
    h.advance(1000);
    const c = await shell.patchFile(h.ctx, file, v2);
    assert.equal(c.action, 'upgraded');
    text = fs.readFileSync(file, 'utf8');
    assert.equal(text.split(shell.BEGIN).length - 1, 1, 'the upgrade left more than one marker pair');
    assert.equal(text.split(shell.END).length - 1, 1);
    assert.ok(text.includes('cam:2.0.0') && !text.includes('cam:1.0.0'));
    assert.ok(text.startsWith(USER_HEAD + USER_TAIL));
    assert.equal(/(?<!\r)\n/.test(text), false, 'CRLF was not preserved through the upgrade');
    assert.equal(backupsOf(file).length, 2, 'no backup was taken before the upgrade');

    // 4 — uninstall
    h.advance(1000);
    const d = await shell.patchFile(h.ctx, file, null);
    assert.equal(d.action, 'removed');
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      original,
      'removing the block did not restore the file byte-for-byte'
    );
    assert.equal(backupsOf(file).length, 3, 'no backup was taken before the removal');

    // 5 — uninstall again
    h.advance(1000);
    const { renames: r2, value: e } = await countingRenames(() => shell.patchFile(h.ctx, file, null));
    assert.equal(e.action, 'not-installed');
    assert.equal(r2, 0, 'a second uninstall wrote the file');
    assert.equal(backupsOf(file).length, 3);
  });

  it('creates a missing rc file with LF and reports "created"', async () => {
    const file = path.join(rcDir, '.zshrc');
    const block = shell.renderPosixStub(h.ctx, { version: '1.0.0', runtimePath: '/x/cam.sh' });
    const r = await shell.patchFile(h.ctx, file, block);
    assert.equal(r.action, 'created');
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes('\r\n'), false, 'a brand-new POSIX rc file got CRLF');
    assert.ok(text.endsWith('\n'));
  });

  it('the non-greedy block regexp never swallows the content between two stray pairs', async () => {
    // The failure this guards against: a greedy regexp matching from the FIRST
    // BEGIN to the LAST END would delete everything the user put in between.
    const file = path.join(rcDir, '.bashrc-doubled');
    const runtimePath = '/x/cam.sh';
    const v1 = shell.renderPosixStub(h.ctx, { version: '1.0.0', runtimePath });
    const middle = 'export IMPORTANT=1\r\n';
    fs.writeFileSync(file, `${USER_HEAD}${v1.replace(/\n/g, '\r\n')}\r\n${middle}${v1.replace(/\n/g, '\r\n')}\r\n${USER_TAIL}`, 'utf8');

    h.advance(1000);
    const r = await shell.patchFile(h.ctx, file, shell.renderPosixStub(h.ctx, { version: '2.0.0', runtimePath }));
    assert.equal(r.action, 'upgraded');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes(middle), 'the content between two stray marker pairs was destroyed');
    assert.ok(text.startsWith(USER_HEAD));
    assert.ok(text.includes(USER_TAIL));
    assert.equal(text.split(shell.BEGIN).length - 1, 1, 'the upgrade did not collapse to exactly one pair');
    assert.ok(text.includes('cam:2.0.0'));
  });

  it('DIVERGENCE FROM THE PLAN: uninstall removes EVERY marker pair, not just one', async () => {
    // The plan says "a file with two stray marker pairs loses only one block".
    // planPatch() removes with a GLOBAL regexp, so uninstall removes all of
    // them. That is defensible — every block is cam's — and it is the property
    // pinned here so a future change to either behaviour is a visible decision
    // rather than an accident. src/shell.js:669 `cur.replace(g, '')`.
    const file = path.join(rcDir, '.bashrc-doubled-remove');
    const v1 = shell.renderPosixStub(h.ctx, { version: '1.0.0', runtimePath: '/x/cam.sh' });
    const middle = 'export KEEPME=1\n';
    fs.writeFileSync(file, `${v1}\n${middle}${v1}\n`, 'utf8');

    h.advance(1000);
    const r = await shell.patchFile(h.ctx, file, null);
    assert.equal(r.action, 'removed');
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.split(shell.BEGIN).length - 1, 0, 'a marker pair survived the uninstall');
    assert.ok(text.includes(middle), 'the user content between the pairs was destroyed');
  });

  it('a foreign claude.fish is never deleted by uninstall', async () => {
    const file = path.join(rcDir, 'claude.fish');
    fs.writeFileSync(file, 'function claude\n  echo mine\nend\n', 'utf8');
    const results = await shell.uninstall(h.ctx, [
      { id: 'fish', shell: 'fish', file, kind: 'file', runtime: 'self' },
    ]);
    const row = results.find((r) => r.id === 'fish');
    assert.equal(row.action, 'not-installed');
    assert.equal(fs.readFileSync(file, 'utf8'), 'function claude\n  echo mine\nend\n');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 17 — SHELL SNIPPET CONTENT
// ═════════════════════════════════════════════════════════════════════════════

describe('17 — what the generated shell integration actually says', () => {
  let h;

  before(() => {
    const root = mkRoot('render');
    h = makeCtx({ home: root, env: { CAM_HOME: path.join(root, 'store') } });
  });

  it('the POSIX runtime forwards through `command "$cam_bin"` and sets CAM_TTY', () => {
    const text = shell.renderPosixRuntime(h.ctx, { version: '1.2.3', camBin: '/usr/local/bin/cam' });
    assert.ok(text.includes('command "$cam_bin"'), 'the hook does not run cam through `command`');
    assert.ok(/CAM_TTY=/.test(text), 'CAM_TTY is never set, so git-bash loses the menu');
    assert.ok(text.includes('CAM_TTY=1'), 'the interactive branch does not set CAM_TTY=1');
    assert.ok(text.includes('CAM_TTY=0'), 'the non-interactive branch does not set CAM_TTY=0');
    assert.ok(text.includes('[ -t 0 ] && [ -t 2 ]'), 'CAM_TTY is not derived from the shell\'s own tty test');
  });

  it('the POSIX runtime resolves the real claude in a subshell that unsets the function', () => {
    const text = shell.renderPosixRuntime(h.ctx, { version: '1.2.3', camBin: null });
    // `command -v claude` from inside a function named `claude` answers the
    // string "claude" — the lookup MUST unset the function first, in a subshell
    // so the caller's own definition survives.
    assert.ok(
      /\(\s*unset -f claude[^)]*command -v claude[^)]*\)/.test(text),
      'the real-claude lookup is not a subshell that unsets the function first'
    );
    assert.ok(
      /\(\s*unset -f cam[^)]*command -v cam[^)]*\)/.test(text),
      'the cam lookup is not a subshell that unsets the function first'
    );
  });

  it('the POSIX runtime contains no `exec ` — exec in an interactive function kills the shell', () => {
    const text = shell.renderPosixRuntime(h.ctx, { version: '1.2.3', camBin: '/usr/local/bin/cam' });
    assert.equal(text.includes('exec '), false, '`exec ` appears in the POSIX runtime');
    const fish = shell.renderFish(h.ctx, { version: '1.2.3', camBin: '/usr/local/bin/cam' });
    assert.equal(fish.includes('exec '), false, '`exec ` appears in the fish function');
  });

  it('the generated POSIX artefacts are LF-only and carry the version stamp', () => {
    for (const text of [
      shell.renderPosixRuntime(h.ctx, { version: '1.2.3', camBin: null }),
      shell.renderPosixStub(h.ctx, { version: '1.2.3', runtimePath: '/x/cam.sh' }),
      shell.renderFish(h.ctx, { version: '1.2.3', camBin: null }),
    ]) {
      assert.equal(text.includes('\r'), false, 'a CR leaked into a generated POSIX artefact');
      assert.ok(text.includes('cam:1.2.3'), 'the version stamp is missing');
    }
  });

  it('the PowerShell block bypasses its own function and restores CAM_TTY in a finally', () => {
    const text = shell.renderPowerShell(h.ctx, { version: '1.2.3', camBin: 'C:\\bin\\cam.cmd' });
    assert.ok(
      text.includes("GetCommand('claude','Application')"),
      'the fallback does not constrain the lookup to CommandType Application, so it can recurse into itself'
    );
    assert.ok(
      text.includes("Get-Command cam -CommandType Application"),
      'the cam lookup is not constrained to an Application'
    );
    assert.ok(/\}\s*finally\s*\{[^}]*CAM_TTY/.test(text), 'CAM_TTY is not restored in a finally block');
    assert.ok(
      text.includes('Remove-Item Env:CAM_TTY'),
      'CAM_TTY is not removed again when it was previously unset'
    );
    assert.ok(text.includes('& $cam launch -- @args'), 'the block does not forward @args to `cam launch --`');
    assert.ok(text.includes('cam:1.2.3'));
  });

  it('an embedded absolute cam path is quoted for its own shell', () => {
    const posix = shell.renderPosixRuntime(h.ctx, { version: '1', camBin: "/opt/o'brien/cam" });
    assert.ok(posix.includes("/opt/o'\\''brien/cam"), "a single quote in the cam path was not sh-escaped");
    const ps = shell.renderPowerShell(h.ctx, { version: '1', camBin: "C:\\o'brien\\cam.cmd" });
    assert.ok(ps.includes("C:\\o''brien\\cam.cmd"), 'a single quote in the cam path was not PowerShell-escaped');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 18 — LAUNCH END-TO-END WITH A FAKE CLAUDE BINARY
// ═════════════════════════════════════════════════════════════════════════════

describe('18 — launch end-to-end', () => {
  const HOSTILE = 'CLAUDE_CODE_OAUTH_TOKEN';
  const HOSTILE_VALUE = 'sk-ant-oat01-HOSTILEHOSTILEHOSTILEHOSTILEHOSTILE';

  /**
   * A store with a `default` identity and one real profile, plus the fake binary.
   * @param {Record<string, string>} [env] extra environment
   * @returns {object} the harness plus paths
   */
  const sandbox = (env = {}) => {
    const root = mkRoot('launch');
    const store = path.join(root, 'store');
    seedHome(root);
    fs.mkdirSync(path.join(store, 'profiles'), { recursive: true });
    const fake = installFakeClaude(root);
    const now = 1_700_000_000_000;
    const workDir = seedProfile(
      store,
      'work',
      {
        createdAt: now - 86_400_000,
        lastUsedAt: null,
        launchCount: 0,
        accountUuid: 'uuid-work',
        email: 'work@example.com',
        orgName: 'Work Org',
        plan: 'max',
        backend: 'file',
        expiresAt: now + 8 * 3600 * 1000,
        refreshTokenExpiresAt: now + 30 * 86_400_000,
        tokenFingerprint: 'abc123abc123',
      },
      {
        identity: {
          oauthAccount: {
            accountUuid: 'uuid-work',
            emailAddress: 'work@example.com',
            organizationName: 'Work Org',
            organizationType: 'claude_max',
          },
        },
        credentials: {
          claudeAiOauth: {
            accessToken: `sk-ant-oat01-${'W'.repeat(95)}`,
            refreshToken: `sk-ant-ort01-${'X'.repeat(95)}`,
            expiresAt: now + 8 * 3600 * 1000,
            refreshTokenExpiresAt: now + 30 * 86_400_000,
            scopes: ['user:inference'],
            subscriptionType: 'max',
          },
        },
      }
    );
    const h = makeCtx({
      home: root,
      now,
      spawn: fakeSpawner(fake),
      env: {
        CAM_HOME: store,
        CAM_CLAUDE_BIN: fake.bin,
        CAM_NO_PROMPT: '1',
        CAM_ASK: 'never',
        CAM_FAKE_DUMP: fake.dumpBase,
        [HOSTILE]: HOSTILE_VALUE,
        ...env,
      },
    });
    return { root, store, workDir, fake, ...h };
  };

  it('a profile child gets CLAUDE_CONFIG_DIR and loses every hostile variable', async () => {
    const sb = sandbox();
    const code = await launch.run(sb.ctx, ['--cam', 'work', '--', '-p', 'hello world']);
    assert.equal(code, 0, sb.io.err.text());

    const dump = readDump(sb.fake.dumpBase, 'launch');
    assert.ok(dump, 'the fake claude never ran');
    assert.equal(
      path.resolve(dump.env.CLAUDE_CONFIG_DIR),
      path.resolve(sb.workDir),
      'the child did not get the chosen profile directory'
    );
    assert.equal(dump.env.CAM_ACTIVE, 'work');
    assert.equal(
      Object.prototype.hasOwnProperty.call(dump.env, HOSTILE),
      false,
      `${HOSTILE} survived into a profile child and would have silently defeated the switch`
    );
    // The arguments are forwarded verbatim, spaces intact.
    assert.deepEqual(dump.argv, ['-p', 'hello world']);
  });

  it('the `default` account child gets NO CLAUDE_CONFIG_DIR key at all', async () => {
    const sb = sandbox();
    const code = await launch.run(sb.ctx, ['--cam', 'default', '--', '-p', 'hi']);
    assert.equal(code, 0, sb.io.err.text());

    const dump = readDump(sb.fake.dumpBase, 'launch');
    assert.equal(
      dump.hasConfigDir,
      false,
      'the default account set CLAUDE_CONFIG_DIR — it must be byte-for-byte the pre-existing behaviour'
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(dump.env, 'CLAUDE_CONFIG_DIR'),
      false,
      'CLAUDE_CONFIG_DIR reached the default account child'
    );
    assert.equal(
      dump.env[HOSTILE],
      HOSTILE_VALUE,
      'the default account had its environment altered; that is a regression cam introduced'
    );
  });

  it('the child exit code propagates unchanged', async () => {
    const sb = sandbox({ CAM_FAKE_EXIT: '42' });
    const code = await launch.run(sb.ctx, ['--cam', 'work', '--', '-p', 'x']);
    assert.equal(code, 42, 'the child exit code was rewritten');
  });

  it('a signalled child maps to 128 + signum', async (t) => {
    // The pure half runs everywhere.
    assert.equal(claude.exitCodeFor({ code: null, signal: 'SIGINT' }), 130);
    assert.equal(claude.exitCodeFor({ code: null, signal: 'SIGTERM' }), 143);
    assert.equal(claude.exitCodeFor({ code: 7, signal: null }), 7);

    if (WIN) {
      t.skip('Windows has no POSIX signals; a real SIGINT cannot be delivered to a child here');
      return;
    }
    const sb = sandbox({ CAM_FAKE_SIGNAL: 'SIGINT' });
    const code = await launch.run(sb.ctx, ['--cam', 'work', '--', '-p', 'x']);
    assert.equal(code, 130, 'an interrupted session did not report 130');
  });

  it('refreshMeta runs after the session exits', async () => {
    const sb = sandbox();
    const metaFile = path.join(sb.workDir, '.cam-meta.json');
    const before = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    assert.equal(before.launchCount, 0);
    assert.equal(before.lastUsedAt, null);

    sb.advance(0);
    const code = await launch.run(sb.ctx, ['--cam', 'work', '--', '-p', 'x']);
    assert.equal(code, 0, sb.io.err.text());

    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    assert.equal(meta.launchCount, 1, 'refreshMeta did not run after the child exited');
    assert.equal(meta.lastUsedAt, sb.at());
    assert.equal(meta.checkedAt, sb.at());

    // What refreshMeta may derive is a PROPERTY OF THE CREDENTIAL BACKEND, and
    // the backend differs by platform — so assert the platform's own contract
    // rather than the one this machine happens to have.
    if (process.platform === 'darwin') {
      // macOS is Keychain-backed, and credstore.summary deliberately reads
      // NOTHING there: opening the store would raise a Keychain prompt, and a
      // prompt must never be a side effect of drawing a menu. The cached values
      // are therefore carried forward untouched. This is the behaviour
      // SECURITY.md promises, so the test holds it to exactly that.
      assert.equal(
        meta.tokenFingerprint,
        'abc123abc123',
        'macOS must not open the credential store to refresh a fingerprint',
      );
      assert.equal(meta.backend, 'keychain');
    } else {
      // Linux and Windows are file-backed: the fingerprint is re-derived from
      // the live credentials file on every session, never copied forward.
      assert.match(meta.tokenFingerprint, /^[0-9a-f]{12}$/);
      assert.notEqual(meta.tokenFingerprint, 'abc123abc123', 'the stale fingerprint was not refreshed');
    }
  });

  it('the active account is remembered before the spawn, not after', async () => {
    const sb = sandbox({ CAM_FAKE_EXIT: '9' });
    assert.equal(await profiles.getLast(sb.ctx), null);
    await launch.run(sb.ctx, ['--cam', 'work', '--', '-p', 'x']);
    assert.equal(
      await profiles.getLast(sb.ctx),
      'work',
      'a session that ended badly forgot which account had been chosen'
    );
  });

  it('an unknown --cam name is a hard error, never a silent fallback', async () => {
    const sb = sandbox();
    await assert.rejects(
      () => launch.run(sb.ctx, ['--cam', 'nosuch', '--', '-p', 'x']),
      (err) => err && err.name === 'CamError' && err.code === 'NOT_FOUND' && err.exitCode === EXIT.NOT_FOUND
    );
    assert.equal(readDump(sb.fake.dumpBase, 'launch'), null, 'a claude session was started anyway');
  });

  it('--keep-env leaves the hostile variable in place and says so', async () => {
    const sb = sandbox();
    const code = await launch.run(sb.ctx, ['--cam', 'work', '--keep-env', '--', '-p', 'x']);
    assert.equal(code, 0, sb.io.err.text());
    const dump = readDump(sb.fake.dumpBase, 'launch');
    assert.equal(dump.env[HOSTILE], HOSTILE_VALUE, '--keep-env still stripped the variable');
    assert.equal(
      path.resolve(dump.env.CLAUDE_CONFIG_DIR),
      path.resolve(sb.workDir),
      '--keep-env must still point the child at the profile'
    );
    assert.ok(sb.io.err.text().length > 0, '--keep-env was applied silently');
  });

  it('a configured claudeBin is honoured on the hot path', async () => {
    // REGRESSION: launch.js used to call requireClaude(ctx, { override: … }),
    // but resolveClaude only reads `opts.claudeBin` / `opts.config.claudeBin`.
    // `override` is not a key it knows, so `cam config claudeBin <path>` had no
    // effect on a launch and cam silently started a different binary — while
    // `cam doctor`, which passes `{ config }`, reported the configured one.
    const sb = sandbox();
    fs.writeFileSync(
      path.join(sb.store, 'config.json'),
      JSON.stringify({ claudeBin: sb.fake.bin }, null, 2),
      'utf8'
    );
    delete sb.ctx.env.CAM_CLAUDE_BIN;

    // Both documented spellings must reach the configured binary.
    for (const opts of [{ claudeBin: sb.fake.bin }, { config: { claudeBin: sb.fake.bin } }]) {
      const got = claude.resolveClaude(sb.ctx, opts);
      assert.equal(
        got.path === null ? null : path.resolve(got.path),
        path.resolve(sb.fake.bin),
        `resolveClaude ignored ${JSON.stringify(Object.keys(opts))}`
      );
    }

    // And the value `run()` actually derives — through the real loadConfig, not
    // a hand-built object — reaches the same binary.
    const config = await profiles.loadConfig(sb.ctx);
    assert.equal(config.claudeBin, sb.fake.bin, 'loadConfig did not read claudeBin from config.json');
    const viaConfig = claude.resolveClaude(sb.ctx, { claudeBin: config.claudeBin });
    assert.equal(
      viaConfig.path === null ? null : path.resolve(viaConfig.path),
      path.resolve(sb.fake.bin),
      'the configured binary is not what a launch would spawn'
    );

    // The source guard: no call site anywhere may reintroduce an option name
    // resolveClaude does not read. This is the shape of the original defect —
    // it type-checks, it runs, and it silently starts the wrong binary.
    for (const rel of ['../src/commands/launch.js', '../src/commands/doctor.js', '../src/commands/account.js']) {
      const src = fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      const offenders = src
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /(?:require|resolve)Claude\([^)]*\boverride\s*:/.test(line));
      assert.deepEqual(offenders, [], `${rel} passes an option resolveClaude does not read: ${JSON.stringify(offenders)}`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 19 — NO TOKEN LEAK
// ═════════════════════════════════════════════════════════════════════════════

describe('19 — nothing cam writes ever contains token material', () => {
  /** The shape of a real Claude Code OAuth token. */
  const TOKEN_RE = /sk-ant-[a-z0-9]{3,6}-[A-Za-z0-9_-]{20,}/;

  /** Files cam itself authors. Claude Code's own .credentials.json is not one. */
  const CAM_OWNED = (name) => name === '.cam-meta.json'
    || name === 'last'
    || name === 'config.json'
    || name === 'isolation.json'
    || name === 'default-meta.json'
    || name === 'trash-meta.json'
    || name === '.cam-pending'
    || name === 'cam.sh'
    || name === 'cam.ps1';

  /**
   * Every string inside a JSON value, however deeply nested.
   * @param {any} value the parsed JSON
   * @param {string[]} out accumulator
   * @returns {string[]} every string, keys included
   */
  const strings = (value, out = []) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) strings(v, out);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        out.push(k);
        strings(v, out);
      }
    }
    return out;
  };

  it('a full add + launch + refreshMeta cycle leaves no token behind', async () => {
    const root = mkRoot('leak');
    const store = path.join(root, 'store');
    seedHome(root);
    fs.mkdirSync(path.join(store, 'profiles'), { recursive: true });
    const fake = installFakeClaude(root);
    const h = makeCtx({
      home: root,
      spawn: fakeSpawner(fake),
      env: {
        CAM_HOME: store,
        CAM_CLAUDE_BIN: fake.bin,
        CAM_NO_PROMPT: '1',
        CAM_ASK: 'never',
        CAM_FAKE_DUMP: fake.dumpBase,
        CAM_FAKE_EMAIL: 'leak@example.com',
        CAM_FAKE_UUID: 'uuid-leak',
      },
    });

    assert.equal(await account.cmdAdd(h.ctx, ['leaky']), EXIT.OK, h.io.err.text());
    clearDumps(fake.dumpBase);
    assert.equal(await launch.run(h.ctx, ['--cam', 'leaky', '--', '-p', 'x']), 0, h.io.err.text());

    // Trash one copy too, so trash-meta.json is in the sweep.
    seedProfile(store, 'spare', { createdAt: 1, accountUuid: 'uuid-spare', email: 's@example.com' });
    await profiles.trashProfile(h.ctx, 'spare');
    // And the shell runtime files.
    await shell.writeRuntime(h.ctx, { version: '9.9.9', camBin: null });

    const owned = filesUnder(store).filter((f) => CAM_OWNED(path.basename(f)));
    assert.ok(owned.length >= 5, `too few cam-owned files were produced to be a real sweep: ${owned.length}`);

    // The token really is on disk somewhere, or this test proves nothing.
    const credFile = path.join(store, 'profiles', 'leaky', '.credentials.json');
    assert.match(fs.readFileSync(credFile, 'utf8'), TOKEN_RE, 'the fixture never wrote a token at all');

    for (const file of owned) {
      const text = fs.readFileSync(file, 'utf8');

      // 1. The shape of a token, anywhere, in anything cam wrote.
      assert.equal(TOKEN_RE.test(text), false, `token material found in ${file}`);

      // 2. The exact bytes the fixture put on disk. This is the assertion that
      //    actually proves the property: TOKEN_RE could be dodged by a token in
      //    another format, but these two strings are the ones that exist.
      //    (Spelled out here because the originals live inside the fake
      //    binary's source template, which is a string, not this scope.)
      const fixtureSecrets = ['sk-ant-oat01-' + 'A'.repeat(95), 'sk-ant-ort01-' + 'R'.repeat(95)];
      for (const secret of fixtureSecrets) {
        assert.equal(text.includes(secret), false, `verbatim token found in ${file}`);
        // A truncated copy is still a leak — cam is allowed a 12-char SHA-256
        // fingerprint of the refresh token and nothing longer.
        assert.equal(
          text.includes(secret.slice(0, 32)),
          false,
          `a truncated token prefix found in ${file}`
        );
      }

      // 3. No opaque blob of any shape: a long run with no whitespace and no
      //    path separator is exactly what a token or a base64 secret looks
      //    like. Real paths and translated sentences legitimately exceed 64
      //    characters, so those two shapes are the carve-out.
      //
      //    cam.sh and cam.ps1 are generated SOURCE CODE, not data — a
      //    PowerShell expression such as
      //    `$ExecutionContext.InvokeCommand.GetCommand('claude','Application')`
      //    is one 66-character run with no whitespace and no slash, and it is
      //    not a secret. They are covered by checks 1 and 2 above, which are
      //    the ones that would catch a real leak; the blob heuristic runs only
      //    over the JSON records cam persists.
      const isGeneratedScript = /\.(sh|ps1|fish)$/.test(file);
      if (isGeneratedScript) continue;

      let values = [];
      try {
        values = strings(JSON.parse(text));
      } catch {
        values = text.split(/\s+/);
      }
      for (const s of values) {
        if (s.length <= 64) continue;
        if (/[\s]/.test(s)) continue;
        if (s.includes('/') || s.includes('\\')) continue;
        assert.fail(`opaque ${s.length}-character string in ${file}: ${s.slice(0, 24)}…`);
      }
    }
  });

  it('credstore.summary returns a fingerprint, never a token', async () => {
    const root = mkRoot('fingerprint');
    const store = path.join(root, 'store');
    const dir = seedProfile(store, 'fp', { createdAt: 1 }, {
      credentials: {
        claudeAiOauth: {
          accessToken: `sk-ant-oat01-${'A'.repeat(95)}`,
          refreshToken: `sk-ant-ort01-${'R'.repeat(95)}`,
          expiresAt: 111,
          refreshTokenExpiresAt: 222,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
      },
    });
    const h = makeCtx({ home: root, platform: 'linux', env: { CAM_HOME: store } });
    const credstore = await import('../src/credstore.js');
    const summary = await credstore.summary(h.ctx, dir);

    assert.equal(summary.backend, 'file');
    assert.equal(summary.hasOauth, true);
    assert.match(summary.fingerprint, /^[0-9a-f]{12}$/);
    assert.equal(TOKEN_RE.test(JSON.stringify(summary)), false, 'the summary carries token material');
    assert.equal(summary.expiresAt, 111);
    assert.equal(summary.refreshTokenExpiresAt, 222);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// THE TEST FILE'S OWN ISOLATION
// ═════════════════════════════════════════════════════════════════════════════

describe('this test file cannot reach the real home directory', () => {
  it('never derives a path from the user home', () => {
    const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    // Assembled so the assertion does not match itself.
    const needle = `home${'dir'}(`;
    const uses = self
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => line.includes(needle) && !line.trimStart().startsWith('//'))
      .filter(([, line]) => !line.includes("${'dir'}"));
    assert.deepEqual(uses, [], `this file constructs a path from the user home: ${JSON.stringify(uses)}`);

    // Assembled the same way as `needle` above, so the banned list does not
    // match itself — spelling that variable literally here made this assertion
    // fail on its own source, every time.
    const banned = [`USER${'PROFILE'}`, `process.env.${'HOME'}`];
    for (const name of banned) {
      const hits = self
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => line.includes(name) && !line.includes("${'"));
      assert.deepEqual(hits, [], `this file reads ${name}: ${JSON.stringify(hits)}`);
    }
  });

  it('every sandbox lives under the OS temp directory', () => {
    const tmp = fs.realpathSync(tmpdir());
    for (const root of ROOTS) {
      const rel = path.relative(tmp, root);
      assert.ok(
        rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel),
        `sandbox ${root} is not under ${tmp}`
      );
    }
  });

  it('the file itself is LF-only', () => {
    const raw = fs.readFileSync(fileURLToPath(import.meta.url));
    assert.equal(raw.includes('\r'), false, 'a CR crept into test/fs.test.js');
  });
});
