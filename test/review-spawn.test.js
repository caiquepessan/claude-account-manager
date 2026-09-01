// test/review-spawn.test.js — regressions for three confirmed spawn/prompt defects.
//   1. Windows `script` targets were handed to cmd.exe, which starts them through
//      the machine's file association (WScript.exe for .js, nothing for .sh) — the
//      target ran under the wrong interpreter, or not at all, while cam exited 0.
//   2. `interactivity()` granted the numbered prompt on a TTY stderr alone, so
//      `echo hi | cam launch` ate the caller's piped stdin, spawned nothing, and
//      still exited 0.
//   3. An explicit CAM_CLAUDE_BIN / config.claudeBin that failed to resolve fell
//      through to auto-discovery and silently ran a DIFFERENT claude.
//
// Constraints: node:test + node:assert/strict only, every filesystem fixture in
// a mkdtemp sandbox, nothing ever reaches the real ~/.claude or the real store.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCtx, isCamError } from '../src/ctx.js';
import { runInherit, runCapture, resolveClaude, requireClaude } from '../src/claude.js';
import { interactivity } from '../src/tty.js';
import { resolveTarget } from '../src/commands/launch.js';

/** Every sandbox this file creates, removed in `after`. */
const SANDBOXES = [];

/**
 * A throwaway directory. Never the real home and never the real store.
 * @param {string} tag short name fragment
 * @returns {string} the sandbox root
 */
function sandboxDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cam-${tag}-`));
  SANDBOXES.push(dir);
  return dir;
}

after(() => {
  for (const dir of SANDBOXES) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir must never fail the suite */
    }
  }
});

/** A stream that collects writes instead of touching a terminal. */
function mkStream(over = {}) {
  return {
    isTTY: false,
    data: '',
    write(s) { this.data += String(s); return true; },
    on() { return this; },
    once() { return this; },
    removeListener() { return this; },
    end() {},
    ...over,
  };
}

/**
 * A child that closes immediately, with no pipes — enough for both runInherit
 * and runCapture, which guard every stream access.
 * @param {number} code the exit code to report
 * @returns {EventEmitter} the fake child
 */
function mkChild(code = 0) {
  const child = new EventEmitter();
  child.stdout = null;
  child.stderr = null;
  child.kill = () => {};
  setImmediate(() => child.emit('close', code, null));
  return child;
}

/**
 * A `ctx.spawn` that records instead of starting anything.
 * @param {object[]} calls accumulator
 * @returns {Function} the fake spawn
 */
function recordingSpawn(calls) {
  return (file, args, opts) => {
    calls.push({ file, args, opts });
    return mkChild(0);
  };
}

/**
 * A fake machine with a recording spawn.
 * @param {object} [over] ctx overrides
 * @returns {{ctx: object, calls: object[]}} the context and what it spawned
 */
function spawnCtx(over = {}) {
  const calls = [];
  const ctx = createCtx({
    platform: 'linux',
    home: '/home/u',
    cwd: '/w',
    now: 1788000000000,
    env: {},
    argv: ['node', '/x/bin/cam.js'],
    version: '9.9.9',
    ...over,
    io: { in: mkStream(), out: mkStream(), err: mkStream() },
    spawn: recordingSpawn(calls),
  });
  return { ctx, calls };
}

/** A directory holding stub interpreters, used only as PATH entries. */
function interpreterDir(tag, names) {
  const dir = sandboxDir(tag);
  for (const name of names) fs.writeFileSync(path.join(dir, name), '# stub; never executed\n', 'utf8');
  return dir;
}

// ═══════════════════════════════════════════════════════════════════════════
// FINDING 1 — cmd.exe cannot start a script
// ═══════════════════════════════════════════════════════════════════════════

describe('A — a Windows script target reaches a real interpreter, never a file association', () => {
  it('a .js target runs under node with every argument intact', async () => {
    const { ctx, calls } = spawnCtx({
      platform: 'win32',
      execPath: 'C:\\nodejs\\node.exe',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: '' },
    });
    const script = 'C:\\tmp\\probe.js';
    const res = await runInherit(ctx, script, ['hello', 'a b'], { kind: 'script' });

    assert.equal(calls.length, 1);
    const call = calls[0];
    // Before the fix this was ComSpec, and cmd handed the file to `ftype JSFile`
    // — WScript.exe by default, which drops the arguments and exits 0.
    assert.equal(call.file, 'C:\\nodejs\\node.exe', `spawned ${call.file}, not node`);
    assert.deepEqual(call.args, [script, 'hello', 'a b']);
    assert.notEqual(call.opts.windowsVerbatimArguments, true, 'node takes normal argv escaping');
    assert.equal(res.exitCode, 0);
  });

  it('a .mjs and a .cjs target do too', async () => {
    for (const ext of ['.mjs', '.cjs']) {
      const { ctx, calls } = spawnCtx({
        platform: 'win32',
        execPath: 'C:\\nodejs\\node.exe',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: '' },
      });
      await runInherit(ctx, `C:\\tmp\\probe${ext}`, ['x'], { kind: 'script' });
      assert.equal(calls[0].file, 'C:\\nodejs\\node.exe', ext);
      assert.deepEqual(calls[0].args, [`C:\\tmp\\probe${ext}`, 'x'], ext);
    }
  });

  it('runCapture routes a .js target the same way — one spawnSpec, both paths', async () => {
    const { ctx, calls } = spawnCtx({
      platform: 'win32',
      execPath: 'C:\\nodejs\\node.exe',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: '' },
    });
    await runCapture(ctx, 'C:\\tmp\\probe.js', ['--version'], { kind: 'script', timeoutMs: 0 });
    assert.equal(calls[0].file, 'C:\\nodejs\\node.exe');
    assert.deepEqual(calls[0].args, ['C:\\tmp\\probe.js', '--version']);
  });

  it('a .sh target runs under the bash it can find, not under cmd.exe', async () => {
    const binDir = interpreterDir('sh-host', ['bash.exe']);
    const { ctx, calls } = spawnCtx({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: binDir },
    });
    await runInherit(ctx, 'C:\\tmp\\t.sh', ['hello'], { kind: 'script' });

    // Before the fix cmd.exe resolved .sh through `sh_auto_file`, which runs
    // nothing at all: exit 0 and the script's marker file never appeared.
    assert.equal(calls[0].file, path.join(binDir, 'bash.exe'));
    assert.deepEqual(calls[0].args, ['C:\\tmp\\t.sh', 'hello']);
  });

  it('with no shell anywhere a .sh target still fails loudly (127), never silently', async () => {
    const { ctx, calls } = spawnCtx({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: '' },
    });
    await runInherit(ctx, 'C:\\tmp\\t.sh', [], { kind: 'script' });
    assert.equal(calls[0].file, 'bash.exe', 'a bare name lets spawn report ENOENT -> 127');
    assert.notEqual(calls[0].file, 'C:\\Windows\\System32\\cmd.exe');
  });

  it('a .ps1 target runs under a PowerShell host with -NoProfile -File', async () => {
    const binDir = interpreterDir('ps-host', ['powershell.exe']);
    const { ctx, calls } = spawnCtx({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: binDir },
    });
    // launch.js labels .ps1 'script'; classifyKind calls it 'unknown'. Both must
    // reach a host, so the routing keys off the extension, not the label.
    for (const kind of ['script', 'unknown']) {
      calls.length = 0;
      await runInherit(ctx, 'C:\\tmp\\t.ps1', ['hello'], { kind });
      assert.equal(calls[0].file, path.join(binDir, 'powershell.exe'), kind);
      assert.deepEqual(calls[0].args, ['-NoProfile', '-File', 'C:\\tmp\\t.ps1', 'hello'], kind);
    }
  });

  it('.cmd, .bat and an extensionless PATH lookup still go through ComSpec', async () => {
    const { ctx, calls } = spawnCtx({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: '' },
    });
    const cases = [
      ['C:\\npm\\claude.cmd', 'cmd'],
      ['C:\\npm\\claude.bat', 'cmd'],
      ['claude', 'script'],
    ];
    for (const [file, kind] of cases) {
      calls.length = 0;
      await runInherit(ctx, file, ['-p', 'hi'], { kind });
      assert.equal(calls[0].file, 'C:\\Windows\\System32\\cmd.exe', file);
      assert.equal(calls[0].args[0], '/d', file);
      assert.equal(calls[0].opts.windowsVerbatimArguments, true, file);
      assert.ok(calls[0].args[3].includes(file), file);
    }
  });

  it('a native .exe is still spawned directly, and POSIX is untouched', async () => {
    const win = spawnCtx({ platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
    await runInherit(win.ctx, 'C:\\Program Files\\claude\\claude.exe', ['-p'], { kind: 'exe' });
    assert.equal(win.calls[0].file, 'C:\\Program Files\\claude\\claude.exe');
    assert.deepEqual(win.calls[0].args, ['-p']);

    // On POSIX a script is started by its own shebang — no interpreter guessing.
    const nix = spawnCtx({ platform: 'linux', env: { PATH: '/usr/bin' } });
    for (const file of ['/opt/claude/cli.js', '/opt/claude/run.sh', '/usr/local/bin/claude']) {
      nix.calls.length = 0;
      await runInherit(nix.ctx, file, ['x'], { kind: 'script' });
      assert.equal(nix.calls[0].file, file, file);
      assert.deepEqual(nix.calls[0].args, ['x'], file);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FINDING 2 — the picker must not eat piped stdin
// ═══════════════════════════════════════════════════════════════════════════

describe('B — cam never prompts on a stdin it was handed as data', () => {
  /** stdin whose setRawMode throws, exactly as a piped Socket's absence does. */
  const pipedStdin = () => mkStream({ isTTY: false });
  const ttyStdinNoRaw = () => mkStream({
    isTTY: true,
    setRawMode() {
      const e = new Error('ENOTTY');
      e.code = 'ENOTTY';
      throw e;
    },
  });

  /**
   * @param {object} io the three streams
   * @param {object} [env] the (complete) environment
   * @returns {object} a fake machine
   */
  const ctxWith = (io, env = {}) => createCtx({
    platform: 'linux',
    home: '/home/u',
    cwd: '/w',
    now: 1788000000000,
    env,
    argv: ['node', '/x/bin/cam.js'],
    version: '9.9.9',
    spawn: () => { throw new Error('no spawn in this test'); },
    io,
  });

  it('a TTY stderr with a REDIRECTED stdin cannot ask — `echo hi | cam launch`', () => {
    const ctx = ctxWith({ in: pipedStdin(), out: mkStream(), err: mkStream({ isTTY: true }) });
    const mode = interactivity(ctx, { forwarded: [] });
    // Before the fix this was 'line': selectLine attached a readline interface to
    // the pipe, read 'hi' as a menu answer, spawned nothing and exited 0.
    assert.equal(mode.kind, 'none', 'stderr alone must not unlock a prompt that READS stdin');
    assert.ok(mode.reason.length > 0, 'and it must say why');
  });

  it('that silenced menu still launches an account instead of doing nothing', () => {
    const ctx = ctxWith({ in: pipedStdin(), out: mkStream(), err: mkStream({ isTTY: true }) });
    const accounts = [
      { name: 'default', dir: null, isDefault: true, createdAt: 1, meta: {} },
      { name: 'work', dir: '/store/profiles/work', createdAt: 2, meta: { email: 'me@acme.example' } },
    ];
    const mode = interactivity(ctx, { forwarded: [] });
    const target = resolveTarget(ctx, { accounts, forwarded: [], flags: {}, config: {}, mode });
    assert.equal(target.kind, 'launch', 'a piped stdin must pass through, not swallow the run');
    assert.ok(target.profile, 'and it must name the account it chose');
    assert.ok(target.detail.length > 0, 'a silenced menu still explains itself');
  });

  it('CAM_TTY=1 still unlocks the numbered prompt — the hook tested `[ -t 0 ]` itself', () => {
    const ctx = ctxWith(
      { in: pipedStdin(), out: mkStream(), err: mkStream({ isTTY: false }) },
      { CAM_TTY: '1' },
    );
    assert.equal(interactivity(ctx, { forwarded: [] }).kind, 'line');
  });

  it('a real TTY stdin whose raw mode throws still gets the numbered prompt (MSYS/mintty)', () => {
    const ctx = ctxWith({ in: ttyStdinNoRaw(), out: mkStream(), err: mkStream({ isTTY: true }) });
    assert.equal(interactivity(ctx, { forwarded: [] }).kind, 'line');
  });

  it('CAM_TTY=0 and CLAUDECODE still win over everything', () => {
    for (const env of [{ CAM_TTY: '0' }, { CLAUDECODE: '1' }, { CI: '1' }, { CAM_NO_PROMPT: '1' }]) {
      const ctx = ctxWith({ in: ttyStdinNoRaw(), out: mkStream(), err: mkStream({ isTTY: true }) }, env);
      assert.equal(interactivity(ctx, { forwarded: [] }).kind, 'none', JSON.stringify(env));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FINDING 3 — a pinned binary that cannot be used is an error, not a fallback
// ═══════════════════════════════════════════════════════════════════════════

describe('C — an explicit claudeBin pin never falls through to a different binary', () => {
  /**
   * A sandbox holding a decoy `~/.local/bin/claude` — the auto-discovered binary
   * cam used to run silently whenever the pin failed. Discovery is driven from
   * the fake HOME rather than from PATH so the fixture does not depend on the
   * host's path separator.
   * @param {object} [env] extra environment; createCtx REPLACES the environment
   * @returns {{ctx: object, decoy: string, root: string}} the fake machine
   */
  function pinCtx(env = {}) {
    const root = sandboxDir('pin');
    const home = path.join(root, 'home');
    const localBin = path.join(home, '.local', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    const decoy = path.join(localBin, 'claude');
    fs.writeFileSync(decoy, '# the wrong claude\n', 'utf8');
    const ctx = createCtx({
      // 'linux' keeps the probe to one variant per candidate; the pin logic is
      // platform-independent and the sandbox is a real directory either way.
      platform: 'linux',
      home,
      cwd: root,
      now: 1788000000000,
      env: { PATH: '', ...env },
      argv: ['node', '/x/bin/cam.js'],
      version: '9.9.9',
      io: { in: mkStream(), out: mkStream(), err: mkStream() },
      spawn: () => { throw new Error('no spawn in this test'); },
    });
    return { ctx, decoy, root };
  }

  it('a CAM_CLAUDE_BIN that does not exist stops the search — it does not run PATH', () => {
    const missing = path.join(os.tmpdir(), 'cam-pin-does-not-exist', 'claude-1.2');
    const { ctx, decoy } = pinCtx({ CAM_CLAUDE_BIN: missing });
    const got = resolveClaude(ctx);
    assert.notEqual(got.path, decoy, 'the pin was ignored and a different claude was chosen');
    assert.equal(got.path, null);
    assert.deepEqual(got.pinned, [missing], 'the failed pin is reported');
    assert.ok(got.tried.includes(missing), 'and it appears in the "I looked in" list');
  });

  it('a config.claudeBin the cam guard rejects fails too, even though the file exists', () => {
    // A real install living under a path containing `claude-account-manager` is
    // rejected by looksLikeCam. Silently running some other claude is the bug.
    const camish = sandboxDir('claude-account-manager');
    const pin = path.join(camish, 'claude');
    fs.writeFileSync(pin, '# a real claude in an unlucky directory\n', 'utf8');
    const { ctx, decoy } = pinCtx();
    for (const opts of [{ claudeBin: pin }, { config: { claudeBin: pin } }]) {
      const got = resolveClaude(ctx, opts);
      assert.notEqual(got.path, decoy, JSON.stringify(Object.keys(opts)));
      assert.equal(got.path, null, JSON.stringify(Object.keys(opts)));
      assert.deepEqual(got.pinned, [pin]);
    }
  });

  it('requireClaude turns a failed pin into NO_CLAUDE and names the path it tried', () => {
    const missing = path.join(os.tmpdir(), 'cam-pin-does-not-exist', 'claude-1.2');
    const { ctx } = pinCtx({ CAM_CLAUDE_BIN: missing });
    assert.throws(
      () => requireClaude(ctx),
      (err) => {
        assert.ok(isCamError(err), 'must be a CamError');
        assert.equal(err.code, 'NO_CLAUDE');
        assert.ok(err.hint.includes(missing), `the hint must name the pin: ${err.hint}`);
        return true;
      },
    );
  });

  it('a pin that DOES resolve is still honoured, from both spellings', () => {
    const binDir = sandboxDir('goodpin');
    const pin = path.join(binDir, 'claude');
    fs.writeFileSync(pin, '# the pinned claude\n', 'utf8');
    const { ctx } = pinCtx({ CAM_CLAUDE_BIN: pin });
    assert.equal(resolveClaude(ctx).path, pin);
    const clean = pinCtx().ctx;
    assert.equal(resolveClaude(clean, { claudeBin: pin }).path, pin);
    assert.equal(resolveClaude(clean, { config: { claudeBin: pin } }).path, pin);
    assert.deepEqual(resolveClaude(clean, { claudeBin: pin }).pinned, []);
  });

  it('a stale CLAUDE_CODE_EXECPATH is NOT a pin — it is ambient, so discovery continues', () => {
    // Claude Code exports it into every child. cam must not become unusable
    // because the parent process pointed at something cam cannot start.
    const { ctx, decoy } = pinCtx({ CLAUDE_CODE_EXECPATH: '/opt/gone/claude' });
    assert.equal(resolveClaude(ctx).path, decoy);
  });
});
