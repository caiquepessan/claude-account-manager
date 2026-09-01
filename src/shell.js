// src/shell.js — the `claude` shell interception: rc-file discovery per shell,
// the external cam.sh / cam.ps1 runtime files, and the idempotent, backed-up,
// EOL-preserving marker-block install. The highest-blast-radius write in cam.

import { dirname, join } from 'node:path';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { fail } from './ctx.js';
import { copyFileIfExists, ensureDir, writeFileAtomic } from './fsx.js';
import { storePaths } from './profiles.js';
import { runCapture } from './claude.js';

/** Opening marker of the managed block. Also a comment in sh, zsh, fish and PowerShell. */
export const BEGIN = '# >>> claude-account-manager >>>';

/** Closing marker of the managed block. */
export const END = '# <<< claude-account-manager <<<';

/**
 * The managed block, line-anchored (`m`) and NON-GREEDY, absorbing the trailing
 * newline only. Non-greedy is what stops two stray marker pairs from swallowing
 * everything between the first BEGIN and the last END. The body additionally
 * refuses to cross a second BEGIN line: an UNPAIRED BEGIN — left behind by a
 * hand-edit, or pasted out of the README — would otherwise pair with the real
 * block's END far below it, and `cam shell uninstall` would delete every line
 * of the user's own rc file in between. With the lookahead, a match can only
 * start at the BEGIN that actually opens a block. No `g` flag on purpose: this
 * object is exported and `.test()` on a global regexp is stateful. Capture
 * group 1 is the trailing newline, so a rewrite can put it back byte-exact.
 */
export const blockRe = new RegExp(
  `^${escapeRe(BEGIN)}(?:(?!^${escapeRe(BEGIN)})[\\s\\S])*?^${escapeRe(END)}[^\\r\\n]*(\\r?\\n)?`,
  'm'
);

/** Version stamp embedded in every generated artefact, e.g. `# cam:0.1.0`. */
const TAG = 'cam:';

/** Reads the version stamp back out of an installed block or managed file. */
const TAG_RE = /(?:^|[^\w:])cam:([0-9][\w.+-]*)/;

/** Target ids whose integration lives in cam.sh. */
const POSIX_IDS = new Set(['bash', 'bash-profile', 'zsh']);

/** Target ids whose integration lives in cam.ps1. */
const PS_IDS = new Set(['powershell', 'pwsh']);

/** detectTargets memo, so install/status/conflicts never re-spawn PowerShell. */
const TARGET_CACHE = new WeakMap();

/**
 * Escape a literal for embedding in a RegExp source.
 * @param {string} s literal text
 * @returns {string} the escaped source fragment
 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Quote a path for a POSIX single-quoted string.
 * @param {string} s the raw path
 * @returns {string} the quoted literal, without surrounding quotes
 */
function shQuote(s) {
  return String(s).replace(/'/g, "'\\''");
}

/**
 * Quote a path for a PowerShell single-quoted string.
 * @param {string} s the raw path
 * @returns {string} the quoted literal, without surrounding quotes
 */
function psQuote(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Windows paths reach git-bash/MSYS shells as `C:/...`; backslashes there are
 * escape characters, not separators.
 * @param {string} p a native path
 * @returns {string} the same path with forward slashes
 */
function toSlash(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Read a text file, or null when it does not exist.
 * @param {string} file absolute path
 * @returns {Promise<string|null>} the contents, or null
 */
async function readTextSafe(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The POSIX permission bits of a file, or null when it cannot be stat'ed.
 * @param {string} file absolute path
 * @returns {Promise<number|null>} mode & 0o777, or null
 */
async function fileMode(file) {
  try {
    const st = await stat(file);
    return st.mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * Does this path exist (file or directory)?
 * @param {string} p absolute path
 * @returns {Promise<boolean>} true when it exists
 */
async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * PATH entries as an array, honouring the Windows `Path` spelling.
 * @param {any} ctx the cam context
 * @returns {string[]} directories on PATH
 */
function pathEntries(ctx) {
  const raw = ctx.env.PATH || ctx.env.Path || ctx.env.path || '';
  const sep = ctx.platform === 'win32' ? ';' : ':';
  return String(raw).split(sep).map((d) => d.replace(/^"|"$/g, '')).filter(Boolean);
}

/**
 * Find an executable on PATH without spawning anything.
 * @param {any} ctx the cam context
 * @param {string} name the command name, without extension
 * @returns {Promise<string|null>} the absolute path, or null
 */
async function whichOnPath(ctx, name) {
  const exts = ctx.platform === 'win32' ? ['.cmd', '.exe', '.bat', '.ps1', ''] : [''];
  for (const dir of pathEntries(ctx)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        const st = await stat(p);
        if (st.isFile()) return p;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/**
 * The absolute `cam` executable baked into the generated integration as the
 * last-resort fallback when PATH does not carry it.
 * @param {any} ctx the cam context
 * @param {{ camBin?: string }} opts caller override
 * @returns {Promise<string|null>} an absolute path, or null when unknown
 */
async function resolveCamBin(ctx, opts = {}) {
  if (opts.camBin) return opts.camBin;
  if (ctx.env.CAM_BIN) return ctx.env.CAM_BIN;
  return whichOnPath(ctx, 'cam');
}

/**
 * Ask one PowerShell edition where its CurrentUserAllHosts profile lives.
 * Never join `Documents` by hand: OneDrive Known Folder Move redirects it, and
 * PS 5.1 (`WindowsPowerShell\`) and PS 7 (`PowerShell\`) use different folders.
 * @param {any} ctx the cam context
 * @param {string} exe the interpreter to ask (`powershell.exe` or `pwsh`)
 * @returns {Promise<string|null>} the profile path, or null when that edition is absent
 */
async function psProfilePath(ctx, exe) {
  try {
    const r = await runCapture(
      ctx,
      exe,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserAllHosts'],
      { timeoutMs: 15000 }
    );
    if (!r || r.code !== 0) return null;
    const line = String(r.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (!line || !/\.ps1$/i.test(line)) return null;
    return line;
  } catch {
    return null;
  }
}

/**
 * The shell the user is running cam from, inferred from the environment only.
 * @param {any} ctx the cam context
 * @returns {string|null} 'powershell' | 'pwsh' | 'bash' | 'zsh' | 'fish' | null
 */
export function currentShell(ctx) {
  const env = ctx.env || {};
  if (env.FISH_VERSION) return 'fish';
  if (env.ZSH_VERSION) return 'zsh';
  if (env.BASH_VERSION) return 'bash';
  const psMod = String(env.PSModulePath || '');
  if (env.POWERSHELL_DISTRIBUTION_CHANNEL || /[\\/]PowerShell[\\/]/.test(psMod)) return 'pwsh';
  if (/WindowsPowerShell/i.test(psMod)) return 'powershell';
  const sh = String(env.SHELL || '');
  if (/fish$/.test(sh)) return 'fish';
  if (/zsh$/.test(sh)) return 'zsh';
  if (/(ba|da|a|k)?sh$/.test(sh)) return 'bash';
  return null;
}

/**
 * Every rc file cam is willing to touch on this machine, in a stable order.
 * cmd.exe is deliberately absent: doskey macros are expanded only by the
 * interactive console line editor, and the only way to persist them (HKCU
 * AutoRun) injects into every cmd.exe on the machine. `cam env` / `cam exec`
 * are the supported cmd.exe path.
 * @param {any} ctx the cam context
 * @returns {Promise<Array<{id:string,shell:string,file:string,kind:'block'|'file',runtime:'sh'|'ps1'|'self',exists:boolean,current:boolean}>>} the targets
 */
export async function detectTargets(ctx) {
  if (TARGET_CACHE.has(ctx)) return TARGET_CACHE.get(ctx);
  const cur = currentShell(ctx);
  const out = [];

  /**
   * Push one candidate when it is worth offering.
   * @param {{id:string,shell:string,file:string,kind:'block'|'file',runtime:'sh'|'ps1'|'self'}} t candidate
   * @param {boolean} wanted whether this shell is present on the machine
   * @returns {Promise<void>} nothing
   */
  const add = async (t, wanted) => {
    const here = await exists(t.file);
    if (!here && !wanted) return;
    out.push({ ...t, exists: here, current: cur === t.id || (t.id === 'bash-profile' && cur === 'bash') });
  };

  if (ctx.platform === 'win32') {
    const p51 = await psProfilePath(ctx, 'powershell.exe');
    if (p51) {
      await add({ id: 'powershell', shell: 'PowerShell', file: p51, kind: 'block', runtime: 'ps1' }, true);
    }
  }
  // On Windows always ask, because PATH is not the only way pwsh is reachable.
  // Elsewhere a PATH miss is conclusive, and skipping saves a pointless spawn.
  const pwshExe = ctx.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
  const pwshWorthAsking = ctx.platform === 'win32' || Boolean(await whichOnPath(ctx, 'pwsh'));
  const p7 = pwshWorthAsking ? await psProfilePath(ctx, pwshExe) : null;
  if (p7) {
    await add({ id: 'pwsh', shell: 'pwsh', file: p7, kind: 'block', runtime: 'ps1' }, true);
  }

  const hasBash = cur === 'bash' || Boolean(await whichOnPath(ctx, 'bash'));
  await add(
    { id: 'bash', shell: 'bash', file: join(ctx.home, '.bashrc'), kind: 'block', runtime: 'sh' },
    hasBash
  );
  if (ctx.platform === 'darwin') {
    // macOS Terminal.app starts bash as a LOGIN shell: it reads .bash_profile
    // and never .bashrc, so a .bashrc-only install silently never loads.
    await add(
      {
        id: 'bash-profile',
        shell: 'bash',
        file: join(ctx.home, '.bash_profile'),
        kind: 'block',
        runtime: 'sh'
      },
      hasBash
    );
  }

  const zdot = ctx.env.ZDOTDIR ? String(ctx.env.ZDOTDIR) : ctx.home;
  const hasZsh = cur === 'zsh' || Boolean(await whichOnPath(ctx, 'zsh'));
  await add({ id: 'zsh', shell: 'zsh', file: join(zdot, '.zshrc'), kind: 'block', runtime: 'sh' }, hasZsh);

  const fishDir = fishConfigDir(ctx);
  const hasFish = cur === 'fish' || Boolean(await whichOnPath(ctx, 'fish')) || (await exists(fishDir));
  await add(
    {
      id: 'fish',
      shell: 'fish',
      file: join(fishDir, 'functions', 'claude.fish'),
      kind: 'file',
      runtime: 'self'
    },
    hasFish
  );

  TARGET_CACHE.set(ctx, out);
  return out;
}

/**
 * `${__fish_config_dir:-${XDG_CONFIG_HOME:-~/.config}/fish}`.
 * @param {any} ctx the cam context
 * @returns {string} the fish configuration directory
 */
function fishConfigDir(ctx) {
  if (ctx.env.__fish_config_dir) return String(ctx.env.__fish_config_dir);
  const xdg = ctx.env.XDG_CONFIG_HOME ? String(ctx.env.XDG_CONFIG_HOME) : join(ctx.home, '.config');
  return join(xdg, 'fish');
}

/**
 * Is this file a native executable rather than a script with a shebang?
 * Used to tell libcamera-tools' `cam` from an npm shim without spawning it.
 * @param {string} file absolute path
 * @returns {Promise<boolean>} true when the first byte is not `#`
 */
async function isNativeBinary(file) {
  let fh = null;
  try {
    fh = await open(file, 'r');
    const buf = Buffer.alloc(2);
    const { bytesRead } = await fh.read(buf, 0, 2, 0);
    if (bytesRead < 2) return true;
    return !(buf[0] === 0x23 && buf[1] === 0x21); // '#!'
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** rc files worth scanning for a pre-existing `claude` alias, per shell id. */
const CONFLICT_SCAN = {
  bash: ['.bashrc', '.bash_profile', '.bash_aliases', '.profile'],
  'bash-profile': ['.bash_profile'],
  zsh: ['.zshrc', '.zprofile', '.zshenv', '.zsh_aliases'],
  fish: []
};

/**
 * Pre-existing definitions that would silently outrank the installed function.
 * An alias beats a function in PowerShell (Alias > Function > Cmdlet >
 * Application) and in bash/zsh alike, so the hook would be dead on arrival.
 * Detection is a static scan of rc files plus a PATH check: asking a shell to
 * `type claude` needs an interactive shell load, which can prompt and hang.
 * @param {any} ctx the cam context
 * @returns {Promise<Array<{shell:string,name:string,kind:'alias'|'function'|'binary',where:string}>>} the conflicts
 */
export async function conflicts(ctx) {
  const found = [];
  const targets = await detectTargets(ctx);
  const seen = new Set();

  /**
   * Scan one file for `claude` definitions that are not ours.
   * @param {string} shell display name
   * @param {string} file absolute path
   * @param {boolean} ps whether to use PowerShell syntax
   * @returns {Promise<void>} nothing
   */
  const scan = async (shell, file, ps) => {
    if (seen.has(file)) return;
    seen.add(file);
    const raw = await readTextSafe(file);
    if (raw === null) return;
    const body = raw.replace(new RegExp(blockRe.source, 'gm'), '');
    const aliasRe = ps
      ? /^[ \t]*(?:Set-Alias|New-Alias)\b[^\r\n]*\bclaude\b/im
      : /^[ \t]*alias[ \t]+claude[ \t]*[= \t]/m;
    const funcRe = ps
      ? /^[ \t]*function[ \t]+claude\b/im
      : /^[ \t]*(?:function[ \t]+claude\b|claude[ \t]*\([ \t]*\)[ \t]*\{)/m;
    if (aliasRe.test(body)) found.push({ shell, name: 'claude', kind: 'alias', where: file });
    else if (funcRe.test(body)) found.push({ shell, name: 'claude', kind: 'function', where: file });
  };

  for (const t of targets) {
    if (t.id === 'fish') {
      const cfg = join(fishConfigDir(ctx), 'config.fish');
      await scan(t.shell, cfg, false);
      const own = await readTextSafe(t.file);
      if (own !== null && !own.includes('claude-account-manager')) {
        found.push({ shell: t.shell, name: 'claude', kind: 'function', where: t.file });
      }
      continue;
    }
    const ps = PS_IDS.has(t.id);
    if (ps) {
      await scan(t.shell, t.file, true);
      await scan(t.shell, join(dirname(t.file), 'Microsoft.PowerShell_profile.ps1'), true);
      continue;
    }
    for (const rc of CONFLICT_SCAN[t.id] || []) {
      await scan(t.shell, join(t.id === 'zsh' && ctx.env.ZDOTDIR ? String(ctx.env.ZDOTDIR) : ctx.home, rc), false);
    }
  }

  // libcamera-tools ships /usr/bin/cam. It is a native ELF/Mach-O binary; every
  // cam launcher is a shebang script, so the first two bytes settle it.
  if (ctx.platform !== 'win32') {
    const onPath = await whichOnPath(ctx, 'cam');
    if (onPath && (await isNativeBinary(onPath))) {
      found.push({ shell: currentShell(ctx) || 'sh', name: 'cam', kind: 'binary', where: onPath });
    }
  }
  return found;
}

/**
 * The POSIX runtime, `<root>/shell/cam.sh`, sourced by the three-line stub.
 * Three verified traps are encoded here: `command -v claude` called from inside
 * a function named `claude` returns the string `claude`, so the lookup runs in a
 * subshell that unsets the function first; `exec` never appears, because `exec`
 * inside a function of an interactive shell replaces the user's shell; and
 * CAM_TTY comes from `[ -t 0 ] && [ -t 2 ]`, because the shell can see the MSYS
 * pty that native Node cannot — that variable is what makes the menu appear in
 * git-bash. A fourth: sh has no scoping, so the function's two variables are
 * declared `local` (guarded, since `local` is not in POSIX) or they would land
 * in the user's interactive shell on every single invocation.
 * @param {any} ctx the cam context
 * @param {{ version: string, camBin?: string|null }} opts version stamp and absolute cam path
 * @returns {string} the file contents, LF only
 */
export function renderPosixRuntime(ctx, { version, camBin = null } = {}) {
  const lines = [
    '#!/bin/sh',
    `# claude-account-manager  ${TAG}${version}  -  POSIX integration (sh, bash, zsh).`,
    '# Managed file: "cam shell install" rewrites it, "cam shell uninstall" removes it.',
    '# Sourced from your rc file by a three-line marker block. Edits here are lost.',
    '',
    'claude() {',
    '  # An unqualified assignment inside a function is GLOBAL in sh, so without',
    '  # this line every `claude` call would overwrite the caller\'s own $cam_bin',
    '  # and $real. bash, zsh, dash and ash all provide `local`; a shell without',
    '  # it fails this line silently and simply keeps the old global behaviour.',
    '  local cam_bin real 2>/dev/null || :',
    '  cam_bin=${CAM_BIN:-}',
    '  [ -z "$cam_bin" ] && cam_bin=$( (unset -f cam 2>/dev/null; command -v cam 2>/dev/null) )'
  ];
  if (camBin) {
    lines.push(`  [ -z "$cam_bin" ] && [ -x '${shQuote(toSlash(camBin))}' ] && cam_bin='${shQuote(toSlash(camBin))}'`);
  }
  lines.push(
    '  if [ -n "$cam_bin" ] && [ -x "$cam_bin" ]; then',
    '    if [ -t 0 ] && [ -t 2 ]; then',
    '      CAM_TTY=1 command "$cam_bin" launch -- "$@"',
    '    else',
    '      CAM_TTY=0 command "$cam_bin" launch -- "$@"',
    '    fi',
    '    return $?',
    '  fi',
    '  real=$( (unset -f claude 2>/dev/null; command -v claude 2>/dev/null) )',
    "  [ -z \"$real\" ] && { printf '%s\\n' \"claude-account-manager: neither 'cam' nor 'claude' found on PATH\" >&2; return 127; }",
    "  printf '%s\\n' \"claude-account-manager: 'cam' not found; running claude directly.\" >&2",
    '  command "$real" "$@"',
    '}',
    ''
  );
  return lines.join('\n');
}

/**
 * The three-line marker block that goes into a POSIX rc file. Every future
 * upgrade rewrites cam.sh and never touches the rc file again.
 * @param {any} ctx the cam context
 * @param {{ version: string, runtimePath: string }} opts version stamp and absolute cam.sh path
 * @returns {string} the block, LF-joined and without a trailing newline
 */
export function renderPosixStub(ctx, { version, runtimePath } = {}) {
  const p = shQuote(toSlash(runtimePath));
  return [
    BEGIN,
    `[ -r '${p}' ] && . '${p}'  # ${TAG}${version}`,
    END
  ].join('\n');
}

/**
 * The three-line marker block that goes into a PowerShell profile.
 * @param {string} version version stamp
 * @param {string} runtimePath absolute cam.ps1 path
 * @returns {string} the block, LF-joined and without a trailing newline
 */
function renderPowerShellStub(version, runtimePath) {
  const p = psQuote(runtimePath);
  return [
    BEGIN,
    `if (Test-Path -LiteralPath '${p}') { . '${p}' }  # ${TAG}${version}`,
    END
  ].join('\n');
}

/**
 * The PowerShell runtime, `<root>/shell/cam.ps1`, dot-sourced by the stub.
 * Constraining Get-Command to CommandType Application is what bypasses the
 * function itself and prevents infinite recursion. The exit code is captured
 * inside the `try` and re-published as `$global:LASTEXITCODE` after the CAM_TTY
 * restore, because a bare `$LASTEXITCODE = …` inside a function would only
 * create a function-local variable the caller never sees.
 * `$PSNativeCommandArgumentPassing` is set INSIDE the function: the stub
 * dot-sources this file, so a file-scope assignment would land in the user's
 * global session and change argument quoting for every native command they run.
 * @param {any} ctx the cam context
 * @param {{ version: string, camBin?: string|null }} opts version stamp and absolute cam path
 * @returns {string} the file contents, LF only (the writer applies the EOL)
 */
export function renderPowerShell(ctx, { version, camBin = null } = {}) {
  const abs = camBin ? psQuote(camBin) : '';
  return [
    `# claude-account-manager  ${TAG}${version}  -  PowerShell integration (5.1 and 7+).`,
    '# Managed file: "cam shell install" rewrites it, "cam shell uninstall" removes it.',
    '# Dot-sourced from your profile by a three-line marker block. Edits here are lost.',
    '',
    'function claude {',
    '  # Function-scoped on purpose. This file is dot-sourced, so setting it at',
    '  # file scope would change argument passing for every native command in the',
    "  # user's session, not just cam's own call.",
    "  if ($PSVersionTable.PSVersion.Major -ge 7) { $PSNativeCommandArgumentPassing = 'Standard' }",
    '  $cam = $env:CAM_BIN',
    "  if (-not $cam) { $cam = (Get-Command cam -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }",
    `  if (-not $cam) { $cam = '${abs}' }`,
    '  if (-not $cam -or -not (Test-Path -LiteralPath $cam)) {',
    "    $real = $ExecutionContext.InvokeCommand.GetCommand('claude','Application')",
    '    if (-not $real) { Write-Error "claude-account-manager: neither \'cam\' nor \'claude\' found on PATH."; return }',
    '    Write-Warning "claude-account-manager: \'cam\' not found; running claude directly."',
    '    & $real.Source @args; return',
    '  }',
    '  $prev = $env:CAM_TTY',
    '  $code = 0',
    '  try {',
    "    $env:CAM_TTY = if (-not [Console]::IsInputRedirected -and -not [Console]::IsErrorRedirected) { '1' } else { '0' }",
    '    & $cam launch -- @args',
    '    if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }',
    '  } finally { if ($null -eq $prev) { Remove-Item Env:CAM_TTY -ErrorAction SilentlyContinue } else { $env:CAM_TTY = $prev } }',
    '  # $LASTEXITCODE is the failure signal to test after this function. $? is not:',
    '  # Windows PowerShell 5.1 resets it to True at every function boundary, even',
    "  # for a failing cmdlet, so no wrapper written as a function can carry it out.",
    '  $global:LASTEXITCODE = $code',
    '}',
    ''
  ].join('\n');
}

/**
 * The whole fish function file, `<fish config>/functions/claude.fish`. There is
 * no marker block: the file belongs to cam, and uninstall deletes it after
 * confirming the signature. fish's `command -v` reports the function, so the
 * lookup uses `command --search`; `$argv` is a real array, so there is none of
 * PowerShell's quoting trouble.
 * @param {any} ctx the cam context
 * @param {{ version: string, camBin?: string|null }} opts version stamp and absolute cam path
 * @returns {string} the file contents, LF only
 */
export function renderFish(ctx, { version, camBin = null } = {}) {
  const lines = [
    `# claude-account-manager  ${TAG}${version}  -  fish integration.`,
    '# Managed file: this whole file belongs to cam. "cam shell uninstall" deletes it.',
    '',
    "function claude --description 'run claude through claude-account-manager'",
    '    set -l cam_bin $CAM_BIN',
    '    if test -z "$cam_bin"',
    '        set cam_bin (command --search cam 2>/dev/null)',
    '    end'
  ];
  if (camBin) {
    const abs = shQuote(toSlash(camBin));
    lines.push(
      `    if test -z "$cam_bin"; and test -x '${abs}'`,
      `        set cam_bin '${abs}'`,
      '    end'
    );
  }
  lines.push(
    '    if test -n "$cam_bin"; and test -x "$cam_bin"',
    '        if isatty stdin; and isatty stderr',
    '            set -lx CAM_TTY 1',
    '            command $cam_bin launch -- $argv',
    '            return $status',
    '        else',
    '            set -lx CAM_TTY 0',
    '            command $cam_bin launch -- $argv',
    '            return $status',
    '        end',
    '    end',
    '    set -l real (command --search claude 2>/dev/null)',
    '    if test -z "$real"',
    '        printf \'%s\\n\' "claude-account-manager: neither \'cam\' nor \'claude\' found on PATH" >&2',
    '        return 127',
    '    end',
    '    printf \'%s\\n\' "claude-account-manager: \'cam\' not found; running claude directly." >&2',
    '    command $real $argv',
    'end',
    ''
  );
  return lines.join('\n');
}

/**
 * Write one wholly cam-owned file, skipping the write when it is already
 * byte-identical, and backing up any pre-existing content first.
 * @param {any} ctx the cam context
 * @param {string} file absolute destination
 * @param {string} body LF-joined contents
 * @param {{ eol?: string, mode?: number, dirMode?: number, dryRun?: boolean, backup?: boolean }} [opts] options
 * @returns {Promise<{action:string,file:string,text:string,backup:string|null}>} what happened
 */
async function putManaged(ctx, file, body, opts = {}) {
  const eol = opts.eol || '\n';
  const mode = opts.mode === undefined ? 0o600 : opts.mode;
  const dirMode = opts.dirMode === undefined ? 0o700 : opts.dirMode;
  const text = body.replace(/\r?\n/g, eol);
  const cur = await readTextSafe(file);
  if (cur === text) return { action: 'unchanged', file, text, backup: null };
  const action = cur === null ? 'created' : 'upgraded';
  if (opts.dryRun) return { action, file, text, backup: null };
  await ensureDir(ctx, dirname(file), dirMode);
  const backup = cur !== null && opts.backup ? await backupNow(ctx, file, await fileMode(file)) : null;
  await writeFileAtomic(ctx, file, text, { mode });
  return { action, file, text, backup };
}

/**
 * Write both external runtime files. Every upgrade after the first install
 * rewrites only these — a user's rc file is never touched again.
 * @param {any} ctx the cam context
 * @param {{ version?: string, camBin?: string|null }} opts version stamp and absolute cam path
 * @returns {Promise<string[]>} the absolute paths written or already current
 */
export async function writeRuntime(ctx, { version, camBin } = {}) {
  const v = version || ctx.version;
  const bin = camBin === undefined ? await resolveCamBin(ctx) : camBin;
  const { shellDir } = storePaths(ctx);
  const shPath = join(shellDir, 'cam.sh');
  const psPath = join(shellDir, 'cam.ps1');
  const psEol = ctx.platform === 'win32' ? '\r\n' : '\n';
  await putManaged(ctx, shPath, renderPosixRuntime(ctx, { version: v, camBin: bin }), { eol: '\n' });
  await putManaged(ctx, psPath, renderPowerShell(ctx, { version: v, camBin: bin }), { eol: psEol });
  return [shPath, psPath];
}

/**
 * The EOL a brand-new file should be created with.
 * @param {any} ctx the cam context
 * @param {string} file absolute path
 * @returns {string} '\r\n' or '\n'
 */
function defaultEol(ctx, file) {
  return ctx.platform === 'win32' && /\.ps1$/i.test(file) ? '\r\n' : '\n';
}

/**
 * Copy a file to `<file>.cam-backup-<ISO>` before it is modified. rc files are
 * edited repeatedly and hold the user's own content, so unlike cam's own store
 * they get a fresh, timestamped backup every single time.
 * @param {any} ctx the cam context
 * @param {string} file absolute path
 * @param {number|null} mode permission bits to give the copy
 * @returns {Promise<string|null>} the backup path, or null when nothing was copied
 */
async function backupNow(ctx, file, mode) {
  const stamp = new Date(ctx.now()).toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.cam-backup-${stamp}`;
  const done = await copyFileIfExists(ctx, file, dest, mode === null ? 0o600 : mode);
  return done ? dest : null;
}

/**
 * Compute the result of installing or removing the block, writing nothing.
 * @param {any} ctx the cam context
 * @param {string} file absolute rc file
 * @param {string|null} block the block to install, or null to remove it
 * @returns {Promise<{action:string,cur:string|null,next:string|null,eol:string,mode:number|null}>} the plan
 */
async function planPatch(ctx, file, block) {
  const cur = await readTextSafe(file);
  const removing = block === null || block === undefined || block === '';
  const mode = await fileMode(file);

  if (cur === null) {
    if (removing) return { action: 'absent', cur, next: null, eol: defaultEol(ctx, file), mode };
    const eol = defaultEol(ctx, file);
    return { action: 'created', cur, next: block.replace(/\r?\n/g, eol) + eol, eol, mode };
  }

  const eol = /\r\n/.test(cur) ? '\r\n' : '\n';
  const g = new RegExp(blockRe.source, 'gm');
  const installed = blockRe.test(cur);

  if (removing) {
    if (!installed) return { action: 'not-installed', cur, next: null, eol, mode };
    return { action: 'removed', cur, next: cur.replace(g, ''), eol, mode };
  }

  const rendered = block.replace(/\r?\n/g, eol);
  if (installed) {
    let first = true;
    const next = cur.replace(g, (m, trail) => {
      if (!first) return '';
      first = false;
      return rendered + (trail || '');
    });
    return { action: next === cur ? 'unchanged' : 'upgraded', cur, next, eol, mode };
  }
  const sep = cur.length === 0 || /\r?\n$/.test(cur) ? '' : eol;
  return { action: 'appended', cur, next: cur + sep + rendered + eol, eol, mode };
}

/**
 * Install, upgrade or remove the managed block in one rc file. The file's own
 * EOL convention and surrounding content survive byte-for-byte; a byte-identical
 * re-install writes nothing at all.
 * @param {any} ctx the cam context
 * @param {string} file absolute rc file
 * @param {string|null} block the block to install, or null to remove it
 * @returns {Promise<{action:'created'|'appended'|'upgraded'|'unchanged'|'removed'|'not-installed'|'absent',file:string,backup?:string|null}>} what happened
 */
export async function patchFile(ctx, file, block) {
  const plan = await planPatch(ctx, file, block);
  if (plan.action === 'unchanged' || plan.action === 'not-installed' || plan.action === 'absent') {
    return { action: plan.action, file };
  }
  if (plan.action === 'created') {
    await ensureDir(ctx, dirname(file), 0o755);
    await writeFileAtomic(ctx, file, plan.next, { mode: 0o644 });
    return { action: 'created', file, backup: null };
  }
  const backup = await backupNow(ctx, file, plan.mode);
  await writeFileAtomic(ctx, file, plan.next, { mode: plan.mode === null ? 0o644 : plan.mode });
  return { action: plan.action, file, backup };
}

/**
 * Turn shell ids into real targets, so callers may pass either.
 * @param {any} ctx the cam context
 * @param {Array<string|object>} targets ids or Target objects
 * @returns {Promise<object[]>} resolved targets
 */
async function coerceTargets(ctx, targets) {
  const list = Array.isArray(targets) ? targets : [];
  if (!list.some((t) => typeof t === 'string')) return list;
  const known = await detectTargets(ctx);
  return list.map((t) => {
    if (typeof t !== 'string') return t;
    const hit = known.filter((k) => k.id === t || k.shell === t);
    if (!hit.length) {
      fail('USAGE', ctx.t('shell.unknownShell', { shell: t }), { hint: ctx.t('shell.usage') });
    }
    return hit[0];
  });
}

/**
 * The block (or whole-file body) one target should receive.
 * @param {any} ctx the cam context
 * @param {object} target a detected target
 * @param {{version:string,camBin:string|null,shPath:string,psPath:string}} p rendering inputs
 * @returns {string} the text to install
 */
function bodyFor(ctx, target, p) {
  if (target.id === 'fish') return renderFish(ctx, { version: p.version, camBin: p.camBin });
  if (PS_IDS.has(target.id)) return renderPowerShellStub(p.version, p.psPath);
  return renderPosixStub(ctx, { version: p.version, runtimePath: p.shPath });
}

/**
 * Install the `claude` hook into every given target, writing the external
 * runtime files first. With `dryRun` nothing is written and every result
 * carries the exact resulting text in `preview`. A whole-file target (fish) the
 * user wrote themselves is never overwritten unless `force` is passed: it is
 * reported as `action:'conflict', foreign:true` and left exactly as it is.
 * @param {any} ctx the cam context
 * @param {Array<string|object>} targets ids or Target objects from detectTargets
 * @param {{ version?: string, camBin?: string|null, dryRun?: boolean, force?: boolean }} [opts] options
 * @returns {Promise<Array<{id:string,shell:string,file:string,kind:string,action:string,backup?:string|null,preview?:string,dryRun:boolean,foreign?:boolean}>>} one result per runtime file and target
 */
export async function install(ctx, targets, opts = {}) {
  const version = opts.version || ctx.version;
  const camBin = opts.camBin === undefined ? await resolveCamBin(ctx) : opts.camBin;
  const dryRun = Boolean(opts.dryRun);
  const force = Boolean(opts.force);
  const list = await coerceTargets(ctx, targets);
  const { shellDir } = storePaths(ctx);
  const shPath = join(shellDir, 'cam.sh');
  const psPath = join(shellDir, 'cam.ps1');
  const results = [];

  const needSh = list.some((t) => POSIX_IDS.has(t.id));
  const needPs = list.some((t) => PS_IDS.has(t.id));
  if (needSh) {
    const r = await putManaged(ctx, shPath, renderPosixRuntime(ctx, { version, camBin }), { eol: '\n', dryRun });
    results.push({
      id: 'runtime-sh', shell: 'cam', file: r.file, kind: 'runtime',
      action: r.action, dryRun, preview: dryRun ? r.text : undefined
    });
  }
  if (needPs) {
    const eol = ctx.platform === 'win32' ? '\r\n' : '\n';
    const r = await putManaged(ctx, psPath, renderPowerShell(ctx, { version, camBin }), { eol, dryRun });
    results.push({
      id: 'runtime-ps1', shell: 'cam', file: r.file, kind: 'runtime',
      action: r.action, dryRun, preview: dryRun ? r.text : undefined
    });
  }

  for (const t of list) {
    const body = bodyFor(ctx, t, { version, camBin, shPath, psPath });
    if (t.kind === 'file') {
      const cur = await readTextSafe(t.file);
      const foreign = cur !== null && !cur.includes('claude-account-manager');
      const eol = cur !== null && /\r\n/.test(cur) ? '\r\n' : '\n';
      if (foreign && !force) {
        // The user wrote this claude.fish themselves. Overwriting it would also
        // stamp cam's signature into it, which defeats uninstall's "never delete
        // a file cam did not write" guard below and would delete their wrapper
        // outright. So nothing is written, and the result says so: 'conflict'
        // plus foreign:true. conflicts() has already reported the file as a
        // competing `claude` definition, which is how the caller explains it.
        results.push({
          id: t.id, shell: t.shell, file: t.file, kind: t.kind,
          action: 'conflict', backup: null, dryRun, foreign
        });
        continue;
      }
      if (dryRun) {
        const text = body.replace(/\r?\n/g, eol);
        results.push({
          id: t.id, shell: t.shell, file: t.file, kind: t.kind,
          action: cur === null ? 'created' : cur === text ? 'unchanged' : 'upgraded',
          dryRun, preview: text, foreign
        });
        continue;
      }
      const r = await putManaged(ctx, t.file, body, { eol, mode: 0o644, dirMode: 0o755, backup: true });
      results.push({
        id: t.id, shell: t.shell, file: t.file, kind: t.kind,
        action: r.action, backup: r.backup, dryRun, foreign
      });
      continue;
    }
    if (dryRun) {
      const plan = await planPatch(ctx, t.file, body);
      results.push({
        id: t.id, shell: t.shell, file: t.file, kind: t.kind,
        action: plan.action, dryRun, preview: plan.next === null ? plan.cur || '' : plan.next
      });
      continue;
    }
    const r = await patchFile(ctx, t.file, body);
    results.push({ id: t.id, shell: t.shell, file: t.file, kind: t.kind, action: r.action, backup: r.backup ?? null, dryRun });
  }
  return results;
}

/**
 * Remove the hook from every given target, restoring the surrounding content and
 * the original EOL convention. The external runtime files go too, but only once
 * no target still references them.
 * @param {any} ctx the cam context
 * @param {Array<string|object>} targets ids or Target objects from detectTargets
 * @returns {Promise<Array<{id:string,shell:string,file:string,kind:string,action:string,backup?:string|null}>>} one result per target and removed runtime file
 */
export async function uninstall(ctx, targets) {
  const list = await coerceTargets(ctx, targets);
  const results = [];

  for (const t of list) {
    if (t.kind === 'file') {
      const cur = await readTextSafe(t.file);
      if (cur === null) {
        results.push({ id: t.id, shell: t.shell, file: t.file, kind: t.kind, action: 'absent' });
        continue;
      }
      if (!cur.includes('claude-account-manager')) {
        // Someone else's claude.fish. Never delete a file cam did not write.
        results.push({ id: t.id, shell: t.shell, file: t.file, kind: t.kind, action: 'not-installed' });
        continue;
      }
      const backup = await backupNow(ctx, t.file, await fileMode(t.file));
      await rm(t.file, { force: true });
      results.push({ id: t.id, shell: t.shell, file: t.file, kind: t.kind, action: 'removed', backup });
      continue;
    }
    const r = await patchFile(ctx, t.file, null);
    results.push({ id: t.id, shell: t.shell, file: t.file, kind: t.kind, action: r.action, backup: r.backup ?? null });
  }

  const left = await status(ctx);
  const stillInstalled = left.filter((s) => s.installed);
  const keepSh = stillInstalled.some((s) => s.runtime === 'sh');
  const keepPs = stillInstalled.some((s) => s.runtime === 'ps1');
  const { shellDir } = storePaths(ctx);
  const runtimes = [
    { id: 'runtime-sh', file: join(shellDir, 'cam.sh'), keep: keepSh },
    { id: 'runtime-ps1', file: join(shellDir, 'cam.ps1'), keep: keepPs }
  ];
  for (const rt of runtimes) {
    if (rt.keep) continue;
    if (!(await exists(rt.file))) continue;
    await rm(rt.file, { force: true });
    results.push({ id: rt.id, shell: 'cam', file: rt.file, kind: 'runtime', action: 'removed' });
  }
  return results;
}

/**
 * What is installed where, right now, for every detectable shell.
 * @param {any} ctx the cam context
 * @returns {Promise<Array<{id:string,shell:string,file:string,kind:string,runtime:string,exists:boolean,current:boolean,installed:boolean,version:string|null,runtimePath:string,runtimeOk:boolean}>>} one row per target
 */
export async function status(ctx) {
  const targets = await detectTargets(ctx);
  const { shellDir } = storePaths(ctx);
  const shPath = join(shellDir, 'cam.sh');
  const psPath = join(shellDir, 'cam.ps1');
  const shOk = await exists(shPath);
  const psOk = await exists(psPath);
  const rows = [];
  for (const t of targets) {
    const cur = await readTextSafe(t.file);
    let installed = false;
    let version = null;
    if (cur !== null) {
      if (t.kind === 'file') installed = cur.includes('claude-account-manager');
      else installed = blockRe.test(cur);
      if (installed) {
        const m = TAG_RE.exec(cur);
        version = m ? m[1] : null;
      }
    }
    const runtimePath = t.runtime === 'ps1' ? psPath : t.runtime === 'sh' ? shPath : t.file;
    const runtimeOk = t.runtime === 'ps1' ? psOk : t.runtime === 'sh' ? shOk : installed;
    rows.push({
      id: t.id,
      shell: t.shell,
      file: t.file,
      kind: t.kind,
      runtime: t.runtime,
      exists: cur !== null,
      current: t.current,
      installed,
      version,
      runtimePath,
      runtimeOk
    });
  }
  return rows;
}
