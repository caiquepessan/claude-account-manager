// test/review-rcfiles.test.js — regression tests for the confirmed rc-file
// defects: a symlinked rc file being replaced by a regular file, an unpaired
// BEGIN marker turning `cam shell uninstall` into a file eraser, a
// user-authored claude.fish being overwritten, and the two generated runtimes
// leaking variables into the shell that sourced them.
//
// ISOLATION CONTRACT FOR THIS FILE
//   * Every byte written lives under one mkdtemp() directory, removed in the
//     single `after` hook. os.homedir() is never called: `ctx.home` is always a
//     temp directory, so ~/.claude and ~/.claude-account-manager are
//     structurally unreachable.
//   * Nothing spawns `claude` or the real `cam`; the only children are `bash`
//     and `powershell.exe`, each running a script written into the sandbox with
//     a PATH that cannot reach a real cam.
//   * Symlink creation needs a privilege Windows does not always grant, and
//     bash/powershell are not on every machine. Every such assertion is skipped
//     OUT LOUD with t.skip(reason) rather than silently passing.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createCtx } from '../src/ctx.js';
import * as fsx from '../src/fsx.js';
import * as shell from '../src/shell.js';

const WIN = process.platform === 'win32';

/** Every temp root this file created, torn down in the single `after` hook. */
const ROOTS = [];

/**
 * A throwaway directory under the OS temp dir. Never derived from a home path.
 * @param {string} label short suite tag, only for readable temp names
 * @returns {string} the absolute root
 */
function mkRoot(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), `cam-rcfiles-${label}-`)));
  ROOTS.push(root);
  return root;
}

after(() => {
  for (const root of ROOTS.reverse()) {
    // Links are unlinked first so the recursive remove is never tempted to walk
    // through one — the same rule the production delete follows.
    try {
      unlinkLinks(root, 0);
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
 * Unlink every symlink under `dir` without following any of them.
 * @param {string} dir directory to sweep
 * @param {number} depth recursion guard
 * @returns {void} nothing
 */
function unlinkLinks(dir, depth) {
  if (depth > 20) return;
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
    if (entry.isDirectory()) unlinkLinks(p, depth + 1);
  }
}

/**
 * A collecting stand-in for a non-TTY stream.
 * @returns {{isTTY:boolean, columns:number, rows:number, write:Function}} the stream
 */
function memStream() {
  return { isTTY: false, columns: 80, rows: 24, write: () => true };
}

/**
 * A cam context pinned to a sandbox home and store.
 * @param {string} home the sandbox directory
 * @returns {{ctx:object, advance:Function}} the harness
 */
function makeCtx(home) {
  let clock = 1_700_000_000_000;
  const ctx = createCtx({
    argv: [process.execPath, 'cam'],
    platform: process.platform,
    home,
    cwd: home,
    locale: 'en',
    env: { LANG: 'en_US.UTF-8', NO_COLOR: '1', CAM_HOME: path.join(home, 'store') },
    io: { out: memStream(), err: memStream(), in: { isTTY: false } },
    now: () => clock,
    version: '9.9.9',
    verbose: false,
    ascii: true,
  });
  return { ctx, advance: (ms) => { clock += ms; } };
}

/**
 * Create a file symlink, reporting whether this machine allows it at all.
 * Windows needs Developer Mode or SeCreateSymbolicLinkPrivilege.
 * @param {string} target the file the link should point at
 * @param {string} link the link path to create
 * @returns {boolean} true when the link now exists
 */
function trySymlink(target, link) {
  try {
    fs.symlinkSync(target, link, 'file');
    return fs.lstatSync(link).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Path form both git-bash and a native shell accept. */
const slash = (p) => String(p).replace(/\\/g, '/');

// ═════════════════════════════════════════════════════════════════════════════
// A — a symlinked destination keeps its link (findings 1 and 2)
// ═════════════════════════════════════════════════════════════════════════════

describe('rc files that are symlinks into a dotfiles repo', () => {
  let root;
  let h;

  before(() => {
    root = mkRoot('symlink');
    h = makeCtx(root);
  });

  it('writeFileAtomic writes THROUGH the link instead of replacing it', async (t) => {
    const repo = path.join(root, 'dotfiles');
    const home = path.join(root, 'home-a');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const real = path.join(repo, 'zshrc');
    const link = path.join(home, '.zshrc');
    fs.writeFileSync(real, 'ORIGINAL\n', 'utf8');
    if (!trySymlink(real, link)) {
      t.skip('this machine refuses to create symlinks (Windows needs Developer Mode)');
      return;
    }

    await fsx.writeFileAtomic(h.ctx, link, 'PATCHED BY CAM\n', { mode: 0o644 });

    assert.equal(
      fs.lstatSync(link).isSymbolicLink(),
      true,
      'the rename replaced the symlink with a regular file and orphaned the dotfiles repo'
    );
    assert.equal(fs.readFileSync(real, 'utf8'), 'PATCHED BY CAM\n', 'the repo copy was not updated');
    assert.equal(fs.readFileSync(link, 'utf8'), 'PATCHED BY CAM\n');
    assert.deepEqual(
      fs.readdirSync(home).sort(),
      ['.zshrc'],
      'a temp file was left beside the link instead of beside the real file'
    );
    assert.deepEqual(fs.readdirSync(repo).filter((n) => n.endsWith('.tmp')), []);
  });

  it('a symlink is never a way through to the three Claude-owned files', async (t) => {
    const claudeDir = path.join(root, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const creds = path.join(claudeDir, '.credentials.json');
    fs.writeFileSync(creds, '{"real":"token"}\n', 'utf8');
    const link = path.join(root, 'innocent-name.txt');
    if (!trySymlink(creds, link)) {
      t.skip('this machine refuses to create symlinks (Windows needs Developer Mode)');
      return;
    }

    await assert.rejects(
      () => fsx.writeFileAtomic(h.ctx, link, 'nope'),
      (err) => err && err.name === 'CamError' && err.code === 'UNSAFE',
      'a symlink pointing at .credentials.json was written through'
    );
    assert.equal(fs.readFileSync(creds, 'utf8'), '{"real":"token"}\n');
    fs.unlinkSync(link);
  });

  it('patchFile installs and uninstalls without consuming the link', async (t) => {
    const repo = path.join(root, 'dotfiles-b');
    const home = path.join(root, 'home-b');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const real = path.join(repo, 'zshrc');
    const link = path.join(home, '.zshrc');
    const original = 'export FROM_REPO=1\n';
    fs.writeFileSync(real, original, 'utf8');
    if (!trySymlink(real, link)) {
      t.skip('this machine refuses to create symlinks (Windows needs Developer Mode)');
      return;
    }

    const block = shell.renderPosixStub(h.ctx, { version: '1.0.0', runtimePath: '/x/cam.sh' });
    h.advance(1000);
    const a = await shell.patchFile(h.ctx, link, block);
    assert.equal(a.action, 'appended');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'install ate the symlink');
    const patched = fs.readFileSync(real, 'utf8');
    assert.ok(patched.startsWith(original), 'the repo copy lost the user content');
    assert.ok(patched.includes(shell.BEGIN), 'the block was written somewhere other than the repo copy');

    h.advance(1000);
    const b = await shell.patchFile(h.ctx, link, null);
    assert.equal(b.action, 'removed');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'uninstall ate the symlink');
    assert.equal(fs.readFileSync(real, 'utf8'), original, 'the repo copy was not restored byte-for-byte');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B — an unpaired BEGIN marker (finding 3)
// ═════════════════════════════════════════════════════════════════════════════

describe('an rc file carrying an UNPAIRED BEGIN marker', () => {
  let root;
  let h;
  let rcDir;

  const USER = [
    'export SECRET_A=1',
    'export SECRET_B=2',
    'my_important_function() { :; }',
    ''
  ].join('\n');

  before(() => {
    root = mkRoot('orphan');
    h = makeCtx(root);
    rcDir = path.join(root, 'rc');
    fs.mkdirSync(rcDir, { recursive: true });
  });

  it('uninstall removes only cam\'s own block, never the lines under an orphan marker', async () => {
    const file = path.join(rcDir, '.bashrc');
    fs.writeFileSync(file, `${shell.BEGIN}\n${USER}`, 'utf8');
    const block = shell.renderPosixStub(h.ctx, { version: '1.0.0', runtimePath: '/x/cam.sh' });

    h.advance(1000);
    assert.equal((await shell.patchFile(h.ctx, file, block)).action, 'appended');

    h.advance(1000);
    assert.equal((await shell.patchFile(h.ctx, file, null)).action, 'removed');

    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('export SECRET_A=1'), 'the user\'s own rc content was deleted');
    assert.ok(text.includes('my_important_function() { :; }'));
    assert.equal(text.includes(shell.END), false, 'cam\'s block survived the uninstall');
    assert.equal(text.split(shell.BEGIN).length - 1, 1, 'the orphan marker was duplicated or removed');
  });

  it('a re-install upgrades cam\'s block and leaves the orphan\'s neighbours alone', async () => {
    const file = path.join(rcDir, '.bashrc-upgrade');
    fs.writeFileSync(file, `${shell.BEGIN}\n${USER}`, 'utf8');
    const v1 = shell.renderPosixStub(h.ctx, { version: '1.0.0', runtimePath: '/x/cam.sh' });
    const v2 = shell.renderPosixStub(h.ctx, { version: '2.0.0', runtimePath: '/x/cam.sh' });

    h.advance(1000);
    await shell.patchFile(h.ctx, file, v1);
    h.advance(1000);
    assert.equal((await shell.patchFile(h.ctx, file, v2)).action, 'upgraded');

    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('export SECRET_B=2'), 'the re-install deleted the user\'s own rc content');
    assert.ok(text.includes('cam:2.0.0') && !text.includes('cam:1.0.0'));
    assert.equal(text.split(shell.END).length - 1, 1, 'the upgrade left more than one closing marker');
  });

  it('the exported blockRe cannot start a match at an unpaired BEGIN', () => {
    const file = `${shell.BEGIN}\nKEEP ME\n${shell.BEGIN}\npayload\n${shell.END}\n`;
    const m = shell.blockRe.exec(file);
    assert.ok(m, 'the real block was not matched at all');
    assert.equal(m.index, `${shell.BEGIN}\nKEEP ME\n`.length, 'the match started at the orphan marker');
    assert.equal(m[0].includes('KEEP ME'), false, 'the match swallowed the user\'s line');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C — a user-authored claude.fish (finding 4)
// ═════════════════════════════════════════════════════════════════════════════

describe('a claude.fish cam did not write', () => {
  let root;
  let h;
  let rcDir;
  const MINE = 'function claude\n  echo mine\nend\n';

  before(() => {
    root = mkRoot('fish');
    h = makeCtx(root);
    rcDir = path.join(root, 'fish-functions');
    fs.mkdirSync(rcDir, { recursive: true });
  });

  it('install refuses to overwrite it and reports the conflict', async () => {
    const file = path.join(rcDir, 'claude.fish');
    fs.writeFileSync(file, MINE, 'utf8');
    const target = { id: 'fish', shell: 'fish', file, kind: 'file', runtime: 'self' };

    const results = await shell.install(h.ctx, [target], { version: '1.0.0', camBin: null });
    const row = results.find((r) => r.id === 'fish');
    assert.equal(row.action, 'conflict', 'install overwrote a file the user wrote');
    assert.equal(row.foreign, true, 'the foreign finding was not reported to the caller');
    assert.equal(fs.readFileSync(file, 'utf8'), MINE, 'the user\'s own wrapper was modified');
    assert.deepEqual(
      fs.readdirSync(rcDir).filter((n) => n.includes('cam-backup')),
      [],
      'a backup was taken of a file that was never going to be written'
    );

    // And the guard that makes uninstall safe still holds afterwards: cam's
    // signature was never stamped into the user's file.
    const after = await shell.uninstall(h.ctx, [target]);
    assert.equal(after.find((r) => r.id === 'fish').action, 'not-installed');
    assert.equal(fs.readFileSync(file, 'utf8'), MINE);
  });

  it('force overrides the refusal, because the caller asked for it explicitly', async () => {
    const file = path.join(rcDir, 'claude-forced.fish');
    fs.writeFileSync(file, MINE, 'utf8');
    const target = { id: 'fish', shell: 'fish', file, kind: 'file', runtime: 'self' };

    h.advance(1000);
    const results = await shell.install(h.ctx, [target], { version: '1.0.0', camBin: null, force: true });
    const row = results.find((r) => r.id === 'fish');
    assert.equal(row.action, 'upgraded');
    assert.ok(fs.readFileSync(file, 'utf8').includes('claude-account-manager'));
    assert.ok(row.backup && fs.readFileSync(row.backup, 'utf8') === MINE, 'the original was not backed up');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D — what the generated runtimes leak into the caller (findings 5, 6, 7)
// ═════════════════════════════════════════════════════════════════════════════

describe('the generated runtimes keep to themselves', () => {
  let root;
  let h;

  before(() => {
    root = mkRoot('runtime');
    h = makeCtx(root);
  });

  it('the POSIX hook declares its variables local', () => {
    const text = shell.renderPosixRuntime(h.ctx, { version: '1.2.3', camBin: null });
    assert.ok(
      /^\s*local cam_bin real\b/m.test(text),
      'cam_bin and real are assigned without `local`, so they land in the user\'s shell'
    );
  });

  it('bash: running `claude` leaves the caller\'s $cam_bin and $real untouched', async (t) => {
    const hook = path.join(root, 'cam-hook.sh');
    const emptyBin = path.join(root, 'empty-bin');
    fs.mkdirSync(emptyBin, { recursive: true });
    fs.writeFileSync(hook, shell.renderPosixRuntime(h.ctx, { version: '1.2.3', camBin: null }), 'utf8');

    // PATH is one empty directory, so neither `cam` nor `claude` can be found:
    // the hook takes its "nothing installed" branch, which is the branch that
    // assigns BOTH variables. Nothing is ever spawned.
    const script = [
      `PATH='${slash(emptyBin)}'`,
      'real=MY_REAL',
      'cam_bin=MY_BIN',
      `. '${slash(hook)}'`,
      'claude >/dev/null',
      'printf "rc=%s real=[%s] cam_bin=[%s]\\n" "$?" "$real" "$cam_bin"'
    ].join('; ');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-c', script], { encoding: 'utf8' });
    if (r.error || typeof r.stdout !== 'string') {
      t.skip(`bash is not usable here (${r.error ? r.error.code : 'no stdout'})`);
      return;
    }
    if (!String(r.stderr).includes('neither \'cam\' nor \'claude\' found')) {
      t.skip(`the hook did not run under this bash (stderr: ${String(r.stderr).trim().slice(0, 120)})`);
      return;
    }
    assert.match(
      r.stdout,
      /real=\[MY_REAL\] cam_bin=\[MY_BIN\]/,
      `the hook clobbered the caller's variables: ${r.stdout.trim()}`
    );
  });

  it('cam.ps1 sets $PSNativeCommandArgumentPassing inside the function, not at file scope', () => {
    const text = shell.renderPowerShell(h.ctx, { version: '1.2.3', camBin: 'C:\\bin\\cam.cmd' });
    const fn = text.indexOf('function claude {');
    const assign = text.indexOf('$PSNativeCommandArgumentPassing');
    assert.ok(fn >= 0 && assign >= 0, 'the rendered file lost one of the two lines');
    assert.ok(
      assign > fn,
      'the assignment is at file scope, so dot-sourcing changes native argument passing for the whole session'
    );
  });

  it('cam.ps1 captures claude\'s exit code and re-publishes it after the restore', () => {
    const text = shell.renderPowerShell(h.ctx, { version: '1.2.3', camBin: 'C:\\bin\\cam.cmd' });
    const call = text.indexOf('& $cam launch -- @args');
    const capture = text.indexOf('$code = $LASTEXITCODE');
    const finallyAt = text.indexOf('} finally {');
    const publish = text.indexOf('$global:LASTEXITCODE = $code');
    assert.ok(call >= 0 && capture > call, 'the exit code is not captured right after the call');
    assert.ok(capture < finallyAt, 'the capture happens after the finally block, where it is already stale');
    assert.ok(
      publish > finallyAt,
      '$LASTEXITCODE is never re-published, so a future finally-block cmdlet would silently eat it'
    );
    // A bare `$LASTEXITCODE = ...` inside a function creates a function-local
    // variable the caller never sees; the $global: prefix is load-bearing.
    assert.ok(/\$global:LASTEXITCODE\s*=/.test(text));
  });

  it('powershell: the hook forwards claude\'s exit code and says nothing of its own', async (t) => {
    if (!WIN) {
      t.skip('this assertion drives the real Windows PowerShell host');
      return;
    }
    const dir = path.join(root, 'ps');
    fs.mkdirSync(dir, { recursive: true });
    const fakeCam = path.join(dir, 'fake-cam.cmd');
    fs.writeFileSync(fakeCam, '@echo off\r\nexit /b 3\r\n', 'utf8');
    const runtime = path.join(dir, 'cam.ps1');
    fs.writeFileSync(
      runtime,
      shell.renderPowerShell(h.ctx, { version: '1.2.3', camBin: null }).replace(/\n/g, '\r\n'),
      'utf8'
    );
    const driver = path.join(dir, 'drive.ps1');
    fs.writeFileSync(
      driver,
      [
        `$env:CAM_BIN = '${fakeCam.replace(/'/g, "''")}'`,
        `. '${runtime.replace(/'/g, "''")}'`,
        'claude hello',
        'Write-Host "LEC=$LASTEXITCODE TTY=[$env:CAM_TTY]"',
        ''
      ].join('\r\n'),
      'utf8'
    );

    const r = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
      { encoding: 'utf8' }
    );
    if (r.error) {
      t.skip(`powershell.exe is not usable here (${r.error.code})`);
      return;
    }
    assert.match(r.stdout, /LEC=3/, `claude's exit code did not survive the hook: ${r.stdout.trim()}`);
    assert.match(r.stdout, /TTY=\[\]/, 'CAM_TTY was left set in the caller\'s environment');
    assert.equal(r.stderr.trim(), '', `the hook wrote to stderr on its own: ${r.stderr.trim()}`);
  });
});
