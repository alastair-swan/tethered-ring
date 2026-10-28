# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A browser-based Three.js simulation and engineering model of a **Tethered Ring**: a maglev-supported ring structure tethered to the planet, plus transit systems, elevators and a mass-driver/screw space launcher. Background: https://www.project-atlantis.com. Plain ES modules (no TypeScript, no framework), bundled and served by Vite.

## Commands

```
npm install
npm run dev-sync   # downloads textures into textures/ (gitignored); needed for the legacy planet renderer
npm run dev        # Vite dev server (polling file watcher), open the printed URL
npm run build      # vite build -> dist/
npm run serve      # vite preview of the build
```

- There are no tests and no lint/format setup. Prettier and format-on-save are deliberately disabled in `.vscode/settings.json`. Check changes by running the dev server and reading the browser console (F12). A hard refresh (Ctrl+Shift+R) is sometimes needed.
- `ci:build`/`ci:check` in package.json call `next build` and are leftovers. They don't work for this project.
- `?enableVR=true` in the URL enables WebXR.
- `assets/**` is stored in Git LFS (Cloudflare R2, configured in `.lfsconfig`). Run `git lfs pull` to fetch the planet2 tile sets. Don't search or grep inside `assets/`: it's huge and mostly binary.

## Architecture

### Parameter flow (the core pattern)
`main.js` (~4300 lines) is the entry point and orchestrator. It holds almost all state at module level.

1. **`guidParamWithUnits`** (main.js): one big table of every tunable parameter, `{value, units, autoMap, min, max, updateFunction, folder}`. Entries are turned into lil-gui sliders in folders such as Location, Engineering, Launcher, Rocket and Rendering. Each entry's `updateFunction` (e.g. `adjustRingDesign`, `updateLauncher`) rebuilds whatever depends on it.
2. **`guidParam`**: a flat `{key: value}` mirror that lil-gui binds to.
3. **`dParamWithUnits`**: derived parameters, recomputed in `updatedParam()` from the GUI values plus computed quantities (material properties, eccentricity, and so on). **Subsystems take `dParamWithUnits`, not the GUI objects.**
4. **`nonGUIParams`**: flags and callbacks that aren't sliders. Examples: `usePlanet2`, `getRingSpecs`, `startTimerActions`, XHR texture/displacement callbacks, camera shots.

When you add a parameter, add it to `guidParamWithUnits` with its units and an update function, then read it in the subsystem through `dParamWithUnits['name'].value`.

### Presets
`CapturePresets.applyCapturePreset()` runs at startup. It sets default `nonGUIParams`, then picks a scenario through a **hardcoded `switch (N)`** near the top of the function. To use a different scenario, edit that literal. Scenario functions live in `presets/*.js` (e.g. `toLowOrbitFromEarth`, `toMarsHawaiiLauncherPresets`). They overwrite `guidParamWithUnits[...].value` and `nonGUIParams` entries, and some of them chain to other presets. `cameraPresets.json` holds separate camera views.

### Subsystems
- **Ring and tethers**: `tethers.js` (`TetherGeometry`, a catenary tether tree), `mainRingCurve.js`, `calcRingParam.js`, `tetheredRingSystem.js`.
- **Transit system**: `transitsystems.js`, plus per-object model files (`TransitVehicle.js`, `ElevatorCar.js`, `ElevatorCable.js`, `Habitat.js`, ring and tube segments).
- **Launcher**: `launcher.js` (the `launcher` class) and `launcherAnimate.js`. Trajectory maths is in `LaunchTrajectoryUtils.js`, `launchTrajectoryRocket.js`, `simRocketFlight.js` and `OrbitMath.js`. Hardware models are in `MassDriver*.js`, `AdaptiveNut.js`, `LaunchSled.js`, `LaunchVehicle.js`, `ScrewGeometry.js` and `SledGrapplerGeometry.js`. `EngineeringDetails.js` and `screwEngineering.js` hold engineering calculations. `datasets/StarshipIFT*.js` holds Starship flight telemetry used for comparison plots, which `ExtractedTelemetryLoader.js` and `XYChart.js` load and draw.
- **`tram.js`**: shared physics and geodesy utilities (`lla2xyz`/`xyz2lla`, WGS84 conversions, `getPlanetSpec`, spec calculations, `lerp`/`clamp`).
- **Curves**: `SuperCurve.js` and its subclasses (`CatmullRom`, `Circle`, `Ellipse`, `Line`, `Spiral`), plus `SuperCurvePath.js`, re-exported through `SuperCurves.js`. These extend Three.js curves with arc-length parameterisation and orientation frames. Trajectory and track geometry is built from them.

### Model / virtual-object pooling
Large repeated objects (rail segments, brackets, screws, vehicles) use a two-class pattern per file: a `xxxModel` class builds the Three.js mesh, and a `virtualXxx` class has static state (`className`, `unallocatedModels`, `refFrames`, `isDynamic`, `hasChanged`, `update()`, `addNewVirtualObjects()`). Virtual objects are placed along a curve inside a `referenceFrame` (`ReferenceFrame.js`), which is split into zones ("wedges"). Each frame, only virtual objects near the camera get a real mesh from the `unallocatedModels` pool, and they hand it back when the camera moves away. `transitsystems.js` and `launcher.js` run this allocate/free loop. `dynamicallymanagedobject.js` is the shared base for ring-relative objects.

### Planet renderers
- `planet.js`: the legacy renderer. Equirectangular and tiled textures from `textures/` (24x12 LR/HR tiles), plus optional XHR texture/displacement callbacks driven by presets.
- `planet2.js`: the newer cubed-sphere quadtree LOD renderer. It streams KTX2 tiles (transcoder in `basis/`) using a manifest in `assets/<body>/` (earth, moon, hawaii, chimborazo, and others). Turn it on with `nonGUIParams['usePlanet2'] = true` in a preset. Its header comment describes the face, UV and orientation conventions, which **must stay consistent with the Python generator**.
- `tools/`: offline Python pipeline that bakes planet2 assets (`generate_planet2_lod0_assets.py`, `adaptive_lod.py`, `bake_*`, `fetch_*`, `rebuild_manifest_from_disk.py`). `tools/build_planet2_assets.ps1` is the documented source of truth for rebuilding `assets/earth` (base bake → island cone → eastern fill, merged into one manifest). The scripts use argparse, so run them with `--help` to see options. They need numpy and Pillow, and KTX2 output needs external encoders.

### Output features
- **Video capture**: CCapture (`components/CCapture`). The resolution is hardcoded in the `startCapturingFramesButton` handler near the bottom of `main.js`. Number keys 0–3 track the launch vehicle, adaptive nut, transit vehicle and elevator car. The README has the ffmpeg encode steps.
- **KML export**: Google Earth export via `kmlutils.js` and the `genKMLFile` / `genLauncherKMLFile` flags. `googleEarthStudioTools.js` and `components/CameraControl/` handle Google Earth Studio camera paths and backgrounds.
- **Specs**: the `specs` object collects computed engineering figures (written out when `genSpecsFile` is set).
- **STL export**: `SaveGeometryAsSTL.js`.

## Conventions
- Code style is informal: 2-space indent, mostly no semicolons, and lots of commented-out alternatives and `ToDo` notes. Match the surrounding code and don't reformat files.
- Units are SI (metres, kg, seconds). Angles in `guidParamWithUnits` are usually degrees and get converted to radians in `dParamWithUnits`.
