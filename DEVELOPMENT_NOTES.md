# BETTER-PBR Development Notes

This file is the permanent engineering notebook for BETTER-PBR.

## Rule
Every time new code is added, changed, or replaced, add a note here describing **exactly what that code is supposed to do**, why it exists, and any important constraints or boundaries it must preserve.

The notes are documentation only. They do not contain executable plugin logic.

## Versioning Rule
- Use whole-number major versions only.
- Release progression is `1.0.0 -> 2.0.0 -> 3.0.0 -> 4.0.0 -> ...`.
- Do not create minor or patch releases such as `1.0.1` or `2.0.1`.

## File Architecture Rule
- `better_pbr.js` is the single plugin implementation file.
- Do not create old/versioned/nested copies of the implementation.
- Updates replace the existing implementation rather than adding another copy.
- This notes file is documentation and is intentionally separate from the executable plugin file.

## 2.0.0 — Current Foundation + MO

### MO — Mobile Optimization
**What the code is supposed to do:**
- Provide a toggleable mobile-optimization feature in the Blockbench Tools menu.
- When enabled, reduce texture sampling detail as the camera moves farther from the model, making distant textures progressively more pixelated.
- When disabled, restore the texture sampling settings captured before MO modified them.
- Avoid creating additional geometry or intentionally duplicating textures for the optimization.
- Keep update work throttled so camera movement does not cause expensive work every render tick.
- Only operate on accessible Blockbench preview/scene objects and fail safely when a scene or texture cannot be inspected.

**Important constraints:**
- MO is a rendering/sampling optimization only; it must not become part of the height-to-geometry system.
- Mobile/Android stability takes priority over visual complexity.
- Shared texture objects may affect multiple materials; this behavior must be considered before any future per-object filtering system is introduced.

### HeightGeometryFoundation
**What the code is supposed to do:**
- Establish the stable mathematical/data foundation for the future pipeline:
  `height map -> normalized height field -> proportional depth -> real geometry`.
- Accept supported image data and convert it into normalized grayscale height values from `0..1`.
- Downsample source data to a configurable mobile-safe maximum resolution instead of creating one geometry sample per source pixel.
- Preserve proportional depth: a height value of `0` maps to the low end of the configured depth range and `1` maps to the high end.
- Provide continuous bilinear sampling so future geometry does not have to be locked to integer image pixels.
- Provide optional smoothing, low/middle/high classification, connected low/high region analysis, resource budgeting, and cancellation support.
- Produce a validated processing plan that a future geometry adapter can consume.
- Keep all of this core logic independent from Blockbench's private mesh/geometry implementation details.

**Important boundary:**
- The foundation does **not** yet create the final Blockbench geometry.
- Future contour extraction, triangulation, extrusion/cutout behavior, wall construction, simplification, and geometry committing belong in later layers that consume this foundation.
- The foundation must remain stable while those later layers evolve.

## Future Note Format
For every future code change, append a new entry using this structure:

```md
## X.0.0 — Feature Name

### Component Name
**What the code is supposed to do:**
- Exact intended behavior.

**Important constraints:**
- Safety, compatibility, performance, or architectural boundaries.

**Integration:**
- What existing component consumes or calls this code.

**Not responsible for:**
- Explicitly state what this component must not do, when that boundary matters.
```

## Engineering Philosophy
The foundation must be finished strongly enough that future features can modify, extend, or replace adapters without forcing the core foundation to be rewritten because it was incomplete. If a later feature exposes a foundation weakness, the weakness should be documented and deliberately repaired rather than patched around blindly.
