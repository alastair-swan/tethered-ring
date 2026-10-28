# Architecture

The app is a Vite-bundled set of plain ES modules on top of Three.js. Everything is in metres, kilograms and seconds; the world origin is the planet centre.

## Layout

```
index.html            page shell (a canvas inside #simContainer)
src/main.js           bootstrap: reads URL parameters, creates App, exposes window.tetheredRing
src/app/              App (scene construction, per-frame loop, actions), RingAssembly, exports,
                      the Y-key launch trial sweep and F-key illustration settings
src/params/           parameterDefinitions.js (every tunable parameter, as data) and ParameterStore
src/ui/               ParameterGui (lil-gui panel generated from the parameter definitions)
src/presets/          presets.js (registry) and one file per larger preset
src/core/             SimClock (simulated time), ReferenceFrame (wedge-partitioned curves)
src/scene/            renderer, lighting, SkyPass (stars and Moon), overlays (logo, XYChart), backgrounds
src/planet/           Planet (public API) on CubedSpherePlanetRenderer (quadtree LOD terrain streaming)
src/ring/             tethered ring structure, tethers, markers, ring segments
src/transit/          transit vehicles, elevators, terminuses, habitats, solar arrays
src/launcher/         mass-driver launcher, trajectory and rocket simulation, launcher models
src/physics/          geodesy, planet specifications, atmosphere models
src/curves/           SuperCurve family (curves with arc-length and time parameterisations)
src/camera/           CameraController, ObjectTracker, modified OrbitControls, Google Earth playback
src/input/            keyboard shortcuts (one declarative table), VR controllers
src/shots/            shot file format, camera path interpolation, ShotController
src/capture/          VideoRecorder (WebCodecs via mediabunny)
src/shaders/          GLSL, imported with Vite's ?raw
src/utils/            math helpers; tram.js is a compatibility barrel re-exporting the split modules
src/data/             JSON data (camera presets, mountain list, sample Google Earth project)
assets/               planet terrain tiles (Git LFS)
textures/, models/    runtime imagery and 3D models (textures/ is downloaded by npm run setup)
tools/                offline Python pipeline that bakes assets/ (see tools/build_planet2_assets.ps1)
scripts/              setup, texture sync and headless smoke test (Node)
tests/                node --test unit tests and standalone test pages
```

## Startup

`App.init()` builds the scene in a fixed order:

1. **Parameters.** `ParameterStore` is created from `createParameterDefinitions()`, then the preset (`?preset=` or the default) runs. A preset edits parameter values and fills `nonGUIParams`, which hold construction-time options such as camera placement, terrain asset sets, lighting and shadows.
2. **Renderer and base scene.** The renderer uses a logarithmic depth buffer. The scene contains `planetCoordSys`, which holds everything fixed to the planet, plus the camera group, lighting, the sky pass and the overlays.
3. **Planet.** `Planet` streams `assets/<name>/` tile sets. The defaults come from the planet's name; a preset can override them.
4. **Ring.** `RingAssembly` builds one `tetheredRingSystem` per ring spec, plus its tethers and markers.
5. **Transit system and launcher.** Both are built against the primary ring's curve.
6. **Camera.** `CameraController` places the camera from the preset options.
7. **GUI, shots and input.**

## Parameters

`ParameterStore` keeps exactly one copy of each value, so nothing needs synchronising by hand:

- `store.definitions[name]` is `{ value, units, min, max, folder, onChange, ... }`. Presets edit these before the GUI is built.
- `store.values` is the object the GUI binds to. Its properties are accessors onto `definitions[name].value`.
- `store.derived` is what every subsystem reads (historically `dParamWithUnits`). `derive()` refreshes it: it copies `autoMap` values, converts the ring latitude to radians, interpolates the ring eccentricity and selects the material properties for the chosen fibre and conductor.

When a control changes, `ParameterGui` calls `derive()` and then the App handler named by the parameter's `onChange`:

| Handler | What it does |
|---|---|
| `adjustRingDesign` | Rebuilds the ring, then updates the transit system and launcher |
| `updateTransitsystem` | Updates the transit system only |
| `updateLauncher` | Updates the launcher only |
| Visibility and material handlers | Change one thing in place |

To add a parameter:

1. Add one line to `parameterDefinitions.js`.
2. Read it in the subsystem as `dParamWithUnits.name.value`.
3. Pick (or add) an `onChange` handler in `App.parameterHandlers()`.

## Simulated time and determinism

`SimClock` is the only source of time.

- **Interactive viewing:** each frame advances it by the real frame time, clamped so a backgrounded tab does not jump.
- **Recording:** it advances by exactly `1/fps` per frame.

Every animated system receives the simulation time in `animate(time, ...)`. Its state must be a pure function of the parameters and that time: no wall-clock time, no `Math.random()`, nothing that depends on how many frames were rendered. Anything that cannot be computed from time alone is exposed through `getAnimationState()` / `setAnimationState()` and stored in shot files. The star field uses a seeded random generator for the same reason.

## Per frame

`App.frame()` runs `clock.tick()`, then `step(dt)`, then `render()`.

`step` does the following, in order:

1. Ring raise/lower animation (parameter changes)
2. The Y-key launch trial sweep (when active)
3. `launchSystem.animate()` and `transitSystem.animate()`
4. `CameraController.update()`: tracking, tweens, zoom/climb and follow modes, then orbit controls and clipping planes
5. `planet.update(camera)`: level-of-detail selection and tile streaming
6. The shadow frustum follows the camera target

`render` draws four layers, clearing the depth buffer between them:

1. The sky pass: stars and the Moon, drawn with their own camera so the main camera's far plane can stay fitted to the planet
2. Any background image or Google Earth frame
3. The main scene
4. The screen-space overlays

During recording, `ShotController` stops the animation loop and calls `step()`/`render()` itself, one fixed step at a time.

## Large repeated objects

Rings, tubes, rails, screws and vehicles are spread along curves tens of thousands of kilometres long. Each moving or repeated object type is a *virtual object* placed at a curve parameter inside a `ReferenceFrame`. A reference frame splits its curve into "wedges" (zones). Each frame, only the wedges near the camera get real meshes, taken from a pool of models.

The object tracker walks `system.refFrames[i].wedges[j][className]` to find trackable objects, so vehicles and elevator cars must stay discoverable there. Each provides `getFuturePosition(refFrame, dt)` (and `getFutureFrame` for orientation).

## Floating-point precision

Three.js builds each object's model-view matrix in float64 on the CPU, but the GPU works in float32. At planet scale (6.4e6 m) a float32 has a resolution of about 0.5 m. Every mesh therefore keeps its vertex positions small, relative to a nearby origin, and puts the large offset in its `position`. That covers terrain tiles (relative to the tile centre), ring and track segments, the tethers and the trajectory line (in chunks). Do not create geometry with absolute planet coordinates. Shot camera paths are interpolated in float64 for the same reason.

## Shots and recording

The shot file format is documented at the top of `src/shots/ShotFormat.js`. A shot records:

- the preset id and a full parameter snapshot
- the simulated start time and animation state
- camera keyframes, interpolated smoothly or linearly by time
- tracks for any parameter that changes during the shot
- output settings

`ShotController` handles preview, live takes (sampling the camera pose every frame), fixed-step rendering and import/export.

`VideoRecorder` encodes the canvas with WebCodecs through mediabunny:

- AV1 is preferred; it falls back to H.264, then HEVC, then VP9.
- Output is MP4 or MKV.
- Recordings stream to disk where the File System Access API exists (Chrome, Edge) and are buffered in memory elsewhere.

## Testing

- `npm test` runs the unit tests: physics maths, the shot format and the camera path.
- `npm run lint` runs ESLint.
- `npm run smoke` loads the full app in headless Chrome/Chromium and fails on any console error. Use `SMOKE_GPU=1` with real hardware; the software renderer takes over a minute to decode a single terrain tile. `--eval "<js>"` runs code against `window.tetheredRing` and prints the result, and `--page /tests/planet.html` targets a standalone test page.
