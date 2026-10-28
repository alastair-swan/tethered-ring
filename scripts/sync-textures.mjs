// Downloads the texture files that are not stored in git (they live in textures/, which is
// gitignored) from the project-atlantis.com server. Files that already exist locally are skipped.
//
//   npm run sync-textures
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const TEXTURE_LIST_URL = 'https://www.project-atlantis.com/wp-content/threejs-simulation/textures/getTextures.php'
const TEXTURE_SOURCE_URL = 'https://www.project-atlantis.com/wp-content/threejs-simulation/textures'
const CONCURRENCY = 4

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const textureFolder = path.join(repoRoot, 'textures')

async function fetchWithRetry(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response
    } catch (err) {
      if (i >= attempts) throw new Error(`${url}: ${err.message}`)
      await new Promise((r) => setTimeout(r, 1000 * i))
    }
  }
}

// Remote entries look like "/24x12/HR/earth_HR_24x12_0x0.jpg"; map them onto the local OS path.
function localPathFor(remoteEntry) {
  return path.join(textureFolder, ...remoteEntry.split('/').filter(Boolean))
}

async function download(remoteEntry) {
  const destination = localPathFor(remoteEntry)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const response = await fetchWithRetry(TEXTURE_SOURCE_URL + remoteEntry)
  const partial = `${destination}.part`
  fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()))
  fs.renameSync(partial, destination)
}

const remoteEntries = await (await fetchWithRetry(TEXTURE_LIST_URL)).json()
const missing = remoteEntries.filter((entry) => {
  const p = localPathFor(entry)
  return !fs.existsSync(p) || fs.statSync(p).size === 0
})

if (!missing.length) {
  console.log(`All ${remoteEntries.length} textures are present.`)
  process.exit(0)
}

console.log(`Downloading ${missing.length} of ${remoteEntries.length} textures into ${textureFolder}`)
let done = 0
const failures = []
const queue = [...missing]
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let entry = queue.shift(); entry; entry = queue.shift()) {
    try {
      await download(entry)
    } catch (err) {
      failures.push(err.message)
    }
    done++
    if (done % 25 === 0 || done === missing.length) console.log(`  ${done}/${missing.length}`)
  }
}))

if (failures.length) {
  console.error(`${failures.length} download(s) failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('Texture sync complete.')
