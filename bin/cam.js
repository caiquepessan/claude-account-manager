#!/usr/bin/env node
// bin/cam.js — the executable entry point: shebang, Node version guard, then the
// CLI. Nothing may be imported above the guard: an old Node must print advice,
// not a SyntaxError stack trace. This file runs on every `claude` invocation.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  process.stderr.write(`cam requires Node.js 18.17+ — you are running ${process.version}.\nUpgrade at https://nodejs.org (or use nvm/fnm/volta).\n`);
  process.exit(1);
}
const { main } = await import('../src/cli.js');
process.exitCode = (await main(process.argv.slice(2))) ?? 0;
