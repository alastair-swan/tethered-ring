import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    watch: {
      // assets/ holds several GB of LFS tiles and textures/ holds downloaded imagery.
      // Neither is source code, so keep them out of the file watcher.
      ignored: ['**/assets/**', '**/textures/**', '**/tools/**'],
    },
  },
  optimizeDeps: {
    // Pre-bundle dependencies that are only reached through dynamic imports so the first
    // recording does not trigger a dependency re-optimization and page reload.
    include: ['mediabunny'],
  },
})
