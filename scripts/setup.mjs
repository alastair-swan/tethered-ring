// One-time setup for a fresh clone: fetches the Git LFS assets and the downloadable textures.
// Works the same on Windows, macOS and Linux.
//
//   npm run setup
import { spawnSync } from 'node:child_process'
import process from 'node:process'

function run(command, args, { optional = false } = {}) {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0 && !optional) {
    console.error(`\n"${command} ${args.join(' ')}" failed.`)
    process.exit(result.status ?? 1)
  }
  return result.status === 0
}

const lfs = spawnSync('git', ['lfs', 'version'], { encoding: 'utf8', shell: process.platform === 'win32' })
if (lfs.status !== 0) {
  console.error(`Git LFS is not installed. It is needed to download the planet tile assets in assets/.
Install it, then run "npm run setup" again:
  Windows:  winget install GitHub.GitLFS        (or download from https://git-lfs.com)
  macOS:    brew install git-lfs
  Fedora:   sudo dnf install git-lfs
  Debian/Ubuntu: sudo apt install git-lfs`)
  process.exit(1)
}

// --local keeps the LFS hooks in this repository's .git/config instead of the user's global config.
run('git', ['lfs', 'install', '--local'])
// Tile sets committed but not yet uploaded to the LFS store stay as pointer files instead of failing the
// checkout: the planet then uses the tiles below them (see src/presets/planetSetup.js).
run('git', ['config', '--local', 'lfs.skipdownloaderrors', 'true'])
run('git', ['lfs', 'pull'])
// The rest of the textures come from project-atlantis.com (until they move into Git LFS: docs/ASSETS.md).
// Without them the planet and launcher still work, so a failure here only warns.
if (!run('node', ['scripts/sync-textures.mjs'], { optional: true })) {
  console.warn('\nSome textures could not be downloaded from project-atlantis.com (see above). The app still runs;' +
    ' re-run "npm run sync-textures" later.')
}
console.log('\nSetup complete. Start the app with "npm run dev".')
