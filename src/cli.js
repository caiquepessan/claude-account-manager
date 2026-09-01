// src/cli.js — argv splitting, the frozen command registry, dispatch, and the
// rendering of every error into one of cam's stable exit codes.
// Owns the guaranteed cursor restore; the only src/ file that may use process.on.

import { parseArgs } from 'node:util';
import { createCtx, EXIT, isCamError } from './ctx.js';
import { createT, detectLocale } from './i18n.js';
import { detectCaps } from './tty.js';
import { errorBlock } from './ui.js';
import { restoreCursorSync } from './screen.js';

/**
 * Sentinel returned as `camName` by `--cam` with no value: force the picker
 * even when arguments are present. A leading space cannot be a profile name.
 */
const ASK = ' ask';

/** Fallback translator for callers of helpText() that pass no ctx. */
const DEFAULT_T = createT('en');

/** parseArgs option table: the superset of every flag any command accepts. */
const OPTIONS = {
  all: { type: 'boolean' },
  ascii: { type: 'boolean' },
  ask: { type: 'string' },
  console: { type: 'boolean' },
  deep: { type: 'boolean' },
  'dry-run': { type: 'boolean', short: 'n' },
  email: { type: 'string' },
  empty: { type: 'boolean' },
  fix: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  keep: { type: 'boolean' },
  'keep-env': { type: 'boolean' },
  lang: { type: 'string' },
  'no-color': { type: 'boolean' },
  'no-seed': { type: 'boolean' },
  'no-share': { type: 'boolean' },
  purge: { type: 'boolean' },
  seed: { type: 'boolean' },
  share: { type: 'boolean' },
  'share-projects': { type: 'boolean' },
  shell: { type: 'string' },
  sso: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  version: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
};

/** Tokens that belong to cam itself when no verb was given. */
const GLOBAL_FLAGS = new Set([
  '--all', '--ascii', '--ask', '--help', '-h', '--json', '--keep-env', '--lang',
  '--no-color', '--verbose', '-v', '--version', '--yes', '-y',
]);

/** Global flags that consume the following token as their value. */
const GLOBAL_VALUE_FLAGS = new Set(['--ask', '--lang']);

/**
 * The command registry. Both the router and helpText() read this table, so the
 * help can never describe a command the router does not have.
 * `summary` is an i18n key, never a sentence: COMMANDS is built before a locale
 * is known. `run` imports its module lazily so the hot path (`launch`) never
 * pays for the modules it does not use.
 */
export const COMMANDS = Object.freeze({
  add: Object.freeze({
    name: 'add',
    aliases: Object.freeze([]),
    summary: 'help.cmd.add',
    usage: 'cam add [name] [--console|--sso|--email <addr>] [--no-share] [--keep]',
    advanced: false,
    run: async (ctx, args) => (await import('./commands/account.js')).cmdAdd(ctx, args),
  }),
  ls: Object.freeze({
    name: 'ls',
    aliases: Object.freeze(['list']),
    summary: 'help.cmd.ls',
    usage: 'cam ls [--json]',
    advanced: false,
    run: async (ctx, args) => (await import('./commands/account.js')).cmdList(ctx, args),
  }),
  use: Object.freeze({
    name: 'use',
    aliases: Object.freeze([]),
    summary: 'help.cmd.use',
    usage: 'cam use [name]',
    advanced: false,
    run: async (ctx, args) => (await import('./commands/launch.js')).cmdUse(ctx, args),
  }),
  rm: Object.freeze({
    name: 'rm',
    aliases: Object.freeze([]),
    summary: 'help.cmd.rm',
    usage: 'cam rm <name> [--yes] [--purge]',
    advanced: false,
    run: async (ctx, args) => (await import('./commands/account.js')).cmdRemove(ctx, args),
  }),
  shell: Object.freeze({
    name: 'shell',
    aliases: Object.freeze([]),
    summary: 'help.cmd.shell',
    usage: 'cam shell install|uninstall|status [--dry-run] [--shell <id>]',
    advanced: false,
    // commands/doctor.js reads a raw token list, not the split object.
    run: async (ctx, args) => (await import('./commands/doctor.js')).cmdShell(ctx, args.camArgs),
  }),
  doctor: Object.freeze({
    name: 'doctor',
    aliases: Object.freeze([]),
    summary: 'help.cmd.doctor',
    usage: 'cam doctor [--deep] [--fix] [--json]',
    advanced: false,
    // commands/doctor.js reads a raw token list, not the split object.
    run: async (ctx, args) => (await import('./commands/doctor.js')).cmdDoctor(ctx, args.camArgs),
  }),
  help: Object.freeze({
    name: 'help',
    aliases: Object.freeze([]),
    summary: 'help.cmd.help',
    usage: 'cam help [command] [--all]',
    advanced: false,
    run: async (ctx, args) => cmdHelp(ctx, args),
  }),
  launch: Object.freeze({
    name: 'launch',
    aliases: Object.freeze([]),
    summary: 'help.cmd.launch',
    usage: 'cam launch [-- <args...>]',
    advanced: true,
    run: async (ctx, args) => (await import('./commands/launch.js')).run(ctx, args),
  }),
  which: Object.freeze({
    name: 'which',
    aliases: Object.freeze([]),
    summary: 'help.cmd.which',
    usage: 'cam which [-v] [--json]',
    advanced: true,
    run: async (ctx, args) => (await import('./commands/launch.js')).cmdWhich(ctx, args),
  }),
  env: Object.freeze({
    name: 'env',
    aliases: Object.freeze([]),
    summary: 'help.cmd.env',
    usage: 'cam env <name> [--shell posix|powershell|fish|cmd]',
    advanced: true,
    run: async (ctx, args) => (await import('./commands/launch.js')).cmdEnv(ctx, args),
  }),
  exec: Object.freeze({
    name: 'exec',
    aliases: Object.freeze([]),
    summary: 'help.cmd.exec',
    usage: 'cam exec <name> -- <cmd...>',
    advanced: true,
    run: async (ctx, args) => (await import('./commands/launch.js')).cmdExec(ctx, args),
  }),
  restore: Object.freeze({
    name: 'restore',
    aliases: Object.freeze([]),
    summary: 'help.cmd.restore',
    usage: 'cam restore <name>',
    advanced: true,
    run: async (ctx, args) => (await import('./commands/account.js')).cmdRestore(ctx, args),
  }),
  trash: Object.freeze({
    name: 'trash',
    aliases: Object.freeze([]),
    summary: 'help.cmd.trash',
    usage: 'cam trash [--empty] [--yes]',
    advanced: true,
    run: async (ctx, args) => (await import('./commands/account.js')).cmdTrash(ctx, args),
  }),
  config: Object.freeze({
    name: 'config',
    aliases: Object.freeze([]),
    summary: 'help.cmd.config',
    usage: 'cam config [key] [value]',
    advanced: true,
    run: async (ctx, args) => (await import('./commands/account.js')).cmdConfig(ctx, args),
  }),
});

/** Order the everyday help block is printed in — seven lines, on purpose. */
const EVERYDAY_ORDER = ['add', 'ls', 'use', 'rm', 'shell', 'doctor', 'help'];

/** Order the `--all` block is printed in. */
const ADVANCED_ORDER = ['launch', 'which', 'env', 'exec', 'restore', 'trash', 'config'];

/** Option rows for the help screen: [flags, i18n key]. */
const OPTION_ROWS = Object.freeze([
  Object.freeze(['--cam <name>', 'help.opt.cam']),
  Object.freeze(['--keep-env', 'help.opt.keepEnv']),
  Object.freeze(['--json', 'help.opt.json']),
  Object.freeze(['-y, --yes', 'help.opt.yes']),
  Object.freeze(['-v, --verbose', 'help.opt.verbose']),
  Object.freeze(['--ascii', 'help.opt.ascii']),
  Object.freeze(['--lang <id>', 'help.opt.lang']),
  Object.freeze(['-h, --help', 'help.opt.help']),
  Object.freeze(['--version', 'help.opt.version']),
]);

/** Example command lines. Syntax only: nothing here needs translating. */
const EXAMPLE_ROWS = Object.freeze([
  'claude',
  'claude --cam work "fix the bug"',
  'cam add',
  'cam use work',
  'cam ls',
  'cam doctor',
]);

let cursorGuardInstalled = false;

/**
 * Register the synchronous cursor restore exactly once per process. A crash,
 * a throw or a plain return must never leave a hidden cursor behind.
 * @returns {void}
 */
function installCursorGuard() {
  if (cursorGuardInstalled) return;
  cursorGuardInstalled = true;
  try {
    process.on('exit', restoreCursorSync);
  } catch {
    // A host without process.on still runs; it just loses the safety net.
  }
}

/**
 * Look a verb or alias up in the registry.
 * @param {string} token candidate command word
 * @returns {object|null} the registry entry, or null when the word is not a verb
 */
function findCommand(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  if (Object.prototype.hasOwnProperty.call(COMMANDS, token)) return COMMANDS[token];
  for (const key of Object.keys(COMMANDS)) {
    if (COMMANDS[key].aliases.includes(token)) return COMMANDS[key];
  }
  return null;
}

/**
 * Is this token one of cam's own flags rather than something for claude?
 * @param {string} token a raw argument
 * @returns {boolean} true when cam should keep it
 */
function isGlobalFlag(token) {
  if (GLOBAL_FLAGS.has(token)) return true;
  for (const name of GLOBAL_VALUE_FLAGS) if (token.startsWith(`${name}=`)) return true;
  return false;
}

/**
 * Pull every `--cam <name>` / `--cam=<name>` out of an argument list.
 * @param {string[]} list arguments to scan
 * @returns {{rest:string[], camName:(string|undefined)}} the list without the flag, and the name
 */
function extractCam(list) {
  const rest = [];
  let camName;
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--cam') {
      const next = list[i + 1];
      if (typeof next === 'string' && !next.startsWith('-')) {
        camName = next;
        i += 1;
      } else {
        camName = ASK;
      }
      continue;
    }
    if (typeof a === 'string' && a.startsWith('--cam=')) {
      const value = a.slice('--cam='.length);
      camName = value === '' ? ASK : value;
      continue;
    }
    rest.push(a);
  }
  return { rest, camName };
}

/**
 * Parse cam's own arguments into a flat, camel-cased flag bag.
 * @param {string[]} own cam's own arguments, with `--cam` already removed
 * @returns {object} flags, including `positionals` and the raw parseArgs `values`
 */
function parseFlags(own) {
  let values = {};
  let positionals = [];
  try {
    const parsed = parseArgs({ args: own, options: OPTIONS, allowPositionals: true, strict: false });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch {
    // Non-strict parseArgs is very hard to upset, but a malformed argv must
    // still reach a command rather than crash the router.
    for (const a of own) if (typeof a === 'string' && !a.startsWith('-')) positionals.push(a);
  }
  const bool = (v) => v === true;
  const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
  // `seed` and `share` stay tri-state on purpose: commands/account.js opts out
  // with `flags.seed !== false`, so a defaulted `false` here would silently
  // disable seeding and sharing for every profile ever created.
  const tri = (v) => (v === true ? true : (v === false ? false : undefined));
  return {
    all: bool(values.all),
    ascii: bool(values.ascii),
    ask: str(values.ask),
    console: bool(values.console),
    deep: bool(values.deep),
    dryRun: bool(values['dry-run']),
    email: str(values.email),
    empty: bool(values.empty),
    fix: bool(values.fix),
    help: bool(values.help),
    json: bool(values.json),
    keep: bool(values.keep),
    keepEnv: bool(values['keep-env']),
    lang: str(values.lang),
    noColor: bool(values['no-color']),
    noSeed: bool(values['no-seed']),
    noShare: bool(values['no-share']),
    purge: bool(values.purge),
    seed: tri(values.seed),
    share: tri(values.share),
    shareProjects: bool(values['share-projects']),
    shell: str(values.shell),
    sso: bool(values.sso),
    verbose: bool(values.verbose),
    version: bool(values.version),
    yes: bool(values.yes),
    positionals,
    values,
  };
}

/**
 * Separate cam's own arguments from the ones forwarded verbatim to claude.
 * Everything after the first bare `--` is forwarded; `--cam <name>` is lifted
 * out of either half so claude never sees it. With no verb, a leading bare word
 * is the `cam <name>` shorthand and everything after it is forwarded, so
 * `cam -p hi` and `cam work -c` both reach Claude Code unchanged.
 * @param {string[]} argv arguments after the node binary and the script path
 * @returns {{cmd:string, camArgs:string[], forwarded:string[], camName:(string|undefined), flags:object}} the split
 */
export function splitArgs(argv) {
  const list = Array.isArray(argv) ? argv.filter((a) => typeof a === 'string') : [];
  const cut = list.indexOf('--');
  const head = cut === -1 ? list.slice() : list.slice(0, cut);
  const tail = cut === -1 ? [] : list.slice(cut + 1);

  const first = head[0];
  let cmd = null;
  let ownRaw = head;
  if (typeof first === 'string' && !first.startsWith('-')) {
    const entry = findCommand(first);
    if (entry) {
      cmd = entry.name;
      ownRaw = head.slice(1);
    }
  }

  const fromHead = extractCam(ownRaw);
  const fromTail = extractCam(tail);
  let camName = fromHead.camName !== undefined ? fromHead.camName : fromTail.camName;
  let own = fromHead.rest;
  let forwarded = fromTail.rest;

  // `cam launch` is the same entry point spelled out, and README documents it as
  // the hook-free one, so its leftovers must reach claude exactly as a bare
  // `cam`'s do. Left in camArgs they reach nothing at all: run() forwards only
  // `forwarded`, so `cam launch --cam work "fix the bug"` opened an empty session.
  if (cmd === null || cmd === 'launch') {
    const named = cmd === 'launch';
    // No verb up front: consume cam's own leading flags first, so `cam -v doctor`
    // still reaches doctor and only then falls back to the account shorthand.
    const consumed = [];
    let i = 0;
    while (i < own.length) {
      const a = own[i];
      if (isGlobalFlag(a)) {
        consumed.push(a);
        if (GLOBAL_VALUE_FLAGS.has(a) && typeof own[i + 1] === 'string' && !own[i + 1].startsWith('-')) {
          consumed.push(own[i + 1]);
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      break;
    }
    const next = own[i];
    const bare = typeof next === 'string' && !next.startsWith('-');
    // A verb the user already typed cannot be re-read out of its own arguments.
    const late = bare && !named ? findCommand(next) : null;
    if (late) {
      cmd = late.name;
      own = consumed.concat(own.slice(i + 1));
    } else {
      cmd = 'launch';
      // A bare word here is the `cam <name>` shorthand; everything after it
      // belongs to claude, so `cam work -c` forwards -c untouched.
      // It is consumed ONLY when it is actually taken as the account name:
      // `--cam work "fix the bug"` already has its name, and swallowing the
      // prompt there dropped it from `forwarded` and opened an empty session.
      if (bare && camName === undefined) {
        camName = next;
        i += 1;
      }
      forwarded = own.slice(i).concat(forwarded);
      own = consumed;
    }
  }

  return { cmd, camArgs: own, forwarded, camName, flags: parseFlags(own) };
}

/**
 * The verb the user actually typed, or null when the router defaulted to launch.
 * @param {string[]} argv the raw argv handed to main()
 * @returns {string|null} a registry command name, or null
 */
function explicitVerb(argv) {
  const first = Array.isArray(argv) ? argv[0] : undefined;
  if (typeof first !== 'string' || first.startsWith('-')) return null;
  const entry = findCommand(first);
  return entry ? entry.name : null;
}

/**
 * The localized word in front of a usage line, taken from the catalogue's own
 * usage string so `uso:` is used in pt-BR without inventing a key.
 * @param {(key: string, vars?: object) => string} t bound translator
 * @returns {string} the label, without its colon
 */
function usageLabel(t) {
  const full = t('help.usage');
  const colon = full.indexOf(':');
  return colon > 0 ? full.slice(0, colon) : full;
}

/**
 * Right-pad an ASCII label. Command names and flags are ASCII by construction,
 * so no display-width arithmetic is needed here.
 * @param {string} s the label
 * @param {number} cols target width
 * @returns {string} the padded label
 */
function pad(s, cols) {
  return s.length >= cols ? s : s + ' '.repeat(cols - s.length);
}

/**
 * The exit-code table, rendered from EXIT so help can never drift from reality.
 * Names are identifiers, not prose, so only the label ahead of them is translated;
 * the continuation indent follows that label's width.
 * @param {Function} [t] a bound translator
 * @returns {string[]} the wrapped lines
 */
function exitCodeLines(t = DEFAULT_T) {
  const pairs = Object.keys(EXIT)
    .map((name) => ({ name, code: EXIT[name] }))
    .sort((a, b) => a.code - b.code)
    .map((p) => `${p.code} ${p.name}`);
  const label = `${t('help.exitCodes')}:`;
  const indent = ' '.repeat(label.length + 2);
  const lines = [];
  for (let i = 0; i < pairs.length; i += 5) {
    const chunk = pairs.slice(i, i + 5).join('   ');
    lines.push(i === 0 ? `${label}  ${chunk}` : `${indent}${chunk}`);
  }
  return lines;
}

/**
 * Render the help screen for one command, or the top-level help.
 * @param {string|null} cmd a command name, or null/undefined for the top level
 * @param {{all?: boolean, t?: Function, version?: string}} [opts] --all, a bound translator, cam's version
 * @returns {string} the complete help text, without a trailing newline
 */
export function helpText(cmd, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const t = typeof options.t === 'function' ? options.t : DEFAULT_T;
  const all = options.all === true;
  const version = typeof options.version === 'string' ? options.version : null;
  const lines = [];
  const entry = cmd ? findCommand(cmd) : null;

  if (entry) {
    lines.push(`${usageLabel(t)}: ${entry.usage}`);
    lines.push('');
    lines.push(`  ${t(entry.summary)}`);
    lines.push('');
    lines.push(t('help.footer', { repo: t('app.repo') }));
    return lines.join('\n');
  }

  if (cmd) {
    lines.push(t('help.unknownCommand', { cmd }));
    lines.push('');
  }

  if (version) lines.push(t('app.header', { name: t('app.name'), version }));
  lines.push(t('help.usage'));
  lines.push('');

  const names = EVERYDAY_ORDER.concat(all ? ADVANCED_ORDER : []);
  const nameCols = names.reduce((w, n) => Math.max(w, n.length), 0) + 2;

  lines.push(t('help.commands'));
  for (const name of EVERYDAY_ORDER) {
    lines.push(`  ${pad(name, nameCols)}${t(COMMANDS[name].summary)}`);
  }
  lines.push('');

  if (all) {
    lines.push(t('help.more'));
    for (const name of ADVANCED_ORDER) {
      lines.push(`  ${pad(name, nameCols)}${t(COMMANDS[name].summary)}`);
    }
  } else {
    lines.push(`  ${t('help.moreHint')}`);
  }
  lines.push('');

  const flagCols = OPTION_ROWS.reduce((w, r) => Math.max(w, r[0].length), 0) + 2;
  lines.push(t('help.options'));
  for (const row of OPTION_ROWS) lines.push(`  ${pad(row[0], flagCols)}${t(row[1])}`);
  lines.push('');

  lines.push(t('help.examples'));
  for (const row of EXAMPLE_ROWS) lines.push(`  ${row}`);
  lines.push('');

  for (const row of exitCodeLines(t)) lines.push(row);
  lines.push('');

  lines.push(t('help.footer', { repo: t('app.repo') }));
  return lines.join('\n');
}

/**
 * `cam help [command] [--all]`.
 * @param {object} ctx the injected context
 * @param {object} args the splitArgs result
 * @returns {Promise<number>} 0, or 2 when the named command does not exist
 */
async function cmdHelp(ctx, args) {
  const target = args.flags.positionals.length > 0 ? args.flags.positionals[0] : null;
  const text = helpText(target, { all: args.flags.all, t: ctx.t, version: ctx.version });
  ctx.io.out.write(`${text}\n`);
  return target && !findCommand(target) ? EXIT.USAGE : EXIT.OK;
}

/**
 * Terminal capabilities for the error renderer, with a safe fallback so a
 * failure inside capability detection can never swallow the real error.
 * @param {object} ctx the injected context
 * @returns {object} a caps object
 */
function safeCaps(ctx) {
  try {
    return detectCaps(ctx, ctx.io.err);
  } catch {
    return { isTTY: false, depth: 0, unicode: false, cols: 80, rows: 24, ascii: true };
  }
}

/**
 * Turn any thrown value into the block the user sees, already translated.
 * @param {object} ctx the injected context
 * @param {unknown} err the thrown value
 * @param {object} caps terminal capabilities from tty.detectCaps
 * @returns {string} the rendered block, without a trailing newline
 */
export function renderError(ctx, err, caps) {
  const t = ctx && typeof ctx.t === 'function' ? ctx.t : DEFAULT_T;
  const verbose = Boolean(ctx && ctx.verbose);
  let title;
  const lines = [];

  if (isCamError(err)) {
    title = String(err.message);
    if (err.hint) lines.push(`${t('err.hintLabel')}: ${err.hint}`);
  } else {
    const message = err && err.message ? String(err.message) : String(err);
    title = t('err.unexpected', { message });
    lines.push(`${t('err.hintLabel')}: ${t('err.errorHint')}`);
    lines.push(t('err.doctorHint'));
  }

  if (verbose && err) {
    if (err.cause && err.cause.message) lines.push(String(err.cause.message));
    if (err.stack) {
      for (const frame of String(err.stack).split('\n').slice(1, 6)) lines.push(frame.trim());
    }
  }

  try {
    return errorBlock({ title, lines }, caps).join('\n');
  } catch {
    const body = lines.length > 0 ? `\n  ${lines.join('\n  ')}` : '';
    return `${t('err.prefix')} ${title}${body}`;
  }
}

/**
 * Apply cam's global flags to the context. A frozen context keeps its defaults;
 * the flags stay readable on `args.flags` either way.
 * @param {object} ctx the injected context
 * @param {object} flags the parsed flag bag
 * @returns {void}
 */
function applyGlobalFlags(ctx, flags) {
  // Each assignment is guarded on its own: a frozen ctx or env must not stop
  // the flags that follow it from being applied.
  const set = (fn) => {
    try {
      fn();
    } catch {
      // Nothing here is worth failing a launch over.
    }
  };
  if (flags.verbose) set(() => { ctx.verbose = true; });
  if (flags.ascii) {
    set(() => { ctx.ascii = true; });
    set(() => { ctx.env.CAM_ASCII = '1'; });
  }
  if (flags.noColor) set(() => { ctx.env.NO_COLOR = '1'; });
  if (flags.lang) {
    const locale = detectLocale({ env: { CAM_LANG: flags.lang }, argv: [] });
    set(() => { ctx.locale = locale; });
    set(() => { ctx.t = createT(locale); });
  }
}

/**
 * The one-line answer to `cam --version`. Not translated beyond the catalogue
 * template: the numbers are machine-readable.
 * @param {object} ctx the injected context
 * @returns {string} the version line
 */
function versionLine(ctx) {
  return ctx.t('app.versionLine', {
    version: ctx.version,
    node: `v${process.versions.node}`,
    platform: ctx.platform,
  });
}

/**
 * The whole program: build the context, split the argv, dispatch, and convert
 * anything thrown into a rendered message plus a stable exit code.
 * Never calls process.exit(); bin/cam.js assigns process.exitCode so that
 * queued stdout and stderr writes are flushed first.
 * @param {string[]} argv arguments after the node binary and the script path
 * @param {object} [overrides] context overrides, deep-merged by createCtx (tests inject here)
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, overrides = {}) {
  const ctx = createCtx(overrides);
  installCursorGuard();

  try {
    const split = splitArgs(argv);
    applyGlobalFlags(ctx, split.flags);

    if (split.flags.version) {
      ctx.io.out.write(`${versionLine(ctx)}\n`);
      return EXIT.OK;
    }
    if (split.flags.help) {
      // `cam add --help` and `cam -v doctor --help` document the verb they name;
      // a defaulted launch (`cam --help`) documents the whole tool.
      const verb = split.cmd === 'launch' ? explicitVerb(argv) : split.cmd;
      const text = helpText(verb, {
        all: split.flags.all,
        t: ctx.t,
        version: ctx.version,
      });
      ctx.io.out.write(`${text}\n`);
      return EXIT.OK;
    }

    const entry = Object.prototype.hasOwnProperty.call(COMMANDS, split.cmd)
      ? COMMANDS[split.cmd]
      : COMMANDS.launch;
    const code = await entry.run(ctx, split);
    return typeof code === 'number' && Number.isFinite(code) ? code : EXIT.OK;
  } catch (err) {
    let text;
    try {
      text = renderError(ctx, err, safeCaps(ctx));
    } catch {
      text = `cam: ${err && err.message ? err.message : String(err)}`;
    }
    try {
      ctx.io.err.write(`${text}\n`);
    } catch {
      // The stream is gone; the exit code still tells the caller what happened.
    }
    if (isCamError(err) && Number.isFinite(err.exitCode)) return err.exitCode;
    return EXIT.ERROR;
  }
}
