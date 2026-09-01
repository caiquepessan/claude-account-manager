// test/review-commands.test.js — regression tests for the six confirmed review
// findings in src/commands/account.js, src/commands/doctor.js and src/ui.js.
//
// ISOLATION CONTRACT FOR THIS FILE
//   * Every byte written lives under one mkdtemp() directory per test.
//   * The real home is never looked up: `ctx.home` is always a temp dir, so
//     the real ~/.claude and ~/.claude-account-manager are unreachable.
//   * `claude` is never the real binary: a Node script stands in for it and is
//     started as `process.execPath <script>` through the injected ctx.spawn.
//   * Platform-specific expectations are skipped OUT LOUD with t.skip().

import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import * as account from '../src/commands/account.js';
import * as doctor from '../src/commands/doctor.js';
import { createCtx, EXIT, isCamError } from '../src/ctx.js';
import { createT } from '../src/i18n.js';

const WIN = process.platform === 'win32';
const HOUR = 3600000;
const NOW = 1_700_000_000_000;

// ── sandbox lifecycle ───────────────────────────────────────────────────────

/** Every temp root this file created, torn down in the single `after` hook. */
const ROOTS = [];

/**
 * A throwaway directory under the OS temp dir. Never derived from a home path.
 * @param {string} label short suite tag, only for human-readable temp names
 * @returns {string} the absolute root
 */
function mkRoot(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), `cam-rev-${label}-`)));
  ROOTS.push(root);
  return root;
}

after(() => {
  // Links are unlinked before any recursion so cleanup can never follow a
  // shared junction out of the sandbox — the same rule the production code has.
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
 * Remove every link under `dir` without following any of them.
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

// ── context construction ────────────────────────────────────────────────────

/** The handful of ambient variables a spawned `node` genuinely needs. */
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
    columns: 100,
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
 * Build a cam context pinned to a sandbox, with a frozen injected clock.
 * @param {{home: string, env?: object, locale?: string, now?: number, spawn?: Function}} opts inputs
 * @returns {{ctx: object, io: object, t: Function, at: Function}} the harness
 */
function makeCtx(opts) {
  const io = { out: memStream(), err: memStream(), in: { isTTY: false } };
  const clock = Number.isFinite(opts.now) ? opts.now : NOW;
  const locale = opts.locale || 'en';
  const ctx = createCtx({
    argv: [process.execPath, 'cam'],
    home: opts.home,
    cwd: opts.home,
    locale,
    env: baseEnv(opts.env || {}),
    io,
    now: () => clock,
    spawn: opts.spawn || nodeSpawn,
    version: '9.9.9',
    verbose: false,
    ascii: true,
  });
  return { ctx, io, t: createT(locale), at: () => clock };
}

/**
 * A store with a profiles/ directory and a home carrying a ~/.claude tree.
 * @param {string} label suite tag for the temp directory name
 * @returns {{root: string, store: string}} the sandbox paths
 */
function mkStore(label) {
  const root = mkRoot(label);
  const store = path.join(root, 'store');
  fs.mkdirSync(path.join(store, 'profiles'), { recursive: true });
  return { root, store };
}

/**
 * Write a ~/.claude tree worth sharing, plus the default account's config.
 * @param {string} home the sandbox home
 * @returns {void}
 */
function seedHome(home) {
  fs.writeFileSync(path.join(home, '.claude.json'), `${JSON.stringify({
    userID: 'default-user-id',
    hasCompletedOnboarding: true,
    oauthAccount: {
      accountUuid: '00000000-1111-2222-3333-444444444444',
      emailAddress: 'default@example.com',
      organizationName: 'Default Org',
      organizationType: 'claude_max',
      organizationUuid: 'org-default',
    },
  }, null, 2)}\n`, 'utf8');
  for (const dir of ['plugins', 'commands', 'agents', 'skills', 'projects']) {
    fs.mkdirSync(path.join(home, '.claude', dir), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', dir, 'payload.txt'), dir, 'utf8');
  }
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# shared memory', 'utf8');
}

/**
 * Write one profile directory with a .cam-meta.json.
 * @param {string} store the store root
 * @param {string} name the account name
 * @param {object} meta the metadata body
 * @returns {string} the profile directory
 */
function seedProfile(store, name, meta) {
  const dir = path.join(store, 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.cam-meta.json'),
    `${JSON.stringify({ schema: 1, name, ...meta }, null, 2)}\n`,
    'utf8'
  );
  return dir;
}

/** Metadata for a healthy account last used three hours ago. */
const USED_3H = Object.freeze({
  createdAt: NOW - 30 * 86400000,
  lastUsedAt: NOW - 3 * HOUR,
  email: 'work@example.com',
  accountUuid: 'uuid-work',
  plan: 'max',
  orgName: 'Work Org',
  backend: 'file',
  expiresAt: NOW + 8 * HOUR,
  refreshTokenExpiresAt: NOW + 30 * 86400000,
  checkedAt: NOW,
});

// ── the fake claude binary ──────────────────────────────────────────────────

/**
 * A stand-in for Claude Code. `CAM_FAKE_GARBAGE=1` makes `auth status` print
 * unparseable output, which is how the "probe returned no readable status"
 * branch is reached without waiting for a 30 s timeout.
 */
const FAKE_CLAUDE_SRC = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const env = process.env;
const dir = env.CLAUDE_CONFIG_DIR || null;

if (argv.indexOf('--version') !== -1) {
  process.stdout.write('9.9.9 (Claude Code)\\n');
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  if (env.CAM_FAKE_GARBAGE === '1') {
    process.stdout.write('this is not json at all\\n');
    process.exit(0);
  }
  const ok = !!(dir && fs.existsSync(path.join(dir, '.credentials.json')));
  process.stdout.write(JSON.stringify({
    loggedIn: ok,
    authMethod: ok ? 'claude.ai' : 'none',
    email: ok ? 'work@example.com' : null,
    orgId: ok ? 'org-fake-1' : null,
    orgName: ok ? 'Fake Org' : null,
    subscriptionType: ok ? 'max' : null
  }) + '\\n');
  process.exit(ok ? 0 : 1);
}

if (argv[0] === 'auth' && argv[1] === 'login') {
  if (!dir) process.exit(1);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-' + 'A'.repeat(95),
      refreshToken: 'sk-ant-ort01-' + 'R'.repeat(95),
      expiresAt: Date.now() + 8 * 3600 * 1000,
      refreshTokenExpiresAt: Date.now() + 30 * 86400 * 1000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max'
    }
  }, null, 2));
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
    userID: 'fake-user-id',
    hasCompletedOnboarding: true,
    oauthAccount: {
      accountUuid: 'uuid-work',
      emailAddress: 'work@example.com',
      organizationName: 'Fake Org',
      organizationType: 'claude_max',
      organizationUuid: 'org-fake-1'
    }
  }, null, 2));
  process.exit(0);
}

process.exit(0);
`;

/**
 * Drop the fake binary into a sandbox. The resolved path ends in `.exe` on
 * Windows so classifyKind answers 'exe' and no cmd.exe shim is involved.
 * @param {string} root sandbox root
 * @returns {{bin: string, script: string}} the fake install
 */
function installFakeClaude(root) {
  const binDir = path.join(root, 'fakebin');
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, 'fake-claude.cjs');
  fs.writeFileSync(script, FAKE_CLAUDE_SRC, 'utf8');
  const bin = path.join(binDir, WIN ? 'claude.exe' : 'claude');
  fs.writeFileSync(bin, '# stand-in; never executed directly\n', 'utf8');
  if (!WIN) fs.chmodSync(bin, 0o755);
  return { bin, script };
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
 * A sandbox wired to the fake claude, for the `cam add` and doctor probes.
 * @param {string} label suite tag
 * @param {Record<string, string>} [env] extra environment
 * @param {string} [locale] catalogue to render in
 * @returns {object} the harness plus paths
 */
function addSandbox(label, env = {}, locale = 'en') {
  const { root, store } = mkStore(label);
  seedHome(root);
  const fake = installFakeClaude(root);
  const h = makeCtx({
    home: root,
    locale,
    spawn: fakeSpawner(fake),
    env: {
      CAM_HOME: store,
      CAM_CLAUDE_BIN: fake.bin,
      CAM_NO_PROMPT: '1',
      ...env,
    },
  });
  return { root, store, fake, ...h };
}

// ═════════════════════════════════════════════════════════════════════════════
// FINDING 1 — relative times must be rendered through ctx.t
// ═════════════════════════════════════════════════════════════════════════════

describe('finding 1 — relative times follow the session locale', () => {
  it('cam ls prints pt-BR relative times, not the English fallback', async () => {
    const { root, store } = mkStore('ls-ptbr');
    seedHome(root);
    seedProfile(store, 'work', USED_3H);
    const { ctx, io, t } = makeCtx({ home: root, locale: 'pt-BR', env: { CAM_HOME: store } });

    const code = await account.cmdList(ctx, []);
    assert.equal(code, EXIT.OK, io.err.text());

    const out = io.out.text();
    assertHasFolded(out, t('time.hours', { n: 3 }), out);
    assert.doesNotMatch(out, /\bago\b/, 'an English relative time reached a pt-BR session');
  });

  it('cam rm prints the pt-BR "last used" value in its confirmation', async () => {
    const { root, store } = mkStore('rm-ptbr');
    seedHome(root);
    seedProfile(store, 'work', USED_3H);
    const { ctx, io, t } = makeCtx({ home: root, locale: 'pt-BR', env: { CAM_HOME: store } });

    const code = await account.cmdRemove(ctx, ['work', '--yes']);
    assert.equal(code, EXIT.OK, io.err.text());

    const err = io.err.text();
    assertHasFolded(err, t('time.hours', { n: 3 }), err);
    assert.doesNotMatch(err, /\bago\b/, 'an English relative time reached a pt-BR session');
  });

  it('cam doctor prints the pt-BR profile freshness hint', async () => {
    const { root, store } = mkStore('doctor-ptbr');
    seedHome(root);
    seedProfile(store, 'work', { ...USED_3H, checkedAt: NOW - 3 * HOUR });
    const { ctx, t } = makeCtx({ home: root, locale: 'pt-BR', env: { CAM_HOME: store } });

    const list = await doctor.checks(ctx, {});
    const row = list.find((c) => c.id === 'profile:work');
    assert.ok(row, 'the profile check did not run');
    assertHasFolded(String(row.hint), t('time.hours', { n: 3 }), String(row.hint));
    assert.doesNotMatch(String(row.hint), /\bago\b/, 'an English relative time reached a pt-BR session');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FINDING 2 — the trash AGE column reports the real age
// ═════════════════════════════════════════════════════════════════════════════

describe('finding 2 — cam trash reports a real age', () => {
  /**
   * Quarantine a profile by hand, with a known removedAt.
   * @param {string} store the store root
   * @param {string} id the trash directory name
   * @param {number} removedAt epoch ms to record
   * @returns {void}
   */
  const seedTrash = (store, id, removedAt) => {
    const dir = path.join(store, 'trash', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'payload.txt'), 'x', 'utf8');
    fs.writeFileSync(path.join(dir, 'trash-meta.json'), `${JSON.stringify({
      schema: 1, id, name: 'work', originalPath: path.join(store, 'profiles', 'work'), removedAt,
    }, null, 2)}\n`, 'utf8');
  };

  it('a profile trashed three hours ago is not reported as "never"', async () => {
    const { root, store } = mkStore('trash-age');
    seedHome(root);
    seedTrash(store, `work-${NOW - 3 * HOUR}`, NOW - 3 * HOUR);
    const { ctx, io, t } = makeCtx({ home: root, env: { CAM_HOME: store } });

    const code = await account.cmdTrash(ctx, []);
    assert.equal(code, EXIT.OK, io.err.text());

    const out = io.out.text();
    assertHasFolded(out, t('time.hours', { n: 3 }), out);
    assert.doesNotMatch(out, new RegExp(`\\b${escapeRe(t('time.never'))}\\b`), out);
  });

  it('the age it prints is localized too', async () => {
    const { root, store } = mkStore('trash-age-ptbr');
    seedHome(root);
    seedTrash(store, `work-${NOW - 3 * HOUR}`, NOW - 3 * HOUR);
    const { ctx, io, t } = makeCtx({ home: root, locale: 'pt-BR', env: { CAM_HOME: store } });

    const code = await account.cmdTrash(ctx, []);
    assert.equal(code, EXIT.OK, io.err.text());

    const out = io.out.text();
    assertHasFolded(out, t('time.hours', { n: 3 }), out);
    assert.doesNotMatch(out, /\bago\b/, 'an English relative time reached a pt-BR session');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FINDING 6 — the refusal to remove `default` carries the right remedy
// ═════════════════════════════════════════════════════════════════════════════

describe('finding 6 — cam rm default', () => {
  it('refuses with the isolation hint and exit 8, never the cam shell usage line', async () => {
    const { root, store } = mkStore('rm-default');
    seedHome(root);
    const { ctx, t } = makeCtx({ home: root, env: { CAM_HOME: store } });

    let caught = null;
    try {
      await account.cmdRemove(ctx, ['default', '--yes']);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught && isCamError(caught), 'cam rm default did not refuse');
    assert.equal(caught.message, t('rm.refuseDefault'));
    assert.equal(caught.exitCode, EXIT.UNSAFE);
    // The hint must be the remedy for THIS refusal — name an account cam
    // actually created. `err.unsafeHint` ("run: cam doctor") was a stopgap while
    // the catalogue key did not exist yet, and `shell.usage` was the original
    // copy-paste bug this test was written for.
    assert.equal(caught.hint, t('rm.refuseDefaultHint'));
    assert.notEqual(caught.hint, t('shell.usage'));
    assert.notEqual(caught.hint, t('err.unsafeHint'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FINDING 4 — an unreadable probe is never reported as a proven failure
// ═════════════════════════════════════════════════════════════════════════════

describe('finding 4 — the isolation probe has three outcomes', () => {
  it('cam doctor says the probe was unreadable, not that a config dir was SIGNED IN', async () => {
    const sb = addSandbox('iso-doctor', { CAM_FAKE_GARBAGE: '1' });

    const list = await doctor.checks(sb.ctx, {});
    const row = list.find((c) => c.id === 'isolation');
    assert.ok(row, 'the isolation check did not run');
    assert.equal(row.status, 'fail');
    assert.equal(row.detail, sb.t('doctor.isolationUnreadable'),
      `doctor claimed: ${row.detail}`);
    assert.notEqual(row.detail, sb.t('doctor.isolationFail'));
  });

  it('cam add refuses without claiming a throwaway dir reported SIGNED IN', async () => {
    const sb = addSandbox('iso-add', { CAM_FAKE_GARBAGE: '1' });

    const code = await account.cmdAdd(sb.ctx, ['work', '--no-share']);
    assert.equal(code, EXIT.UNSAFE, sb.io.err.text());

    const err = sb.io.err.text();
    assert.ok(err.includes(sb.t('doctor.isolationUnreadable')),
      `cam add never said the probe was unreadable; stderr: ${err}`);
    assert.equal(err.includes(sb.t('add.unsafeBody')), false,
      'cam add asserted an observation the probe never made');
  });

  it('a probe that proves sharing still gets the blunt SIGNED IN verdict', async () => {
    // The same code path must keep its teeth: a probe that really did report a
    // logged-in throwaway directory is the one case the strong wording is for.
    const sb = addSandbox('iso-shared');
    fs.mkdirSync(path.join(sb.store), { recursive: true });
    // The fake reports logged-in for any config dir holding .credentials.json;
    // pre-seeding the isolation cache is not possible (doctor forces a probe),
    // so make every fresh probe dir look signed in by patching the fake.
    fs.writeFileSync(sb.fake.script, FAKE_CLAUDE_SRC.replace(
      "const ok = !!(dir && fs.existsSync(path.join(dir, '.credentials.json')));",
      'const ok = true;'
    ), 'utf8');

    const list = await doctor.checks(sb.ctx, {});
    const row = list.find((c) => c.id === 'isolation');
    assert.ok(row, 'the isolation check did not run');
    assert.equal(row.status, 'fail');
    assert.equal(row.detail, sb.t('doctor.isolationFail'), `doctor said: ${row.detail}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FINDINGS 3 and 5 — sharing is recorded, and --share-projects does something
// ═════════════════════════════════════════════════════════════════════════════

describe('findings 3 and 5 — cam add sharing', () => {
  it('--share-projects actually shares ~/.claude/projects', async () => {
    const sb = addSandbox('share-projects');

    const code = await account.cmdAdd(sb.ctx, ['work', '--share-projects']);
    assert.equal(code, EXIT.OK, sb.io.err.text());

    const shared = path.join(sb.store, 'profiles', 'work', 'projects');
    assert.equal(fs.existsSync(shared), true,
      '--share-projects warned about shared transcripts but shared nothing');
  });

  it('the share record reaches .cam-meta.json, so doctor can report it', async () => {
    const sb = addSandbox('share-meta');

    const code = await account.cmdAdd(sb.ctx, ['work']);
    assert.equal(code, EXIT.OK, sb.io.err.text());

    const meta = JSON.parse(fs.readFileSync(
      path.join(sb.store, 'profiles', 'work', '.cam-meta.json'), 'utf8'
    ));
    assert.ok(meta.share && typeof meta.share === 'object', 'no share record was written');
    assert.notEqual(meta.share.mode, 'skip',
      'four links were created but the meta records "skip"');
    assert.ok(['junction', 'symlink', 'copy'].includes(meta.share.mode),
      `unrenderable share mode ${meta.share.mode}`);
    assert.ok(Array.isArray(meta.share.dirs) && meta.share.dirs.includes('plugins'),
      `share.dirs did not record what was shared: ${JSON.stringify(meta.share.dirs)}`);

    // Every persisted mode must have a catalogue key, in both languages.
    for (const locale of ['en', 'pt-BR']) {
      const t = createT(locale);
      const label = t(`share.mode.${meta.share.mode}`);
      assert.notEqual(label, `share.mode.${meta.share.mode}`,
        `${locale} has no key for the persisted mode`);
    }
  });

  it('doctor reports the profile as shared rather than skipped', async () => {
    const sb = addSandbox('share-doctor');

    const code = await account.cmdAdd(sb.ctx, ['work']);
    assert.equal(code, EXIT.OK, sb.io.err.text());

    const list = await doctor.checks(sb.ctx, {});
    const row = list.find((c) => c.id === 'profile:work');
    assert.ok(row, 'the profile check did not run');
    assert.equal(String(row.hint).includes(sb.t('share.mode.skip')), false,
      `doctor reported the profile as skipped: ${row.hint}`);
  });

  it('--no-share still records a skip, and the profile stays unshared', async () => {
    const sb = addSandbox('share-none');

    const code = await account.cmdAdd(sb.ctx, ['work', '--no-share']);
    assert.equal(code, EXIT.OK, sb.io.err.text());

    const dir = path.join(sb.store, 'profiles', 'work');
    assert.equal(fs.existsSync(path.join(dir, 'plugins')), false, '--no-share shared anyway');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.cam-meta.json'), 'utf8'));
    assert.equal(meta.share.mode, 'skip');
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Drop diacritics, so an assertion holds whether or not the renderer folded
 * 'há' down to 'ha' for a terminal it decided cannot show it.
 * @param {string} s any rendered text
 * @returns {string} the same text without combining marks
 */
function fold(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Assert a rendered string contains a translated value, ignoring diacritics —
 * the renderer folds 'há' to 'ha' when it thinks the terminal cannot show it,
 * and that is not what these tests are about.
 * @param {string} subject the rendered output
 * @param {string} needle the translated value it must contain
 * @param {string} context what to print when it does not
 * @returns {void}
 */
function assertHasFolded(subject, needle, context) {
  assert.ok(fold(String(subject)).includes(fold(needle)), context);
}

/**
 * Escape a translated string for use inside a RegExp.
 * @param {string} s the literal to match
 * @returns {string} the escaped source
 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A guard on the guard: this file must never derive a real home directory.
describe('this suite cannot reach the real home', () => {
  it('never calls the real home lookup', () => {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
    // The needle is assembled at run time so this guard cannot match itself.
    const needle = new RegExp(`${['home', 'dir'].join('')}\\s*\\(`);
    assert.equal(needle.test(src), false, 'this test file reads the real home');
  });
});
