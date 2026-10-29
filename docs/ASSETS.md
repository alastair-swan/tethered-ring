# Large assets: planet tiles and textures

## Where they live

- **Planet tiles** (`assets/<name>/`) are in Git LFS. The repository's `.lfsconfig` points LFS at the
  project's Cloudflare R2 bucket, with read-only credentials: anyone can pull, and only someone with
  write credentials can upload new objects. `assets/**` is tracked by LFS, including `assets/README.md`
  (the tile format), so even an edit to that file needs an upload.
- **Textures** (`textures/`, gitignored) are downloaded from project-atlantis.com by
  `npm run sync-textures` (also run by `npm run setup`).

`npm run setup` sets `lfs.skipdownloaderrors` in the clone's own config, so an LFS object that is
committed but not in the bucket yet stays a pointer file instead of failing the checkout.

## Regional high-resolution tiles, and the fallback

The global tile sets (`assets/earth`, `assets/moon`) cover the whole body; regional bakes
(`assets/hawaii`, `assets/chimborazo`, ...) add much sharper imagery and terrain over a small area, as
overlays on top. Each preset lists the regional bakes for where it looks (`planetSetup` in
`src/presets/planetSetup.js`), whether they exist yet or not.

At run time each listed bake is used if it is on the machine. If it is not, or it is still an LFS
pointer file, it is skipped: the scene uses the global tiles there, and its imagery credit is not shown.
So a bake made locally shows up in its scenes straight away (preview it as if it were in LFS), and the
same commit still works on a machine that only has the global tiles.

The bakes the presets list, with their approximate sizes (`--estimate`, below):

| Bake | Area | Scenes | Status |
|---|---|---|---|
| `hawaii` | Big Island | bigIslandLauncher, toMarsHawaii, elevatedEvacuatedTubeDeployment, variableSpeedScrew, grapplerEngineering, launchLookingBackwards, toLowOrbitFromEarth | in LFS |
| `chimborazo` | Chimborazo, Ecuador | (toMarsHawaii's alternative site) | in LFS |
| `new_zealand` | North Island; central plateau sharpest | launchVehicleOrbit, launchVehicleDollyShot, launchVehiclePanShot, launchVehicleFountain, launchSystemOverview, twoStageMassDriver, flightPaths | proposed, ~440 MB |
| `washington` | Washington State; Cascades sharpest | transitVehicleDollyShotWashington, smallRing, movingRingsOrbit | proposed, ~250 MB |
| `kilimanjaro` | Mount Kilimanjaro | demonstratorLauncher | proposed, ~100 MB |
| `boca_chica` | Boca Chica, Texas | toLEOFromBocaChikaWithStarship | proposed, ~65 MB |
| `christmas_island` | Christmas Island | christmasIslandLauncher | proposed, ~55 MB |
| `queensland` | North Queensland | transitVehicleDollyShotAustralia | proposed, ~110 MB |

The proposed areas come from the regions the old planet renderer loaded in high resolution for those
scenes, and from where their cameras look. Check them (the cores especially) before baking.

## Baking a regional Earth bake

The Earth regions are defined in `EARTH_REGIONS` in `tools/adaptive_lod.py`: the area to fetch imagery
(EOxCloudless 2024) and terrain (Copernicus GLO-30) for, and bands of tiles to bake, each a box with its
deepest level of detail. To add a region, add an entry there and its name and centre to
`REGIONAL_ASSETS` in `src/presets/planetSetup.js`, then list it in the scenes' `planetSetup` calls.

Needs Python 3 with numpy and Pillow, and `toktx` from KTX-Software
(https://github.com/KhronosGroup/KTX-Software/releases). `toktx` is required: without it the tool writes
PNG tiles, which the renderer does not load (it streams KTX2 only).

PowerShell:

```powershell
python -m tools.adaptive_lod new_zealand --estimate   # tile counts and size, no downloads
python -m tools.adaptive_lod new_zealand --jobs 8     # fetch the sources (cached in .cache/) and bake into assets/new_zealand
npm run dev                                           # then open http://localhost:5173/?preset=launchSystemOverview
```

POSIX shells:

```sh
python3 -m tools.adaptive_lod new_zealand --estimate
python3 -m tools.adaptive_lod new_zealand --jobs 8
npm run dev
```

## Committing LFS data without uploading it

New LFS data (a regional bake, or the textures) is committed like anything else: Git stores a pointer
and the data goes into the clone's own LFS store (`.git/lfs`). A clone without write credentials can
still push the commits, if it skips the upload: its pre-push hook (`.git/hooks/pre-push`, installed by
`git lfs install`, not committed) runs `GIT_LFS_SKIP_PUSH=1 git lfs pre-push "$@"` instead of
`git lfs pre-push "$@"`. For a single push instead:

```powershell
$env:GIT_LFS_SKIP_PUSH = 1; git push; Remove-Item Env:GIT_LFS_SKIP_PUSH
```

```sh
GIT_LFS_SKIP_PUSH=1 git push
```

Other clones then check out the pointers (setup's `lfs.skipdownloaderrors`), and the app falls back to
the tiles it has, until the data is uploaded. To upload it, from the clone that has the data, with write
credentials in that clone's own config (which take precedence over `.lfsconfig`; the URL is the one in
`.lfsconfig` with write credentials in place of the read-only ones):

```sh
git config --local lfs.url "https://<write credentials>@<the .lfsconfig URL without its credentials>"
git lfs push --all origin 2026-claude-refactor   # every LFS object the branch refers to that the store lacks
```

The same commands work in PowerShell. (`git lfs push --dry-run --all origin <branch>` lists them first.)

### Moving the textures into LFS

Only a few of the downloaded textures are used at run time (the Moon, clouds, logo, tube, solar panel,
steel and launch vehicle textures, `UnderwaterView.jpg` and the Olympus Mons images under `textures/mars`).
The rest (the `24x12` grids, `world.topo.*`, `bluemarble_*`, `DisplacementMaps`) are source data for the
tile bakes. To move them into LFS:

1. Remove `textures` from `.gitignore`, and track it in LFS: `git lfs track "textures/**"` (adds the
   pattern to `.gitattributes`).
2. `git add .gitattributes .gitignore textures` and commit; push, then upload them (above).
3. Once the bucket has them, remove the website download (below): `git lfs pull` then fetches the
   textures too.

### Clean-up once everything is in LFS

When the new texture architecture is complete and all its data (planet tile sets, runtime textures and the
source data the tile bakes are built from) is in Git LFS, nothing needs the project-atlantis.com download
any more. Remove all of it:

- `scripts/sync-textures.mjs`, and the `sync-textures` script in `package.json`.
- The texture download step (and its warning) in `scripts/setup.mjs`.
- The `textures` entry in `.gitignore` (the folder is then tracked in LFS).
- The mentions of the download: `README.md` (setup), `CLAUDE.md` (`textures/` is downloaded),
  `docs/ARCHITECTURE.md` (the folder list) and the top of this file.
- Defaults in the bake tools that point at source files under `textures/` (for example `COLOR_SOURCE` and
  `HEIGHT_SOURCE` in `tools/adaptive_lod.py`), once the bakes read the sources built by `tools/sources/`.
