// A new worktree with the libraries in it. Plain `git worktree add` leaves submodules empty (lib/core,
// lib/catalog), so this adds the worktree, then fills each submodule from the main clone's copy of it
// (--reference: its objects are borrowed, not downloaded again), at the commit Glaze Vault pins.
//
//   node scripts/worktree.mjs <path> [git worktree add's other arguments, such as -b <branch> or a commit]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const [where, ...rest] = process.argv.slice(2);
if (!where) {
  console.error('Usage: node scripts/worktree.mjs <path> [-b <branch>] [<commit>]');
  process.exit(1);
}
const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'inherit' });
const main = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' })
  .trim()
  .replace(/\/\.git$/, '');
const target = path.resolve(where);

git(['worktree', 'add', target, ...rest]);
for (const dir of ['lib/core', 'lib/catalog']) {
  const own = path.join(main, dir);
  // The main clone's checkout of the library, when it has one, lends its objects.
  const reference = existsSync(path.join(own, '.git')) ? ['--reference', own] : [];
  git(['submodule', 'update', '--init', ...reference, '--', dir], target);
}
console.log(`Worktree at ${target}, with lib/core and lib/catalog.`);
