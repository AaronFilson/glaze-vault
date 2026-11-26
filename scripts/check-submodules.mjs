// The core and the catalog are git submodules (lib/core, lib/catalog: .gitmodules). A clone made without
// --recurse-submodules, or a worktree made with plain `git worktree add`, has them as empty folders, and the app
// would fail far from the cause (a missing module in ui/chemistryHost.ts). This stops first, saying what to run.
// It also says when a library is checked out at another commit than Glaze Vault pins, which tests the wrong code.
//
//   node scripts/check-submodules.mjs     run before build, dev, typecheck and the tests (package.json)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LIBRARIES = ['lib/core', 'lib/catalog'];

const empty = LIBRARIES.filter((dir) => !existsSync(path.join(ROOT, dir, 'index.ts')));
if (empty.length) {
  console.error(
    `${empty.join(' and ')} ${empty.length > 1 ? 'are' : 'is'} empty: the libraries are git submodules.\n` +
      'Run: git submodule update --init\n' +
      '(A new clone: git clone --recurse-submodules. A new worktree: node scripts/worktree.mjs.)'
  );
  process.exit(1);
}

// Where git is at hand: each library at the commit Glaze Vault pins.
let status = '';
try {
  status = execFileSync('git', ['submodule', 'status', ...LIBRARIES], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
} catch {
  process.exit(0);
}
// A leading '+' is a checkout at another commit than the one recorded; '-' is not initialised.
const moved = status
  .split('\n')
  .filter((line) => /^[+-]/.test(line))
  .map((line) => line.trim().split(/\s+/)[1]);
if (moved.length) {
  console.error(
    `${moved.join(' and ')} ${moved.length > 1 ? 'are' : 'is'} not at the commit Glaze Vault pins.\n` +
      'Run: git submodule update   (or, to use the checkout you have, commit the new pointer: git add ' +
      moved.join(' ') +
      ')'
  );
  process.exit(1);
}
