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
3. **Planet.** `Planet` streams `assets/<name>/` tile sets. The defaults come from the planet's name: the global set (`earth`, `moon`). A preset adds regional high-resolution bakes as overlays with `planetSetup` (`src/presets/planetSetup.js`), which also sets the larger streaming budgets they need and the areas to load first. A listed bake that is not on the machine, or is still a Git LFS pointer, is skipped and the tiles below it are used, so presets list every bake for their area, made or not. Imagery credits are shown for the tile sets that loaded. See `docs/ASSETS.md` for the bakes, how to make one (`tools/adaptive_lod.py`, `EARTH_REGIONS`), and how assets get into LFS.
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

## Ring height and tether forces

The ring is designed on a sphere of the planet's equatorial radius (`commonRingVariables`, `tethers.js`), then fitted to the real planet (`src/ring/ringGeometry.js`):

- **Shape.** `ringPlaneOffset` moves the ring's plane along its axis (least squares). `placeAtHeightInRingPlane` then moves each point within the plane, towards or away from the axis, to `ringFinalAltitude` above sea level. The ring stays planar at a constant height. It becomes a slightly elliptical section of the flattened planet (eccentricity about 0.09 for the default ring).
- **Forces.** The ring has no stiffness of its own; only the moving ring's hoop load, constrained by the tethers. So the tethers must cancel every force on each part of the ring, in all three directions.
  - The moving ring has one speed all the way round, found from the nominal circular design. Its centrifugal load per metre acts along the curve's normal and goes as the local curvature.
  - At each tether, `RingAssembly.ringForcesAt` finds the pull that cancels gravity and that load. It then turns the tether's vertical plane about the local vertical (up to about 0.4 degrees for the default ring) so that the plane holds the whole pull.
  - `balancedPointBxAvePercent` (in `tethers.js`) finds the anchor placement at which the two staggered tether types give that pull, keeping `tetherPointBxDeltaPercent`.
  - Tethers whose designs are within `TETHER_DESIGN_STEP` share geometry.
- **Roots.** The tether geometry stops at the first fork. Below it, each tether's root (`src/ring/TetherRoots.js`) follows its trunk's catenary of constant stress down until it meets the rendered terrain under it: mountains or sea floor. Below sea level the tether is buoyed up by the water, so it hangs as a flatter catenary (`seaWaterDensity`). The roots are re-checked a few per frame as terrain tiles stream in. A tether under tension cannot hang below its catenary's lowest point; any root whose ground is deeper than that ends there (`TetherRoots.unreachable`).
- **Camera placement.** Presets whose camera positions were recorded against the old sphere-height ring set `nonGUIParams.cameraAtRingHeight`. The camera and its target are moved as the ring moved.

## Large repeated objects

Rings, tubes, rails, screws and vehicles are spread along curves tens of thousands of kilometres long. Each moving or repeated object type is a *virtual object* placed at a curve parameter inside a `ReferenceFrame`. A reference frame splits its curve into "wedges" (zones). Each frame, only the wedges near the camera get real meshes, taken from a pool of models.

The object tracker walks `system.refFrames[i].wedges[j][className]` to find trackable objects, so vehicles and elevator cars must stay discoverable there. Each provides `getFuturePosition(refFrame, dt)` (and `getFutureFrame` for orientation).

## Level of detail and performance

Detail is chosen from projected size in drawing-buffer pixels, not distance:

- `src/scene/PixelLOD.js` is a `THREE.LOD` whose levels have pixel thresholds. three.js calls its `update(camera)` during rendering. Levels are built lazily; expensive builds are limited to a few milliseconds per frame (`PixelLOD.buildBudget`) except while recording. A level's factory may return a Promise (built in the background; the next coarser level shows meanwhile), and a level can ask to be prefetched before it is needed. While recording, everything is built synchronously so every frame is complete. `PixelLOD.viewportHeight` (set by `App.setRenderSize`) and `PixelLOD.lodBias` (set by the quality setting) feed the calculation.
- `src/scene/InstancedProxyPool.js` draws many identical objects with one `InstancedMesh` per detail level. The code that places them still works with ordinary `Object3D` proxies; `syncAll()` (called from `App.render`) copies visible, in-frustum proxies into instances relative to the camera.
- `src/app/GraphicsQuality.js` sets the pixel ratio, LOD bias and terrain threshold. In Auto mode it adapts the render resolution to the frame time. Recording forces full quality.

Where it is used:

| Object | Technique |
|---|---|
| Screws | PixelLOD per screw: three thread levels sampled per turn to a chord-error tolerance, then a cylinder; geometry shared by the left/right pair and built by Web Workers (`ScrewGeometryBuilder.js`, most urgent first, dropping builds for screws that have gone past); fast segments (up to a turn of thread) share one geometry per 0.1% of thread speed, rotated onto each segment; models handed out early enough for the first thread level to be ready (`modelRange`); objects changing size by over 25% a frame (screws flashing past a tracking camera) skip their expensive levels (`PixelLOD.fleetingRatio`) |
| Adaptive nut grapplers | Two sets of InstancedMeshes per nut (pads, hardware; one InstancedMesh per part shape) inside PixelLODs; placement skipped when not drawn |
| Lift fans | Instanced per chunk of 32 fans with full and low-poly levels; below 1.5 px each fan fades out by its on-screen size (`src/scene/SubPixelFade.js`) instead of popping in, and stops drawing at 0.3 px |
| Brackets | InstancedProxyPool with full and low-detail (4-segment arcs) shapes |
| Transit ring segments | Instanced layers (`src/ring/RingInstancedLayer.js`) |
| Planet | Screen-space texel error, edges matched to coarser neighbours (positions and heights) for crack-free LOD transitions, without skirts |
| Sea surface | A sea-level copy of each terrain tile that has ground below sea level, using the tile's own imagery (so the water has the local ocean colour and ends at the terrain's coastline); follows the tile's LOD and culling |
| Tethers | Each copy is a PixelLOD over variants with the last forks merged (the vertical fan to the rings first), used once the merged fan is under 0.1 px; a strand count keeps the combined light |
| Tethers and cables | Drawn at their real diameters (`src/scene/structureLines.js`). Each line is a faint cable of its colour covering part of its pixel, composited over what is behind it: it darkens a bright background (the day sky) and lightens a dark one, and overlapping lines hide each other instead of adding up, so the tethers do not brighten where they fork. The coverage is a glow, greatest for a structure's thickest member and less, as the square root of the diameter, for thinner ones, held out to `structureGlowDistance`. Sub-pixel strands sum to a visible structure. The coverage is reduced by the haze of the air between the camera and the line. Tether area is conserved at every fork. Tether roots reach the terrain at their anchors (see Ring height and tether forces); elevator cables are sized from the car load (`elevatorCarMass`) |
| Mass-driver tube | A 1 px line along the track once the tube is under a pixel across |

The launcher's reference frames split the track into a few hundred zones, each kilometres long. A virtual object class can define `static modelRange(pixelsPerRadian)` so that only objects within that distance of the camera get models (screws use the distance at which they shrink below their smallest drawn size).

### The screw thread model

The thread's phase along the screw comes from the adaptive nut's motion (`threadTime` and `threadSpeed` in `src/launcher/launcherPhysics.js`): the thread at each point matches the nut's speed as its centre passes. With constant acceleration, the unrolled flight is a quadratic in the thread angle. The screw geometry and the grappler pads both use these functions. The thread only starts where the groove between flights can hold a grappler pad plus its lift-away clearance (`threadStartDistance`, measured at the pad's inner edge); before that the screw is a plain shaft and pads stay disengaged.

The screw pulls the vehicle through the grapplers' magnetic coupling, and the coupling at its weakest limits the acceleration. The first aim is to keep the minimum number of grapplers gripping as high as possible; the average matters less, and hops themselves are cheap. The second aim is few gaps. A gap is either side of a gripping grappler where the neighbour on that side doesn't grip the same flight. Eddy currents are lost at each gap, and the faster the pads slide over the flights, the more each gap loses.

Which flight each grappler grips, and how it moves between them, is a pure function of the time since the nut's launch (`src/launcher/grapplerLattice.js`, one `GrapplerLatticePlan` per launch screw turn). Nothing is integrated from the launch: any moment can be shown without working up to it. Values are cached on a fixed time grid, but each is a pure function of its time.
- **Range.** A grappler can follow a flight across its range of motion: `adaptiveNutGrapplerMaxRangeOfMotion` turns either side of the middle of its travel, which is fixed to the nut and bounded by the screw's mount brackets.
- **The lattice.** The grapplers hold flights from one lattice of angles round the screw, `step` turns apart: the widest spacing of whole flights under the nut that fits in the travel, so every grappler always has a lattice flight within reach. Each holds the lattice flight nearest the middle of its travel. Neighbours therefore hold the same flight in runs, which end only where the drift of phase along the nut crosses half a step: as few runs as the spacing allows. When a flight drifts past half a step from the middle, the grappler hops to the next lattice flight, letting go half a hop's time before that moment and landing half a hop's time after.
- **Alone.** A grappler that would be alone on its flight is left free until a neighbour can join it.
- **Alignment.** Where the travel spans more than one flight spacing, there is more than one lattice (every second flight from the even or the odd ones, say). The one used has the fewest runs and free grapplers over the next 2 s. A change of lattice sweeps along the nut from front to back over 1 s, so the grapplers hop a few at a time where the old and new runs meet.
- **Narrow travel.** Where the travel is less than the spacing between flights, each grappler holds the nearest flight while it is within its travel, and is free in between.
- **Low speed.** At low speed the flights drift past fast and runs are short, so the grips are chained in layers instead (`src/launcher/grapplerLowSpeed.js`). The first layer keeps one grappler engaged from as early as one can be, starting with the grip that will last longest; before each grip lets go, the next has landed (the one lasting longest of those that can take over). Each further layer is another chain of the grips left free, so the guaranteed count rises: one, two, three... The lattice takes over at the earliest time from which its fewest engaged, for the rest of the run, is at least what the layers have kept engaged over the last hop: the guarantee never falls. The layers keep starting grips for two hops after that, and each grappler joins the lattice when its last grip from them ends (keeping its flight if that is its lattice flight).
- **Parking.** Grapplers that cannot grip are parked, raised and untwisted: those not on the thread yet, and those seeing flights that drift past faster than a hop can follow. They leave and rejoin the flights through the same movements.
- **Gaps.** How many runs there are is set by the screw. The grapplers sit in a line along it and the flights are helices, so the number of flights crossing the nut is `n · rps · nut length / speed`, and a run of neighbours on one flight ends at each crossing.

Between grips the grappler hops (`src/launcher/grapplerSwitchover.js`): detach, raise clear of the flights, untwist, move round, twist to the new flight, lower, attach. The movements overlap, each with its own smooth curve over the hop (`adaptiveNutGrapplerSwitchoverTime`, 0.6 s), so the pad never stops between them. While letting go, the pad slows to a stop short of the end of its travel.

`screwThreadLayout()` decides how many starts (flights) the screw has where. It always uses the most that leave room for a pad, in a doubling sequence that ends at `launcherMassDriverScrewThreadStarts` (for 8: 2, then 4, then 8; for 12: 6, then 12). The grapplers need an even number of flights, which also keeps the screw balanced, so every number in the sequence is even. Doubling keeps the existing flights and adds new ones halfway between them. Extra starts begin at a screw segment boundary, and each grappler uses the starts of the segment it is over, so screws and pads always agree. The launcher computes the layout once and shares it with the screws, the nuts and the specs.

Use `npm run profile` to measure a change (see the README).

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

## Sun, sky and atmosphere

- **Sun position.** `src/physics/solar.js` gives the subsolar point from the day of year and UTC time (NOAA approximation; effects longer than a year are ignored). `App.updateSun()` points the sun light along it every step, from the `sunDayOfYear` / `sunTimeOfDayUTC` parameters plus the simulated time. Left automatic, `App.resolveSunDate()` picks a repeatable daytime for the preset's opening view. Presets that place the sun themselves, and other bodies, keep their own.
- **Sun disc.** `SkyPass` draws the sun's disc and glow beyond the Moon. Seen through the air, the atmosphere shader draws it instead, because the sky is drawn over the sky pass.
- **Night side.** The planet's terrain and sea darken to 5% on the night side, with a soft twilight band (`CubedSpherePlanetRenderer._configureDaylight`). Objects keep their lighting, so they stay visible at night.
- **Atmosphere.** A shell 60 km above the ellipsoid, drawn from inside (its far side) and shaded per pixel by ray-marched single scattering (`src/shaders/atmosphere.frag.glsl`):
  - Rayleigh and Mie scattering with exponential density.
  - Sunlight attenuated along its path to each sample by the Chapman function.
  - Output is premultiplied over the background, dimmed by the air's transmittance, so stars fade by day.
  - From space it is the limb glow; from inside it is the sky. There is no switch-over between the two.
  - Like the sea fog, it is solved against the ellipsoid relative to the camera, with the large terms in float64 (`Planet.updateAtmosphere`).

## The sea

On planets with oceans (`planetSpec.hasOcean`), the planet renderer draws the sea surface from above (see the table above). `src/planet/Ocean.js` handles being in the sea. When the camera is below sea level and above the sea floor, there is no sky: the background is the water colour, which darkens with depth, and the underside of the surface is drawn around the camera. Things fade into the water colour by how far the line of sight travels through water (`underwaterVisibility`, a visual cue rather than realism). The evacuated tube has no water inside it, so `src/planet/waterFog.js` leaves out the part of the line of sight that is inside the tube. It models the tube as a cylinder along its direction at the point nearest the camera (`launcher.tubeNear`), relative to the camera, and solves per fragment in the fog shader chunks. From inside the tube, the tube is clear and the water beyond its walls is fogged; from outside, looking through the tube adds no fog for the stretch inside it.

The tube's wall is clear, with a faint surface (`src/launcher/tubeWallLook.js`): it is more opaque at grazing angles, as glass is, with faint streaks along it, soft mottling and panel joints every 12 m. The detail fades out below a pixel.

From above the sea, `src/planet/seaDarkening.js` fades things into dark water by the length of the line of sight that lies inside the sea, so the sea floor and the lower slopes of islands beyond the horizon do not show through the water. The disc around the camera also acts as an opaque underside for rays that dip under the surface. The fade is added to three.js's fog shader chunks, so every built-in material gets it, and its uniforms are shared by reference across materials. The sea surface and the sea floor use the same planet-anchored fractal noise (`src/planet/seaNoise.js`).

Where the mass-driver tube's centre is below sea level, `src/launcher/MooringCables.js` holds it down to the sea floor with inverted Vs of cables (`launcherMassDriverMooring*` parameters). There is one mooring every `launcherMassDriverMooringSpacing` metres, starting half a spacing in from the tube's end. Like the ring's tethers, each leg forks `launcherMassDriverMooringForkLevels` times on its way up: halfway up, then halfway along the rest, and so on, halving its cross-section each time. So one pair of anchors holds the tube at 2^levels points spread evenly over its spacing. The anchors use the streamed terrain heights and are re-checked as tiles load.
