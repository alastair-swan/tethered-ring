import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    watch: {
      // assets/ holds several GB of LFS tiles and textures/ holds downloaded imagery.
      // Neither is source code, so keep them out of the file watcher.
      ignored: ['**/assets/**', '**/textures/**', '**/tools/**'],
    },
  },
})
