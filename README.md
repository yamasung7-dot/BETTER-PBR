# BETTER-PBR

A generic-first Blockbench plugin for PBR-driven depth and future real-geometry reconstruction.

## Foundation-first architecture

BETTER-PBR is built around a **strong foundation before feature expansion**.

The height-map geometry system is intentionally separated into layers:

1. **Input** — accepts a generated height map without requiring a specific PBR generator.
2. **Normalization** — converts the source to one authoritative 0..1 grayscale height field.
3. **Sampling** — supports proportional/bilinear sampling instead of tying geometry directly to image pixels.
4. **Processing** — optional smoothing and height inversion happen before geometry planning.
5. **Classification** — identifies low/recessed, middle/slope, and high/raised areas.
6. **Region analysis** — records connected low/high regions so future basins, trenches, walls, cavities, and raised forms can use real regions rather than blindly moving every pixel into a vertex.
7. **Depth mapping** — converts normalized height into a configurable physical depth range.
8. **Budgeting** — estimates vertices/faces and refuses plans that exceed the configured safety budget.
9. **Cancellation** — long calculations can be cancelled without partially committing geometry.
10. **Geometry adapter boundary** — the foundation produces a stable plan; Blockbench-specific mesh creation is kept outside the core math.

This means future geometry modes can be added or replaced without rewriting the height-map foundation.

### Proportional depth model

The core depth rule is:

`depth = baseDepth + normalizedHeight × depthStrength`

So:

- black/0 = the low end of the depth range
- gray/0.5 = the proportional middle
- white/1 = the high end of the depth range
- gradients = continuous slopes
- sharp height transitions = potential walls/edges

The original color texture remains separate from the height calculation and can continue to provide the model's appearance/UVs when geometry reconstruction is implemented.

### Mobile safety

The foundation is designed for Android/mobile first:

- configurable maximum height-map resolution
- vertex and face budgets
- downsampling before expensive processing
- chunk-friendly processing points
- cancellation tokens
- no geometry is created by the foundation itself
- no one-vertex-per-original-pixel requirement
- no dependency on Blockbench's private mesh implementation

The foundation therefore does not make a risky geometry commit until a future geometry layer explicitly consumes its validated plan.

## First feature: MO

**MO = Mobile Optimization.**

MO is designed for Blockbench on phones/tablets and is toggleable from the **Tools** menu.

When MO is enabled:

- The preview watches the camera distance from the model.
- Close-up textures keep normal filtering.
- As the camera moves farther away, texture sampling switches to increasingly pixelated nearest-mipmap filtering.
- At the farthest levels, anisotropic filtering is reduced to 1 to avoid unnecessary mobile GPU work.
- MO does not rebuild model geometry just to create the distance effect.
- Disabling MO restores the texture sampling settings that were active before MO changed them.

## Versioning rule

BETTER-PBR uses **whole-number major versions only**.

The release sequence is:

**1.0.0 → 2.0.0 → 3.0.0 → 4.0.0 → ...**

We do not use patch/minor version progression such as `1.0.1`, `1.1.0`, or `2.0.1`. Every new BETTER-PBR version moves to the next whole-number major version.

## Update-safe single-file design

BETTER-PBR keeps the plugin implementation in **one file only**: `better_pbr.js`.

There are no versioned copies, nested old plugin folders, or `better_pbr_v1`, `better_pbr_v2`, etc. When the plugin is updated, the same file is replaced and its version is advanced according to the whole-number versioning rule above.

The plugin also contains a startup cleanup guard. If Blockbench has an older BETTER-PBR instance still present during a URL reinstall/reload, the current instance unloads the stale duplicate before starting. This prevents old and new copies from running together.

For a clean URL reinstall, uninstall BETTER-PBR first, then install the current `better_pbr.js` URL again. Blockbench's current URL loader requests remote plugins without using its normal browser cache, and uninstalling a remote plugin removes its cached local plugin file.

Current version: **2.0.0**

## Next stage

Once the foundation is proven in Blockbench, the next stage can add the actual geometry reconstruction/DUFP understanding layer. That layer can consume the validated height-field plan to create real raised areas, basins, trenches, walls, cavities, and hybrid forms while respecting the foundation's proportional depth and mobile budgets.
