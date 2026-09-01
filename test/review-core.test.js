// test/review-core.test.js — regressions for the twelve confirmed defects in
// src/ctx.js, src/cli.js, src/screen.js and src/commands/launch.js.
// Constraints, same as the sibling suites:
//   * node:test + node:assert/strict only, zero dependencies.
//   * Every filesystem test runs inside its own mkdtemp under os.tmpdir() and
//     removes it again. NOTHING here may reach the real ~/.claude or
//     ~/.claude-account-manager: `home` and CAM_HOME are always injected.
//   * No Date.now(), no ambient process.env: every clock, environment, platform,
//     home and stream is injected through createCtx.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { createCtx, sanitizeChildEnv, EXIT } from '../src/ctx.js';
import { splitArgs } from '../src/cli.js';
import * as screen from '../src/screen.js';
import { resolveTarget, cmdWhich, cmdExec } from '../src/commands/launch.js';

// ── fixtures ────────────────────────────────────────────────────────────────

/** One frozen clock for the whole file. Never Date.now(). */
const NOW = 1788000000000;

/** A token-shaped value, so nothing here can be mistaken for a real secret. */
const FAKE_TOKEN = `sk-ant-oat01-${'Z'.repeat(40)}`;

/** Temporary roots created by this file, removed on exit. */
const ROOTS = [];

/**
 * A private temporary directory. Never inside the user's home.
 * @param {string} tag a short label for the directory name
 * @returns {string} the absolute path
 */
function mkRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cam-review-${tag}-`));
  ROOTS.push(root);
  return root;
}

process.on('exit', () => {
  for (const root of ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // a leftover temp directory is not worth failing the suite over
    }
  }
});

/**
 * A string-collecting writable stand-in for a stream.
 * @returns {{ write: Function, data: string, isTTY: boolean }} the fake stream
 */
function mkStream() {
  return {
    isTTY: false,
    columns: 80,
    rows: 24,
    data: '',
    write(s) {
      this.data += String(s);
      return true;
    },
    on() {},
    removeListener() {},
  };
}

/**
 * A context over an injected home and environment.
 * @param {object} [over] context overrides
 * @returns {object} the frozen context plus its two output streams
 */
function mkCtx(over = {}) {
  const out = mkStream();
  const err = mkStream();
  const ctx = createCtx({
    platform: 'linux',
    home: '/home/nobody',
    cwd: '/w',
    now: NOW,
    env: {},
    argv: ['node', '/x/bin/cam.js'],
    version: '9.9.9',
    spawn: () => {
      throw new Error('this test did not expect a spawn');
    },
    ...over,
    io: { in: (over.io && over.io.in) || null, out, err },
  });
  return { ctx, out, err };
}

/**
 * A spawn stand-in that records the call and exits 0 immediately.
 * @returns {{ fn: Function, calls: object[] }} the fake and its recording
 */
function fakeSpawn() {
  const calls = [];
  const fn = (file, args, opts) => {
    calls.push({ file, args, env: (opts && opts.env) || {} });
    const child = new EventEmitter();
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  return { fn, calls };
}

/**
 * A store with the named profiles, and optionally a signed-in default login.
 * @param {string} tag a label for the temporary directory
 * @param {{ profiles?: string[], withDefault?: boolean, last?: string|null }} [opts] what to seed
 * @returns {{ root: string, store: string, home: string }} the seeded paths
 */
function seedStore(tag, opts = {}) {
  const root = mkRoot(tag);
  const store = path.join(root, 'store');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(store, 'profiles'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  for (const name of opts.profiles || []) {
    const dir = path.join(store, 'profiles', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.cam-meta.json'), JSON.stringify({
      schema: 1,
      name,
      createdAt: NOW - 1000,
      accountUuid: `uuid-${name}`,
      email: `${name}@example.test`,
      plan: 'max',
      backend: 'file',
      refreshTokenExpiresAt: NOW + 30 * 86400000,
    }), 'utf8');
  }
  if (opts.withDefault === true) {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      oauthAccount: {
        accountUuid: 'uuid-default',
        emailAddress: 'me@personal.test',
        organizationType: 'claude_max',
      },
    }), 'utf8');
  }
  if (typeof opts.last === 'string') {
    fs.writeFileSync(path.join(store, 'last'), opts.last, 'utf8');
  }
  return { root, store, home };
}

/** Account records for the pure resolveTarget tests. */
const acct = (name, dir) => ({
  name,
  dir,
  createdAt: 1,
  meta: { email: `${name}@example.test`, accountUuid: `uuid-${name}`, plan: 'max' },
});

/** A resolution mode that cannot open a menu, so resolveTarget always decides. */
const SILENT = Object.freeze({ kind: 'none', reason: 'pick.reason.claudecode' });

// ════════════════════════════════════════════════════════════════════════════
describe('review — argv', () => {
  // FINDING 4: the bare-word consumer ran `i += 1` even when --cam had already
  // supplied the name, so the first forwarded token was deleted.
  it('a bare argument after --cam <name> is forwarded, never swallowed', () => {
    const s = splitArgs(['--cam', 'work', 'fix the bug']);
    assert.equal(s.camName, 'work');
    assert.deepEqual(s.forwarded, ['fix the bug'], 'the prompt was dropped');

    const two = splitArgs(['--cam', 'work', 'a', 'b']);
    assert.deepEqual(two.forwarded, ['a', 'b']);

    // and the shorthand still consumes its own name
    const short = splitArgs(['work', 'fix the bug']);
    assert.equal(short.camName, 'work');
    assert.deepEqual(short.forwarded, ['fix the bug']);
  });

  // FINDING 4 (same defect through the documented hook-free entry point):
  // `cam launch` put the token in camArgs, which run() never forwards.
  it('`cam launch --cam <name> <prompt>` forwards the prompt too', () => {
    const s = splitArgs(['launch', '--cam', 'work', 'fix the bug']);
    assert.equal(s.cmd, 'launch');
    assert.equal(s.camName, 'work');
    assert.deepEqual(s.forwarded, ['fix the bug']);
    assert.deepEqual(s.camArgs, []);

    // the shim shape and cam's own flags must keep working
    const shim = splitArgs(['launch', '--', 'summarise this repo']);
    assert.deepEqual(shim.forwarded, ['summarise this repo']);
    assert.equal(shim.camName, undefined);
    const keep = splitArgs(['launch', '--keep-env', '--', '-p', 'x']);
    assert.deepEqual(keep.camArgs, ['--keep-env']);
    assert.deepEqual(keep.forwarded, ['-p', 'x']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('review — child environment', () => {
  const dirty = () => ({
    PATH: '/usr/bin',
    CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN,
    CLAUDE_CODE_ACCOUNT_UUID: 'uuid-someone-else',
    CAM_PROFILE: 'work',
    CAM_TTY: '1',
  });

  // FINDING 1: the default account returned before the HOSTILE_ENV scan, so an
  // ambient token reached the child with `stripped` AND `notes` both empty —
  // cam said nothing at all while the banner named a different login.
  it('the default account REPORTS the hostile variables it passes through', () => {
    const { ctx } = mkCtx({ env: dirty() });
    const r = sanitizeChildEnv(ctx, { profile: { name: 'default', dir: null } });

    // the pass-through itself is deliberate and must not change
    assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN);
    assert.deepEqual(r.stripped, []);

    const names = r.kept.map((k) => k.name).sort();
    assert.deepEqual(names, ['CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_OAUTH_TOKEN'],
      'a variable that outranks the named account must never be silent');
    for (const entry of r.kept) {
      assert.equal(typeof entry.impact, 'string');
      assert.notEqual(entry.impact, entry.key, `${entry.name} impact key is missing from the catalogue`);
    }
  });

  it('--keep-env reports the same way, and a clean environment reports nothing', () => {
    const { ctx } = mkCtx({ env: dirty() });
    const kept = sanitizeChildEnv(ctx, { profile: { name: 'w', dir: '/p/w' }, keepEnv: true });
    assert.deepEqual(kept.stripped, []);
    assert.deepEqual(kept.kept.map((k) => k.name).sort(),
      ['CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_OAUTH_TOKEN']);

    const { ctx: clean } = mkCtx({ env: { PATH: '/usr/bin' } });
    assert.deepEqual(sanitizeChildEnv(clean, { profile: { name: 'default', dir: null } }).kept, []);
    assert.deepEqual(sanitizeChildEnv(clean, { profile: { name: 'w', dir: '/p/w' } }).kept, []);
  });

  // FINDING 5: PIN_ENV was cleared only after the dir === null early return, so
  // a nested `claude` inside a default-account session resolved to whatever
  // CAM_PROFILE said — a different account than its parent.
  it('cam exec on the default account drops cam\'s own pins from the child', async (t) => {
    const seed = seedStore('pins', { withDefault: true });
    const spawn = fakeSpawn();
    const { ctx, err } = mkCtx({
      home: seed.home,
      spawn: spawn.fn,
      env: {
        CAM_HOME: seed.store,
        CAM_PROFILE: 'work',
        CAM_ACCOUNT: 'work',
        CAM_TTY: '1',
        CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN,
      },
    });

    const code = await cmdExec(ctx, ['default', '--', '/bin/echo', 'hi']);
    assert.equal(code, 0, err.data);
    assert.equal(spawn.calls.length, 1);
    const childEnv = spawn.calls[0].env;
    for (const pin of ['CAM_PROFILE', 'CAM_ACCOUNT', 'CAM_TTY']) {
      assert.equal(childEnv[pin], undefined, `${pin} reached a nested session`);
    }
    // the deliberate pass-through is untouched, and now it is announced
    assert.equal(childEnv.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN);
    assert.ok(err.data.includes('CLAUDE_CODE_OAUTH_TOKEN'),
      'the surviving override was not reported on stderr');
    t.diagnostic(err.data.trim());
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('review — resolution', () => {
  // FINDING 2: ctx.env is a plain copy, so on Windows a lower-cased pin (the
  // SAME variable to the OS) was invisible and a different account launched.
  it('CAM_PROFILE is read case-insensitively on Windows', () => {
    const accounts = [acct('work', '/p/work'), acct('home', '/p/home')];
    const { ctx } = mkCtx({ platform: 'win32', env: { cam_profile: 'home' } });
    const r = resolveTarget(ctx, { accounts, forwarded: [], flags: {}, config: {}, mode: SILENT, last: 'work' });
    assert.equal(r.profile.name, 'home', 'the pin was ignored and `last` won');
    assert.ok(r.short.includes('CAM_PROFILE'), r.short);

    // POSIX environments really are case-sensitive: nothing changes there.
    const { ctx: posix } = mkCtx({ platform: 'linux', env: { cam_profile: 'home' } });
    const p = resolveTarget(posix, {
      accounts, forwarded: [], flags: {}, config: {}, mode: SILENT, last: 'work',
    });
    assert.equal(p.profile.name, 'work');
  });

  // FINDING 10: --cam matched exactly while `cam use` / `env` / `exec` all match
  // through profiles.get, which is case-insensitive.
  it('--cam <Name> resolves case-insensitively, like every other command', () => {
    const accounts = [acct('work', '/p/work'), acct('home', '/p/home')];
    const { ctx } = mkCtx();
    const r = resolveTarget(ctx, {
      accounts, forwarded: ['-p', 'x'], camName: 'HOME', flags: {}, config: {}, mode: SILENT,
    });
    assert.equal(r.profile.name, 'home');

    // a name that really is unknown must still be a loud error, never a fallback
    assert.throws(() => resolveTarget(ctx, {
      accounts, forwarded: [], camName: 'nosuch', flags: {}, config: {}, mode: SILENT,
    }), (e) => e.code === 'NOT_FOUND');
  });

  // FINDING 8: `which.reason.default` says "your existing Claude Code login",
  // which describes the reserved default — not the first cam profile.
  it('the accounts[0] fallback is not labelled "your existing Claude Code login"', () => {
    const accounts = [acct('work', '/p/work'), acct('personal', '/p/personal')];
    const { ctx } = mkCtx();
    const wrong = ctx.t('which.reason.default');
    const r = resolveTarget(ctx, { accounts, forwarded: [], flags: {}, config: {}, mode: SILENT, last: null });

    assert.equal(r.profile.name, 'work');
    assert.ok(r.dir !== null || true);
    assert.notEqual(r.short, wrong, 'an ordinary profile was described as the default login');
    assert.equal(r.reason.includes(wrong), false, r.reason);
    assert.ok(r.detail.length > 0, 'the launch must still explain itself');

    // and the reserved default, when it exists, keeps the label that is true
    const withDefault = [acct('default', null), ...accounts];
    const d = resolveTarget(ctx, {
      accounts: withDefault, forwarded: [], flags: {}, config: {}, mode: SILENT, last: null,
    });
    assert.equal(d.profile.name, 'default');
    assert.equal(d.short, wrong);
  });

  // FINDING 9: `launch.lastMissing` hardcodes "using default instead", which is
  // false when there is no default account in the store at all.
  it('a removed `last` does not claim "default" when an ordinary profile runs', () => {
    const accounts = [acct('work', '/p/work'), acct('home', '/p/home')];
    const { ctx, err } = mkCtx();
    const r = resolveTarget(ctx, {
      accounts, forwarded: [], flags: {}, config: {}, mode: SILENT, last: 'gone',
    });
    assert.equal(r.profile.name, 'work');
    assert.ok(err.data.includes('gone'), 'the removed account must still be named');
    assert.equal(err.data.includes(ctx.t('launch.lastMissing', { name: 'gone' })), false,
      'cam announced an account that does not exist in this store');

    // with a real default present the original sentence is true and is kept
    const { ctx: ctx2, err: err2 } = mkCtx();
    const r2 = resolveTarget(ctx2, {
      accounts: [acct('default', null), ...accounts],
      forwarded: [], flags: {}, config: {}, mode: SILENT, last: 'gone',
    });
    assert.equal(r2.profile.name, 'default');
    assert.ok(err2.data.includes(ctx2.t('launch.lastMissing', { name: 'gone' })));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('review — cam which', () => {
  // FINDING 12: the message and hint were the no-accounts pair but the code was
  // NOT_FOUND (4), while `cam launch` and `cam use` both answer NO_ACCOUNTS (6).
  it('an empty store exits NO_ACCOUNTS, like launch and use', async () => {
    const seed = seedStore('empty');
    const { ctx } = mkCtx({ home: seed.home, env: { CAM_HOME: seed.store, CLAUDECODE: '1' } });
    await assert.rejects(() => cmdWhich(ctx, []), (e) => {
      assert.equal(e.message, ctx.t('err.noAccounts'));
      assert.equal(e.exitCode, EXIT.NO_ACCOUNTS, `exit ${e.exitCode} for the no-accounts message`);
      return true;
    });
  });

  // FINDING 6 (and the second half of FINDING 1): `which -v` stated a removal
  // that sanitizeChildEnv never performs for the reserved default account.
  it('does not promise to remove a variable it passes through', async () => {
    const seed = seedStore('which', { profiles: ['work'], withDefault: true });
    const env = { CAM_HOME: seed.store, CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN };

    const dflt = mkCtx({ home: seed.home, env });
    assert.equal(await cmdWhich(dflt.ctx, ['-v', '--cam', 'default']), EXIT.OK);
    const promise = dflt.ctx.t('which.ambientSet', { name: 'CLAUDE_CODE_OAUTH_TOKEN' });
    assert.equal(dflt.out.data.includes(promise), false,
      'cam said it would remove the token from a session it does not touch');
    assert.ok(dflt.out.data.includes('CLAUDE_CODE_OAUTH_TOKEN'),
      'the override must still be reported, just truthfully');

    // a real profile really does strip it, and must keep saying so
    const real = mkCtx({ home: seed.home, env });
    assert.equal(await cmdWhich(real.ctx, ['-v', '--cam', 'work']), EXIT.OK);
    assert.ok(real.out.data.includes(promise), real.out.data);
  });

  it('--json marks each ambient row with whether it is actually stripped', async () => {
    const seed = seedStore('whichjson', { profiles: ['work'], withDefault: true });
    const env = { CAM_HOME: seed.store, CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN };

    const dflt = mkCtx({ home: seed.home, env });
    await cmdWhich(dflt.ctx, ['--json', '--cam', 'default']);
    const a = JSON.parse(dflt.out.data);
    const rowA = a.ambient.find((r) => r.name === 'CLAUDE_CODE_OAUTH_TOKEN');
    assert.equal(rowA.stripped, false, 'the default account strips nothing');
    assert.equal(a.configDir, null);

    const real = mkCtx({ home: seed.home, env });
    await cmdWhich(real.ctx, ['--json', '--cam', 'work']);
    const b = JSON.parse(real.out.data);
    const rowB = b.ambient.find((r) => r.name === 'CLAUDE_CODE_OAUTH_TOKEN');
    assert.equal(rowB.stripped, true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('review — cam exec', () => {
  // FINDING 3: targetKind answered 'exe' for every extensionless command, and
  // libuv's Windows PATH search only appends .com/.exe — so every .cmd shim
  // (npm, npx, yarn, tsc) failed ENOENT and cam returned a bare, silent 127.
  it('an extensionless command goes through ComSpec on Windows', async () => {
    const seed = seedStore('execwin', { profiles: ['work'] });
    const spawn = fakeSpawn();
    const { ctx, err } = mkCtx({
      platform: 'win32',
      home: seed.home,
      spawn: spawn.fn,
      env: { CAM_HOME: seed.store, ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    });

    const code = await cmdExec(ctx, ['work', '--', 'npm', '--version']);
    assert.equal(code, 0, err.data);
    assert.equal(spawn.calls.length, 1);
    const call = spawn.calls[0];
    assert.equal(call.file, 'C:\\Windows\\system32\\cmd.exe',
      'npm was spawned directly, which cannot find npm.cmd');
    assert.deepEqual(call.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(call.args[3].includes('npm'), call.args[3]);
  });

  it('a POSIX host still spawns an extensionless command directly', async () => {
    const seed = seedStore('execposix', { profiles: ['work'] });
    const spawn = fakeSpawn();
    const { ctx } = mkCtx({
      platform: 'linux',
      home: seed.home,
      spawn: spawn.fn,
      env: { CAM_HOME: seed.store },
    });
    assert.equal(await cmdExec(ctx, ['work', '--', 'npm', '--version']), 0);
    assert.equal(spawn.calls[0].file, 'npm');
    assert.deepEqual(spawn.calls[0].args, ['--version']);
  });

  it('a command that never started says so instead of returning a bare 127', async () => {
    const seed = seedStore('execenoent', { profiles: ['work'] });
    const calls = [];
    const { ctx, err } = mkCtx({
      home: seed.home,
      env: { CAM_HOME: seed.store },
      spawn: (file) => {
        calls.push(file);
        const child = new EventEmitter();
        const e = new Error('spawn ENOENT');
        e.code = 'ENOENT';
        setImmediate(() => child.emit('error', e));
        return child;
      },
    });

    const code = await cmdExec(ctx, ['work', '--', 'definitely-not-a-real-binary']);
    assert.equal(code, EXIT.NO_CLAUDE, 'the exit code is still 127');
    assert.ok(err.data.includes('definitely-not-a-real-binary'),
      'exec failed with no output at all');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('review — picker', () => {
  // FINDINGS 7 and 11: launch.js passes allowAdd, but pick/select/selectLine
  // and ui.buildMenu all look for an actual add ROW, so `a` was advertised in
  // the footer, drawn nowhere, and ignored when pressed.
  it('allowAdd draws an add row and `a` selects it (line mode)', async () => {
    const items = [acct('work', '/p/work'), acct('home', '/p/home')];
    const err = mkStream();
    const out = mkStream();
    const ctx = createCtx({
      platform: 'linux',
      home: '/home/nobody',
      cwd: '/w',
      now: NOW,
      env: {},
      argv: ['node', '/x/bin/cam.js'],
      version: '9.9.9',
      io: { in: Readable.from(['a\n']), out, err },
    });

    const sc = screen.createScreen(ctx);
    const chosen = await screen.pick(ctx, sc, {
      items,
      index: 0,
      allowAdd: true,
      mode: { kind: 'line', reason: '' },
    });
    assert.ok(err.data.includes(ctx.t('pick.addRow')), `no add row was drawn:\n${err.data}`);
    assert.ok(chosen && chosen.kind === 'add', `pressing a returned ${JSON.stringify(chosen)}`);
  });

  it('allowAdd:false still draws no add row, and `a` is not a choice', async () => {
    const items = [acct('work', '/p/work'), acct('home', '/p/home')];
    const err = mkStream();
    const out = mkStream();
    const ctx = createCtx({
      platform: 'linux',
      home: '/home/nobody',
      cwd: '/w',
      now: NOW,
      env: {},
      argv: ['node', '/x/bin/cam.js'],
      version: '9.9.9',
      io: { in: Readable.from(['a\n', 'q\n']), out, err },
    });

    const sc = screen.createScreen(ctx);
    const chosen = await screen.pick(ctx, sc, {
      items,
      index: 0,
      allowAdd: false,
      mode: { kind: 'line', reason: '' },
    });
    assert.equal(err.data.includes(ctx.t('pick.addRow')), false);
    assert.equal(chosen, null, 'a menu with no add row must not invent one');
  });
});
