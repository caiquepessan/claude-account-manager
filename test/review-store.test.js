// test/review-store.test.js — regressions for four confirmed store/credential
// defects in src/profiles.js and src/credstore.js.
//
// ISOLATION CONTRACT FOR THIS FILE
//   * Every byte written lives under one mkdtemp() directory per test.
//   * os.homedir() is never called: `ctx.home` is always a temp directory, so
//     the real ~/.claude and ~/.claude-account-manager are unreachable.
//   * No process is ever spawned: every path exercised here is cold and local.
//   * Assertions that only hold on one credential backend are skipped OUT LOUD
//     with t.skip(reason) rather than silently passing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import * as credstore from '../src/credstore.js';
import { createCtx } from '../src/ctx.js';
import { sha256Hex } from '../src/fsx.js';
import * as profiles from '../src/profiles.js';

/** macOS routes profile credentials through the Keychain, which a sandbox cannot hold. */
const DARWIN = process.platform === 'darwin';

/** Every temp root this file created, torn down in the single `after` hook. */
const ROOTS = [];

/**
 * A throwaway directory under the OS temp dir. Never derived from a home path.
 * @param {string} label short tag, only for human-readable temp names
 * @returns {string} the absolute root
 */
function mkRoot(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), `cam-store-${label}-`)));
  ROOTS.push(root);
  return root;
}

after(() => {
  for (const root of ROOTS.reverse()) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* a locked temp dir is the OS's problem, not the test's */
    }
  }
});

/**
 * A collecting stand-in for a non-TTY stream.
 * @returns {{isTTY: boolean, columns: number, rows: number, write: Function}} the stream
 */
function memStream() {
  return { isTTY: false, columns: 80, rows: 24, write: () => true };
}

/**
 * Build a cam context pinned to a sandbox. `env` REPLACES the real environment,
 * so nothing the developer has exported can reach these tests.
 * @param {{ home: string, env?: object, platform?: string, now?: number }} opts inputs
 * @returns {object} the frozen context
 */
function makeCtx(opts) {
  return createCtx({
    argv: [process.execPath, 'cam'],
    platform: opts.platform || process.platform,
    home: opts.home,
    cwd: opts.home,
    locale: 'en',
    env: { LANG: 'en_US.UTF-8', NO_COLOR: '1', ...(opts.env || {}) },
    io: { out: memStream(), err: memStream(), in: { isTTY: false } },
    now: Number.isFinite(opts.now) ? opts.now : 1_700_000_000_000,
    version: '9.9.9',
    verbose: false,
    ascii: true,
  });
}

/**
 * Write a credentials file the way Claude Code does.
 * @param {string} dir the config directory
 * @param {{ access: string, refresh: string, expiresAt: number, refreshTokenExpiresAt: number, plan: string }} v the values
 * @returns {void}
 */
function writeCreds(dir, v) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: v.access,
      refreshToken: v.refresh,
      expiresAt: v.expiresAt,
      refreshTokenExpiresAt: v.refreshTokenExpiresAt,
      subscriptionType: v.plan,
      scopes: ['user:inference'],
    },
  }));
}

/**
 * Write a Claude-Code-owned .claude.json carrying one signed-in identity.
 * @param {string} dir the config directory
 * @param {string} uuid the account uuid
 * @param {string} email the address
 * @returns {void}
 */
function writeIdentity(dir, uuid, email) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
    oauthAccount: { accountUuid: uuid, emailAddress: email },
  }));
}

// ── FINDING 1 — purgeTrash must not touch a re-created live profile ──────────

describe('purgeTrash and the re-used account name', () => {
  it('leaves the live profile credential alone when the name was re-created', async (t) => {
    if (DARWIN) {
      t.skip('file credential backend only: on macOS the credential is a Keychain item');
      return;
    }

    const root = mkRoot('purge-live');
    const home = path.join(root, 'home');
    const camHome = path.join(root, 'store');
    fs.mkdirSync(home, { recursive: true });
    const ctx = makeCtx({ home, env: { CAM_HOME: camHome } });

    const live = path.join(camHome, 'profiles', 'work');
    writeIdentity(live, 'uuid-old', 'old@example.com');
    writeCreds(live, {
      access: 'sk-ant-oat01-old', refresh: 'sk-ant-ort01-old',
      expiresAt: 111, refreshTokenExpiresAt: 222, plan: 'pro',
    });

    const { id } = await profiles.trashProfile(ctx, 'work');

    // The name is free again the moment the directory moves to trash.
    writeIdentity(live, 'uuid-new', 'new@example.com');
    writeCreds(live, {
      access: 'sk-ant-oat01-live', refresh: 'sk-ant-ort01-live',
      expiresAt: 333, refreshTokenExpiresAt: 444, plan: 'max',
    });

    await profiles.purgeTrash(ctx, id);

    const credFile = path.join(live, '.credentials.json');
    assert.equal(fs.existsSync(credFile), true, 'the live profile was signed out by a trash purge');
    const raw = JSON.parse(fs.readFileSync(credFile, 'utf8'));
    assert.equal(raw.claudeAiOauth.refreshToken, 'sk-ant-ort01-live');
    assert.equal(fs.existsSync(path.join(camHome, 'trash', id)), false, 'the trash copy survived');
  });

  it('still purges the credential when the original path is vacant', async () => {
    const root = mkRoot('purge-vacant');
    const home = path.join(root, 'home');
    const camHome = path.join(root, 'store');
    fs.mkdirSync(home, { recursive: true });
    const ctx = makeCtx({ home, env: { CAM_HOME: camHome } });

    const live = path.join(camHome, 'profiles', 'solo');
    writeIdentity(live, 'uuid-solo', 'solo@example.com');
    writeCreds(live, {
      access: 'sk-ant-oat01-solo', refresh: 'sk-ant-ort01-solo',
      expiresAt: 111, refreshTokenExpiresAt: 222, plan: 'pro',
    });

    const { id } = await profiles.trashProfile(ctx, 'solo');
    await profiles.purgeTrash(ctx, id);

    assert.equal(fs.existsSync(path.join(camHome, 'trash', id)), false);
    assert.equal(fs.existsSync(live), false, 'nothing should have re-created the original path');
  });
});

// ── FINDING 2 — summary() reads the profile's own credentials ────────────────

describe('credstore.summary and an ambient CLAUDE_SECURESTORAGE_CONFIG_DIR', () => {
  it('reads the directory it was handed, not the ambient one', async () => {
    const root = mkRoot('summary-ambient');
    const home = path.join(root, 'home');
    const profileDir = path.join(root, 'profile');
    const ambient = path.join(root, 'ambient');
    fs.mkdirSync(home, { recursive: true });

    writeCreds(profileDir, {
      access: 'sk-ant-oat01-own', refresh: 'sk-ant-ort01-own',
      expiresAt: 999999, refreshTokenExpiresAt: 888888, plan: 'pro',
    });
    writeCreds(ambient, {
      access: 'sk-ant-oat01-other', refresh: 'sk-ant-ort01-other',
      expiresAt: 111111, refreshTokenExpiresAt: 222222, plan: 'max',
    });

    const ctx = makeCtx({ home, env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: ambient } });
    const s = await credstore.summary(ctx, profileDir);

    assert.equal(s.backend, 'file');
    assert.equal(s.expiresAt, 999999);
    assert.equal(s.refreshTokenExpiresAt, 888888);
    assert.equal(s.subscriptionType, 'pro');
    assert.equal(s.fingerprint, sha256Hex('sk-ant-ort01-own').slice(0, 12));
    assert.notEqual(s.fingerprint, sha256Hex('sk-ant-ort01-other').slice(0, 12));
  });

  it('never caches another account\'s expiries into a profile\'s .cam-meta.json', async () => {
    const root = mkRoot('summary-meta');
    const home = path.join(root, 'home');
    const camHome = path.join(root, 'store');
    const ambient = path.join(root, 'ambient');
    fs.mkdirSync(home, { recursive: true });

    const dir = path.join(camHome, 'profiles', 'work');
    writeIdentity(dir, 'uuid-work', 'work@example.com');
    writeCreds(dir, {
      access: 'sk-ant-oat01-own', refresh: 'sk-ant-ort01-own',
      expiresAt: 999999, refreshTokenExpiresAt: 888888, plan: 'pro',
    });
    writeCreds(ambient, {
      access: 'sk-ant-oat01-other', refresh: 'sk-ant-ort01-other',
      expiresAt: 111111, refreshTokenExpiresAt: 222222, plan: 'max',
    });

    const ctx = makeCtx({
      home,
      env: { CAM_HOME: camHome, CLAUDE_SECURESTORAGE_CONFIG_DIR: ambient },
    });
    await profiles.refreshMeta(ctx, { name: 'work', dir });

    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.cam-meta.json'), 'utf8'));
    assert.equal(meta.expiresAt, 999999);
    assert.equal(meta.refreshTokenExpiresAt, 888888);
    assert.equal(meta.plan, 'pro');
    assert.equal(meta.tokenFingerprint, sha256Hex('sk-ant-ort01-own').slice(0, 12));
  });
});

// ── FINDING 3 — beginCreate claims a name exclusively ────────────────────────

describe('beginCreate name claiming', () => {
  it('lets exactly one of several concurrent claims win', async () => {
    const root = mkRoot('begin-race');
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const ctx = makeCtx({ home, env: { CAM_HOME: path.join(root, 'store') } });

    const results = await Promise.allSettled([
      profiles.beginCreate(ctx, 'racer'),
      profiles.beginCreate(ctx, 'racer'),
      profiles.beginCreate(ctx, 'racer'),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    assert.equal(won.length, 1, 'two callers both believed they owned the name');
    for (const r of results) {
      if (r.status === 'rejected') assert.equal(r.reason.code, 'CONFLICT');
    }
  });

  it('still reports CONFLICT for a name a published profile already holds', async () => {
    const root = mkRoot('begin-taken');
    const home = path.join(root, 'home');
    const camHome = path.join(root, 'store');
    fs.mkdirSync(home, { recursive: true });
    const ctx = makeCtx({ home, env: { CAM_HOME: camHome } });

    fs.mkdirSync(path.join(camHome, 'profiles', 'work'), { recursive: true });
    await assert.rejects(
      () => profiles.beginCreate(ctx, 'work'),
      (e) => e.code === 'CONFLICT',
    );
  });

  it('creates the directory and the pending marker for the winner', async () => {
    const root = mkRoot('begin-ok');
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const ctx = makeCtx({ home, env: { CAM_HOME: path.join(root, 'store') } });

    const { dir } = await profiles.beginCreate(ctx, 'solo');
    assert.equal(fs.statSync(dir).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(dir, '.cam-pending')), true);
    assert.deepEqual(await profiles.list(ctx), [], 'a pending profile must stay invisible');
  });
});

// ── FINDING 4 — case-blind CLAUDE_* lookups on Windows ───────────────────────

describe('environment lookups on Windows', () => {
  it('defaultClaudePaths honours a lower-case claude_config_dir', () => {
    const root = mkRoot('env-case');
    const home = path.join(root, 'home');
    const alt = path.join(root, 'alt');
    const ctx = makeCtx({ home, platform: 'win32', env: { claude_config_dir: alt } });

    const p = profiles.defaultClaudePaths(ctx);
    assert.equal(p.configDir, alt);
    assert.equal(p.configFile, path.join(alt, '.claude.json'));
    assert.equal(p.credentialsFile, path.join(alt, '.credentials.json'));
  });

  it('credstore resolves the ambient config dir case-blind on Windows', () => {
    const root = mkRoot('env-case-cred');
    const home = path.join(root, 'home');
    const alt = path.join(root, 'alt');
    const ctx = makeCtx({ home, platform: 'win32', env: { claude_config_dir: alt } });

    const backend = credstore.detectBackend(ctx, null);
    assert.equal(backend.kind, 'file');
    assert.equal(backend.location, path.join(alt, '.credentials.json'));
  });

  it('keeps POSIX lookups case-SENSITIVE', () => {
    const root = mkRoot('env-case-posix');
    const home = path.join(root, 'home');
    const alt = path.join(root, 'alt');
    const ctx = makeCtx({ home, platform: 'linux', env: { claude_config_dir: alt } });

    // On Linux `claude_config_dir` really is a different variable, and neither
    // ctx.js nor Claude Code honours it there.
    assert.equal(profiles.defaultClaudePaths(ctx).configDir, path.join(home, '.claude'));
  });
});
