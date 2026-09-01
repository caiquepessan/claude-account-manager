// src/fsx.js — every filesystem primitive whose behaviour differs by platform,
// resolved into a return value the caller can report instead of an exception it
// must guess about: atomic writes, one-time backups, link-safe deletion.

import { createHash, randomBytes } from 'node:crypto';
import { constants as FS, promises as fsp } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { fail } from './ctx.js';

/** Rename/copy errors that are transient on Windows (AV, indexer, OneDrive, a live claude). */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST', 'ENOTEMPTY']);

/** Backoff ceiling for the bounded rename retry loop. */
const MAX_DELAY_MS = 500;

/** Windows MAX_PATH, and the point past which Claude Code's own nesting gets risky. */
const WIN_MAX_PATH = 260;
const WIN_RISK_LEN = 160;
const POSIX_PATH_MAX = 4096;

/** Recursion ceiling for copyDir / the link-safe walk. */
const MAX_DEPTH = 40;

/**
 * True when ctx describes a POSIX platform. `ctx.isPosix` wins when present so a
 * test can drive both branches without touching the real platform.
 * @param {object} ctx - The cam context.
 * @returns {boolean} True on darwin/linux/etc, false on win32.
 */
function isPosix(ctx) {
  if (typeof ctx?.isPosix === 'boolean') return ctx.isPosix;
  return ctx?.platform !== 'win32';
}

/**
 * Translate through ctx, falling back to the bare key when no translator is
 * injected (only reachable from a hand-built ctx in a unit test).
 * @param {object} ctx - The cam context.
 * @param {string} key - i18n key.
 * @param {object} [vars] - Interpolation variables.
 * @returns {string} The translated string.
 */
function tr(ctx, key, vars = {}) {
  return typeof ctx?.t === 'function' ? ctx.t(key, vars) : key;
}

/**
 * Throw a CamError (via ctx.fail semantics) with extra machine-readable fields
 * attached, since `fail` itself only carries code/exitCode/hint/cause.
 * @param {string} code - CamError code.
 * @param {string} message - Already-translated message.
 * @param {object} [opts] - { hint, cause } — hint must already be translated.
 * @param {object} [extra] - Extra own properties to attach (file, offset, ...).
 * @returns {never} Always throws.
 */
function failWith(code, message, opts = {}, extra = {}) {
  try {
    fail(code, message, opts);
  } catch (err) {
    if (err && typeof err === 'object') Object.assign(err, extra);
    throw err;
  }
  throw new Error(code);
}

/**
 * Raise the IO / permission CamError for a failed filesystem operation.
 * @param {object} ctx - The cam context.
 * @param {string} file - The path the operation was aimed at.
 * @param {Error} cause - The underlying errno error.
 * @returns {never} Always throws.
 */
function failIo(ctx, file, cause) {
  const code = cause && cause.code;
  if (code === 'EACCES' || code === 'EPERM') {
    failWith(
      'IO',
      tr(ctx, 'err.permission', { file }),
      { hint: tr(ctx, 'err.permissionHint', { file }), cause },
      { file, errno: code }
    );
  }
  failWith(
    'IO',
    tr(ctx, 'err.io', { file }),
    { hint: tr(ctx, 'err.ioHint'), cause },
    { file, errno: code || null }
  );
}

/**
 * Resolve the cam store root without importing profiles.js (which imports this
 * module). Mirrors profiles.storePaths().root exactly.
 * @param {object} ctx - The cam context.
 * @returns {string} Absolute path of ~/.claude-account-manager (or CAM_HOME).
 */
function storeRoot(ctx) {
  const raw = ctx?.env?.CAM_HOME;
  if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw.trim());
  return path.join(ctx?.home ?? '.', '.claude-account-manager');
}

/**
 * True when `child` is `parent` or lives underneath it.
 * @param {string} parent - Containing directory.
 * @param {string} child - Candidate path.
 * @returns {boolean} Whether child is contained by parent.
 */
function isInside(parent, child) {
  const a = path.resolve(parent);
  const b = path.resolve(child);
  if (a === b) return true;
  const rel = path.relative(a, b);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Refuse a recursive delete that resolves outside the allowed root. This is the
 * guard that makes it impossible to follow a shared junction into ~/.claude.
 * @param {object} ctx - The cam context.
 * @param {string} target - The path about to be deleted.
 * @param {string} allowedRoot - The only directory deletion may happen inside.
 * @returns {void}
 */
function assertDeletable(ctx, target, allowedRoot) {
  if (isInside(allowedRoot, target)) return;
  failWith(
    'UNSAFE',
    tr(ctx, 'fsx.refuseOutsideStore', { file: path.resolve(target), root: path.resolve(allowedRoot) }),
    { hint: tr(ctx, 'err.unsafeHint') },
    { file: path.resolve(target), allowedRoot: path.resolve(allowedRoot) }
  );
}

/**
 * Compare two paths, case-insensitively on Windows.
 * @param {object} ctx - The cam context.
 * @param {string} a - First path.
 * @param {string} b - Second path.
 * @returns {boolean} Whether both name the same file.
 */
function samePath(ctx, a, b) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return isPosix(ctx) ? ra === rb : ra.toLowerCase() === rb.toLowerCase();
}

/**
 * The three files cam must never write, made unwritable structurally rather than
 * by convention: the user's real login is never touched by any code path.
 * @param {object} ctx - The cam context.
 * @param {string} file - The write target.
 * @returns {void}
 */
function assertNotClaudeOwned(ctx, file) {
  const home = ctx?.home;
  if (typeof home !== 'string' || home === '') return;
  const forbidden = [
    path.join(home, '.claude.json'),
    path.join(home, '.claude', '.claude.json'),
    path.join(home, '.claude', '.credentials.json')
  ];
  if (!forbidden.some((f) => samePath(ctx, f, file))) return;
  failWith(
    'UNSAFE',
    tr(ctx, 'fsx.refuseClaudeOwned', { file: path.resolve(file) }),
    { hint: tr(ctx, 'err.unsafeHint') },
    { file: path.resolve(file) }
  );
}

/**
 * lstat that answers `null` instead of throwing when the path is absent.
 * @param {string} p - Path to stat.
 * @returns {Promise<import('node:fs').Stats|null>} Stats, or null.
 */
async function lstatOrNull(p) {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

/**
 * Remove one link entry. Windows junctions and directory symlinks refuse
 * `unlink` and need `rmdir`; POSIX symlinks always take `unlink`.
 * @param {string} p - The link path.
 * @returns {Promise<void>} Resolves once the link is gone.
 */
async function unlinkLink(p) {
  try {
    await fsp.unlink(p);
    return;
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    try {
      await fsp.rmdir(p);
      return;
    } catch (err2) {
      if (err2 && err2.code === 'ENOENT') return;
      throw err;
    }
  }
}

/**
 * Create a directory (recursively) and tighten its mode on POSIX.
 * @param {object} ctx - The cam context.
 * @param {string} dir - Directory to create.
 * @param {number} [mode] - POSIX mode, ignored on Windows.
 * @returns {Promise<void>} Resolves when the directory exists.
 */
export async function ensureDir(ctx, dir, mode = 0o700) {
  try {
    // recursive mkdir is idempotent for directories, so EEXIST here means a FILE
    // is sitting in the path and the caller needs to hear about it.
    await fsp.mkdir(dir, { recursive: true, mode });
  } catch (err) {
    failIo(ctx, dir, err);
  }
  await chmodIfPosix(ctx, dir, mode);
}

/**
 * chmod on POSIX only. Windows has no chmod: there the store is protected by the
 * NTFS user-profile ACL alone, which is exactly what `cam doctor` reports.
 * @param {object} ctx - The cam context.
 * @param {string} p - Path to chmod.
 * @param {number} mode - POSIX mode bits.
 * @returns {Promise<void>} Resolves when done (immediately on win32).
 */
export async function chmodIfPosix(ctx, p, mode) {
  if (!isPosix(ctx)) return;
  try {
    await fsp.chmod(p, mode);
  } catch (err) {
    const code = err && err.code;
    const soft = code === 'ENOENT' || code === 'EPERM' || code === 'EACCES'
      || code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EINVAL';
    if (!soft) failIo(ctx, p, err);
  }
}

/**
 * Copy `file` to `<file>.cam-backup` once and only once: the pre-cam original is
 * the only version worth keeping, so an existing backup is never overwritten.
 * @param {object} ctx - The cam context.
 * @param {string} file - File to back up.
 * @returns {Promise<string|null>} The backup path if one was written, else null.
 */
export async function backupOnce(ctx, file) {
  const dest = `${file}.cam-backup`;
  const src = await lstatOrNull(file);
  if (!src || !src.isFile()) return null;
  try {
    await fsp.copyFile(file, dest, FS.COPYFILE_EXCL);
    await chmodIfPosix(ctx, dest, 0o600);
    return dest;
  } catch (err) {
    if (err && err.code === 'EEXIST') return null;
    if (err && err.code === 'ENOENT') return null;
    failIo(ctx, dest, err);
  }
  return null;
}

/**
 * rename with the bounded retry loop. Verified necessary: on Windows, renaming
 * over a file another process holds open fails EPERM where POSIX succeeds.
 * @param {string} from - Source path.
 * @param {string} to - Destination path.
 * @param {number} retries - Total attempts.
 * @param {number} baseDelayMs - First backoff step, doubling to 500 ms.
 * @returns {Promise<void>} Resolves on success, rejects with the last errno.
 */
async function renameWithRetry(from, to, retries, baseDelayMs) {
  const attempts = Math.max(1, retries | 0);
  let delay = Math.max(1, baseDelayMs | 0);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const code = err && err.code;
      if (attempt >= attempts || !RETRYABLE.has(code)) throw err;
      await sleep(Math.min(delay, MAX_DELAY_MS));
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
}

/**
 * fsync the parent directory — POSIX only. Verified on the target machine:
 * opening a directory and fsyncing it throws EPERM on Windows, so an unguarded
 * directory fsync would fail every durable write on this project's main platform.
 * @param {object} ctx - The cam context.
 * @param {string} dir - Directory to sync.
 * @returns {Promise<void>} Always resolves; failure is not fatal.
 */
async function fsyncDir(ctx, dir) {
  if (!isPosix(ctx)) return;
  let handle = null;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch {
    /* best effort: a synced file with an unsynced dirent is still correct data */
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * The one durable write in the program: optional one-time backup, temp file in
 * the SAME directory, fsync, chmod on POSIX, rename with bounded retry, then a
 * POSIX-only directory fsync. On any failure the temp file is removed and the
 * original is left untouched. Refuses outright to target ~/.claude.json,
 * ~/.claude/.claude.json or ~/.claude/.credentials.json.
 * @param {object} ctx - The cam context.
 * @param {string} file - Destination path.
 * @param {string|Uint8Array} data - Bytes to write.
 * @param {object} [opts] - { mode = 0o600, backupOnce = false, retries = 10, baseDelayMs = 10 }.
 * @returns {Promise<void>} Resolves once the rename succeeded.
 */
export async function writeFileAtomic(ctx, file, data, opts = {}) {
  const {
    mode = 0o600,
    backupOnce: doBackupOnce = false,
    retries = 10,
    baseDelayMs = 10
  } = opts;

  assertNotClaudeOwned(ctx, file);

  const dir = path.dirname(file);
  if (doBackupOnce) await backupOnce(ctx, file);

  const pid = Number.isInteger(ctx?.pid) ? ctx.pid : process.pid;
  const tmp = path.join(dir, `${path.basename(file)}.cam-${pid}-${randomBytes(3).toString('hex')}.tmp`);

  let handle = null;
  try {
    try {
      handle = await fsp.open(tmp, 'wx', mode);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        await ensureDir(ctx, dir, 0o700);
        handle = await fsp.open(tmp, 'wx', mode);
      } else {
        throw err;
      }
    }
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;

    await chmodIfPosix(ctx, tmp, mode);
    await renameWithRetry(tmp, file, retries, baseDelayMs);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await fsp.unlink(tmp);
    } catch {
      /* ignore: the original is untouched either way */
    }
    failIo(ctx, file, err);
  }

  await fsyncDir(ctx, dir);
}

/**
 * writeFileAtomic for JSON, pretty-printed with two spaces and an LF terminator.
 * @param {object} ctx - The cam context.
 * @param {string} file - Destination path.
 * @param {any} value - JSON-serialisable value.
 * @param {object} [opts] - Same options as writeFileAtomic.
 * @returns {Promise<void>} Resolves once the rename succeeded.
 */
export async function writeJsonAtomic(ctx, file, value, opts = {}) {
  await writeFileAtomic(ctx, file, `${JSON.stringify(value, null, 2)}\n`, opts);
}

/**
 * Pull the byte offset out of a V8 JSON SyntaxError message. Measured on Node
 * 24: the "Expected … in JSON at position N (line L column C)" form carries one,
 * while the short "Unexpected token 'x', \"…\" is not valid JSON" form does not,
 * so null is a legitimate answer rather than a parse failure of our own.
 * @param {Error} err - The SyntaxError from JSON.parse.
 * @returns {number|null} Byte offset, or null when the message has none.
 */
function jsonOffset(err) {
  const m = /position\s+(\d+)/i.exec(String(err && err.message));
  return m ? Number(m[1]) : null;
}

/**
 * Strict JSON read: throws CamError('E_BAD_JSON') carrying the file path (`.file`)
 * and the SyntaxError byte offset (`.offset`, null when V8 reports none). Use it
 * only for files cam itself owns; everything else goes through readJsonSafe.
 * @param {object} ctx - The cam context.
 * @param {string} file - File to read.
 * @returns {Promise<any>} The parsed value.
 */
export async function readJson(ctx, file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    const code = err && err.code;
    if (code === 'EACCES' || code === 'EPERM') {
      failWith(
        'IO',
        tr(ctx, 'err.permission', { file }),
        { hint: tr(ctx, 'err.permissionHint', { file }), cause: err },
        { file, errno: code }
      );
    }
    failWith(
      'IO',
      tr(ctx, 'err.read', { file }),
      { hint: tr(ctx, 'err.ioHint'), cause: err },
      { file, errno: code || null }
    );
  }
  try {
    return JSON.parse(stripBom(text));
  } catch (err) {
    failWith(
      'E_BAD_JSON',
      tr(ctx, 'err.json', { file }),
      { hint: tr(ctx, 'err.jsonHint'), cause: err },
      { file, offset: jsonOffset(err) }
    );
  }
  return null;
}

/**
 * Drop a UTF-8 BOM, which PowerShell's `>` redirection happily writes.
 * @param {string} s - Raw file text.
 * @returns {string} Text without a leading BOM.
 */
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Never-throwing JSON read. Every read of a file cam does not own goes through
 * here: one corrupt file must never take down the menu.
 * @param {object} ctx - The cam context.
 * @param {string} file - File to read.
 * @param {any} [fallback] - Value returned on any failure.
 * @returns {Promise<any>} The parsed value, or `fallback`.
 */
export async function readJsonSafe(ctx, file, fallback = null) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    const value = JSON.parse(stripBom(text));
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * Copy a file when the source exists; report whether it did.
 * @param {object} ctx - The cam context.
 * @param {string} from - Source path.
 * @param {string} to - Destination path.
 * @param {number} [mode] - POSIX mode applied to the copy.
 * @returns {Promise<boolean>} True when a copy was made.
 */
export async function copyFileIfExists(ctx, from, to, mode = 0o600) {
  const st = await lstatOrNull(from);
  if (!st) return false;
  if (st.isDirectory()) return false;
  try {
    await fsp.copyFile(from, to);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    failIo(ctx, to, err);
  }
  await chmodIfPosix(ctx, to, mode);
  return true;
}

/**
 * Recursive directory copy that never follows a link out of the tree: symlinks
 * are recreated (POSIX) or, on Windows, re-linked as junctions when they point at
 * a directory and dereferenced only for plain files.
 * @param {object} ctx - The cam context.
 * @param {string} from - Source directory.
 * @param {string} to - Destination directory.
 * @returns {Promise<number>} Number of files copied.
 */
export async function copyDir(ctx, from, to) {
  const src = path.resolve(from);
  const dest = path.resolve(to);
  if (isInside(src, dest)) {
    failWith('IO', tr(ctx, 'fsx.copyIntoItself', { file: dest }), { hint: tr(ctx, 'err.ioHint') }, { file: dest });
  }
  const st = await lstatOrNull(src);
  if (!st || !st.isDirectory()) return 0;
  return copyDirInto(ctx, src, dest, 0);
}

/**
 * The recursive half of copyDir.
 * @param {object} ctx - The cam context.
 * @param {string} src - Source directory (already resolved).
 * @param {string} dest - Destination directory (already resolved).
 * @param {number} depth - Current recursion depth.
 * @returns {Promise<number>} Number of files copied under this directory.
 */
async function copyDirInto(ctx, src, dest, depth) {
  if (depth > MAX_DEPTH) return 0;
  await ensureDir(ctx, dest, 0o700);

  let entries;
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM')) return 0;
    failIo(ctx, src, err);
    return 0;
  }

  let files = 0;
  for (const entry of entries) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dest, entry.name);
    try {
      if (entry.isSymbolicLink()) {
        files += await copyLinkEntry(ctx, sp, dp);
        continue;
      }
      if (entry.isDirectory()) {
        files += await copyDirInto(ctx, sp, dp, depth + 1);
        continue;
      }
      if (entry.isFile()) {
        await fsp.copyFile(sp, dp);
        await chmodIfPosix(ctx, dp, 0o600);
        files += 1;
      }
    } catch {
      /* one unreadable entry must not abort a profile seed */
    }
  }
  return files;
}

/**
 * Reproduce one symlink entry at the destination without ever following it into
 * the user's real ~/.claude tree.
 * @param {object} ctx - The cam context.
 * @param {string} sp - Source link path.
 * @param {string} dp - Destination path.
 * @returns {Promise<number>} 1 when a file was materialised, else 0.
 */
async function copyLinkEntry(ctx, sp, dp) {
  let target;
  try {
    target = await fsp.readlink(sp);
  } catch {
    return 0;
  }
  const absTarget = path.isAbsolute(target) ? target : path.resolve(path.dirname(sp), target);
  let targetIsDir = false;
  try {
    targetIsDir = (await fsp.stat(absTarget)).isDirectory();
  } catch {
    targetIsDir = false;
  }

  if (!isPosix(ctx)) {
    if (targetIsDir) {
      try {
        await fsp.symlink(absTarget, dp, 'junction');
      } catch {
        /* ignore: a missing share link is reported by doctor, not fatal here */
      }
      return 0;
    }
    try {
      await fsp.copyFile(sp, dp);
      return 1;
    } catch {
      return 0;
    }
  }

  try {
    await fsp.symlink(target, dp, targetIsDir ? 'dir' : 'file');
  } catch {
    /* ignore */
  }
  return 0;
}

/**
 * Move a directory by rename only, with the same bounded retry as the atomic
 * write. Never falls back to copy-then-delete: that would traverse the junctions
 * a profile holds into the user's real ~/.claude.
 * @param {object} ctx - The cam context.
 * @param {string} from - Source directory.
 * @param {string} to - Destination directory (its parent is created).
 * @returns {Promise<void>} Resolves once the rename succeeded.
 */
export async function moveDir(ctx, from, to) {
  await ensureDir(ctx, path.dirname(to), 0o700);
  try {
    await renameWithRetry(from, to, 10, 10);
  } catch (err) {
    failIo(ctx, to, err);
  }
}

/**
 * Share a directory into a profile: a junction on Windows (verified to work
 * without elevation), a directory symlink on POSIX, degrading to a copy and then
 * to nothing. Never throws — the caller records the mode in profile metadata so
 * `cam doctor` can report which profiles got live sharing and which got a snapshot.
 * @param {object} ctx - The cam context.
 * @param {string} target - The real directory to share (e.g. ~/.claude/plugins).
 * @param {string} linkPath - Where the profile should see it.
 * @returns {Promise<'link'|'copy'|'skip'>} What actually happened.
 */
export async function linkDir(ctx, target, linkPath) {
  const abs = path.resolve(target);
  const src = await lstatOrNull(abs);
  if (!src) return 'skip';

  const existing = await lstatOrNull(linkPath);
  if (existing) {
    // Already shared: idempotent. A real directory here is never clobbered and is
    // never copied into, because copying THROUGH a junction would write into the
    // user's real ~/.claude.
    return existing.isSymbolicLink() ? 'link' : 'skip';
  }

  try {
    await ensureDir(ctx, path.dirname(linkPath), 0o700);
  } catch {
    return 'skip';
  }

  try {
    await fsp.symlink(abs, linkPath, isPosix(ctx) ? 'dir' : 'junction');
    return 'link';
  } catch (err) {
    const code = err && err.code;
    if (code === 'EEXIST') return 'skip';
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOSYS'
      && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EINVAL') {
      return 'skip';
    }
  }

  try {
    await copyDir(ctx, abs, linkPath);
    return 'copy';
  } catch {
    return 'skip';
  }
}

/**
 * Whether a path is a link cam would step over rather than into — a POSIX
 * symlink or a Windows junction (Node reports both as symbolic links).
 * @param {object} ctx - The cam context.
 * @param {string} p - Path to test.
 * @returns {Promise<boolean>} True when the path is a link.
 */
export async function isOurLink(ctx, p) {
  const st = await lstatOrNull(p);
  return Boolean(st && st.isSymbolicLink());
}

/**
 * The link-safe recursive removal: lstat every entry first, unlink links WITHOUT
 * recursing, and only then descend into real directories.
 * @param {object} ctx - The cam context.
 * @param {string} target - Path to remove.
 * @param {{dirs:number, files:number, links:number}} counts - Accumulator.
 * @param {number} depth - Current recursion depth.
 * @returns {Promise<void>} Resolves when the path is gone.
 */
async function removeSafely(ctx, target, counts, depth) {
  const st = await lstatOrNull(target);
  if (!st) return;

  if (st.isSymbolicLink()) {
    await unlinkLink(target);
    counts.links += 1;
    return;
  }

  if (!st.isDirectory()) {
    try {
      await fsp.unlink(target);
      counts.files += 1;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') failIo(ctx, target, err);
    }
    return;
  }

  if (depth <= MAX_DEPTH) {
    let entries = [];
    try {
      entries = await fsp.readdir(target, { withFileTypes: true });
    } catch (err) {
      if (!err || err.code !== 'ENOENT') failIo(ctx, target, err);
      return;
    }
    for (const entry of entries) {
      await removeSafely(ctx, path.join(target, entry.name), counts, depth + 1);
    }
  }

  try {
    await fsp.rmdir(target);
    counts.dirs += 1;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') failIo(ctx, target, err);
  }
}

/**
 * The ONLY recursive delete in the program. Every entry is lstat'd first and
 * links are unlinked rather than followed, because profiles hold junctions into
 * the user's real ~/.claude/plugins and ~/.claude/skills. Refuses outright if
 * `root` does not resolve inside <store>/trash/.
 * @param {object} ctx - The cam context.
 * @param {string} root - The trashed directory to destroy.
 * @returns {Promise<{dirs:number, files:number, links:number}>} What was removed.
 */
export async function purgeTree(ctx, root) {
  const trashDir = path.join(storeRoot(ctx), 'trash');
  assertDeletable(ctx, root, trashDir);
  const counts = { dirs: 0, files: 0, links: 0 };
  await removeSafely(ctx, path.resolve(root), counts, 0);
  return counts;
}

/**
 * Link-safe removal of anything cam owns inside its own store (a rolled-back
 * profile directory, an isolation probe directory, a stale temp file). Refuses
 * any path outside the store root.
 * @param {object} ctx - The cam context.
 * @param {string} p - Path to remove.
 * @returns {Promise<void>} Resolves when the path is gone.
 */
export async function rmrf(ctx, p) {
  assertDeletable(ctx, p, storeRoot(ctx));
  const counts = { dirs: 0, files: 0, links: 0 };
  await removeSafely(ctx, path.resolve(p), counts, 0);
}

/**
 * sha256 of a string as lowercase hex — pure, so it can be unit-tested against
 * the known macOS Keychain service formula and against token fingerprints.
 * @param {string} s - Input string.
 * @returns {string} 64 lowercase hex characters.
 */
export function sha256Hex(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/**
 * Windows MAX_PATH budget. Claude Code appends URL-encoded project directory
 * names plus session filenames under `projects/`, so a store root over 160
 * characters is already at risk; doctor suggests CAM_HOME=C:\cam.
 * @param {object} ctx - The cam context.
 * @param {string} p - Path to measure.
 * @returns {{risk:boolean, len:number, budget:number}} Risk, length, headroom.
 */
export function pathTooLongRisk(ctx, p) {
  const len = String(p ?? '').length;
  if (isPosix(ctx)) return { risk: false, len, budget: POSIX_PATH_MAX - len };
  return { risk: len > WIN_RISK_LEN, len, budget: WIN_MAX_PATH - len };
}
