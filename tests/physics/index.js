// Entry point so that `node --test tests/physics/` (a directory argument) runs every test file here.
// Node resolves a directory argument to its index.js; each imported file registers its own tests.
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
for (const file of readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort()) {
  await import(pathToFileURL(path.join(here, file)).href)
}
