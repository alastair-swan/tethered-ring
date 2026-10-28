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
run('git', ['lfs', 'pull'])
run('node', ['scripts/sync-textures.mjs'])
console.log('\nSetup complete. Start the app with "npm run dev".')
