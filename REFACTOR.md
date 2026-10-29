# Changes on the 2026-claude-refactor branch

Changes since the branch left `main`, in its final state (later work that replaced earlier work is described once). Features first, then bug fixes.

## Features

### Planet and terrain
- New cubed-sphere planet renderer streaming KTX2 terrain/imagery tiles from `assets/<body>/manifest.json`, baked by the Python pipeline in `tools/`; it is now the only planet renderer.
- High-resolution enhancement layers for Hawaii (Big Island) and Chimborazo, plus Moon terrain assets; lunar launch shots set up.
- Planet assets are tracked in Git LFS, pulled from Cloudflare R2 with read-only credentials in `.lfsconfig`.
- CDLOD edge morphing between terrain detail levels.
- Planet API (`Planet.js`): visibility, opacity, double-siding, displacement scale, `sampleTerrainHeight`, raycast; flat colour for bodies without assets.
- Terrain LOD refines by on-screen texel size (was half a tile), cutting a full-globe view from ~3,000 tiles to a few hundred.
- Tile skirts hide cracks between tiles at different detail levels (hidden while the camera is underground).
- KTX2 tile inspection page (`tests/ktx2-dump.html`): decode, stitch and seam statistics.

### Sea
- Sea surface per terrain tile, coloured from the imagery and ending at the imagery's coastline; mostly transparent with fine ripples and a sun glint.
- Underwater view: no sky under the surface, everything fades into the water colour with depth (`showOcean`, `underwaterVisibility`).
- From above, things under the sea darken with the length of the line of sight through the water (applied to every lit material).
- Sea floor drawn with a sediment colour and mild fractal noise instead of the imagery's black ocean.
- Submerged mass-driver tube held down by catenary mooring cables to anchors on the sea floor, every `launcherMassDriverMooringSpacing`.

### Sky, sun and atmosphere
- Atmosphere is a 60 km shell shaded by ray-marched single scattering (Rayleigh + Mie): blue sky, red sunsets, limb glow from space, no switch-over when descending.
- The sun is placed from `sunDayOfYear` and `sunTimeOfDayUTC` and moves with simulated time; left automatic, each preset gets a repeatable daytime.
- The sun is drawn (real 0.53 degree disc with glow), and the planet shows a day/night terminator.
- Stars come from a seeded random generator, so every machine sees the same sky.

### Ring and tethers
- The ring stays in one plane at `ringFinalAltitude` above sea level: a slightly elliptical section of the flattened planet (eccentricity ~0.09), not a circle on a sphere.
- Each tether is force-balanced where it is: the anchors of the two staggered tether sets are placed so they cancel gravity and the moving ring's centrifugal load at the local curvature.
- Tether planes turn about the local vertical (up to ~0.4 degrees) so the tethers also cancel the small along-ring forces; the ring has no other stiffness.
- Tether roots (below the first fork) follow their catenary of constant stress down to the actual terrain or sea floor, buoyant (flatter) below sea level.
- Tethers, elevator cables and mooring cables are drawn at their real diameters as faint cables composited over the background: dark against a bright sky, light against dark ground or space.
- Line glow scales with the square root of a strand's diameter and is held to `structureGlowDistance`; forks no longer brighten, and the structure still shows from space.
- Haze: tethers and cables fade with the air between the camera and the line, using the sky's density model.
- Distant tether forks merge into single strands with a strand count (big GPU saving at planet scale).
- Elevator cables are sized from the car load (`elevatorCarMass`, ~6 mm for 7.5 t), drawn only where there is land within 5 km of their foot, and reach the real ground.
- Presets whose cameras were recorded against the old sphere-height ring set `cameraAtRingHeight` and are moved with the ring.

### Launcher
- Screw thread starts where a grappler pad fits in the groove; before that the screw is a plain shaft and pads stay disengaged.
- Screws use the most thread starts a pad allows, doubling along the screw (even numbers only) up to `launcherMassDriverScrewThreadStarts`.
- Screw geometry is built in Web Workers; only screws that can be drawn get a model.
- Screen-space LOD (`PixelLOD`) for lift fans and screws; lift fans fade in by on-screen size instead of popping.
- Adaptive-nut grapplers batched into two `BatchedMesh`es; mass-driver brackets and distant screw cylinders drawn instanced.
- Distant tube segments drawn as 1 px lines, so Big Island uses its real tube size.
- Launches, grapplers and shockwaves are derived from simulated time (deterministic) on a shared virtual-object pooling base.
- Crew capsules on the transit system; new presets (underwater launcher, A-to-B launcher architecture, variable-speed screw, Moon launches).

### Transit system
- Ring segments drawn instanced; vehicles, cars and terminuses from model pools with deterministic, physically based motion.
- Transit objects are kept until they are under 1.5 px on screen instead of fixed 10-20 km ranges; elevator cables and the tube follow the horizon.

### Recording and shots
- In-browser video recording via WebCodecs (mediabunny): AV1 preferred, falling back to H.264/HEVC/VP9, into MP4 or MKV; no ffmpeg needed.
- Repeatable shots (`.shot.json`): camera keyframes and parameter changes, previewed, recorded live or rendered at a fixed time step.
- `SimClock` is the only source of simulated time; animations are pure functions of parameters and time, so shots reproduce on any machine.

### Performance and quality
- Graphics quality setting (`?quality=auto|high|balanced|low`): Auto lowers the render resolution while frames are slow; recording always renders at full quality.
- LOD uses real drawing-buffer pixels, so 4K and high-DPI screens get matching detail; moving between monitors triggers a resize.
- The 10 MB Starship telemetry dataset loads on demand (main bundle 8.4 MB to 1.07 MB).

### Architecture and tooling
- Source moved into `src/` by subsystem; `main.js` replaced by `App`, `CameraController`, `RingAssembly`, `ShotController` and a single keyboard-bindings table.
- Parameters are data (`parameterDefinitions.js`) held by a `ParameterStore`; presets are a registry selected by `?preset=` or the GUI.
- `tram.js` split into focused modules (geodesy, planets, ring geometry, transit, launcher physics); dead files removed.
- Vite 8, unused/vulnerable dependencies removed (npm audit clean), ESLint (`npm run lint`), unit tests (`npm test`).
- Cross-platform `npm run setup` (Git LFS + texture download) replaces `syncTextures.js`; commands documented for PowerShell and POSIX.
- Headless checks: `npm run smoke` (fails on console errors, can emulate 4K or a slow CPU) and `npm run profile` (per-subsystem CPU/GPU time, draw calls).
- `window.tetheredRing` debug handle for the console and automated tests.
- `docs/ARCHITECTURE.md` and `CLAUDE.md` describe the new structure.

## Bug fixes

### Physics and maths
- Geodesy conversions corrected (+Y is the pole), US76 and Mars atmosphere models fixed, with unit tests.
- Orbital elements: RAAN in the right quadrant; rocket simulation and XY chart bugs fixed.
- SuperCurve library: `LineSuperCurve3`, numeric sort, `atan2`, axis mutation, zone clamping, cached zone sampling and frame quaternions fixed.
- EngineeringDetails formulas: torque, spinning-disk speed limit, shell volume, rad/s, screw count and a divide-by-zero.
- Zero initial velocity or acceleration no longer gives an unbounded mass-driver length or screw tessellation.
- Screw thread continues correctly behind the nut's start (was straight flights and a divide-by-zero in pad geometry); screws tessellate per turn, not by length.
- Grapplers and flights no longer vanish on screws with wide pads, and the plain shaft no longer twists.

### Rendering
- Stars and the Moon were clipped by the far plane on real GPUs; they are drawn in their own sky pass.
- Float32 jitter near the camera removed: geometry and instance matrices are relative to a nearby origin (terrain tiles, brackets, tethers).
- Terrain LOD eviction and streaming: disposed descendants, re-linked parents, cancelled in-flight loads, per-frame priorities.
- Elevator cables and the transit tube no longer stop at a visible 500 km cut-off or pop in as the camera moves out.
- Tether bases floated up to 21 km above the ground off the equator (ring modelled on the equatorial sphere).

### App and export
- KML export: LineString output, tether concatenation and the main ring fixed.
- `movingRingsOrbit` crashed (force arrows built before tethers); gravity arrows no longer crash with tethers hidden.
- Presets with missing background images no longer abort start-up.
- Simulated time now advances during live takes (vehicles stood still).
- The app starts in current Chrome (JSON import assertion) and builds on case-sensitive file systems (`./Tram.js`).
- Navigation bug fixed; capture no longer starts automatically.
