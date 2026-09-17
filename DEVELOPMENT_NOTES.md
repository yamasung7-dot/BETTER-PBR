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

## 2.0.0 — Foundation + MO

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
- Produce a validated processing plan that a geometry reconstruction layer can consume.
- Keep all of this core logic independent from Blockbench's mesh/geometry implementation details.

**Important boundary:**
- The foundation does not create final Blockbench geometry.
- Contour extraction, triangulation, extrusion/cutout behavior, wall construction, simplification, and advanced DUFP decisions remain later layers.
- The foundation must remain stable while those layers evolve.

## 3.0.0 — First Geometry Reconstruction Engine

### GeometryReconstructionEngine
**What the code is supposed to do:**
- Consume a validated `HeightGeometryFoundation` plan without changing the foundation's height/depth math.
- Build the first real geometry representation from the height field using a simple indexed-style grid of Blockbench mesh vertices and quad faces.
- Map normalized height proportionally into the mesh's Y coordinate using the foundation's authoritative `depthAt()` function.
- Preserve a predictable 0..16 UV domain across the generated surface so the selected source texture can be applied to the reconstructed mesh.
- Choose a grid resolution from the foundation's configured vertex budget instead of blindly creating one vertex per source pixel.
- Check cancellation during vertex and face generation so a future progressive/mobile workflow can stop work safely.
- Provide a separate Blockbench adapter that commits the finished surface as a real `Mesh`, applies the selected texture, adds it to the root outliner, and requests a view update.

**Important constraints:**
- Version 3.0.0 intentionally implements only the simplest auditable reconstruction path: a proportional height-field surface.
- Mobile mode uses a lower reconstruction budget (`64` maximum source resolution and `4096` maximum vertices) for the first implementation.
- The engine must not create one vertex per 1024x1024 source pixel.
- Geometry creation is separated from the foundation so Blockbench-specific API changes do not force the mathematical foundation to be rewritten.
- The implementation is designed for generic image-based geometry, not only Minecraft vanilla blocks.

**Integration:**
- `HeightGeometryFoundation.buildPlan()` produces the validated input.
- `GeometryReconstructionEngine.buildSurface()` converts that plan into mesh data.
- `GeometryReconstructionEngine.createBlockbenchMesh()` is the Blockbench-specific commit adapter.
- The new Tools action `BETTER-PBR — Height to 3D` currently uses the selected texture's canvas as the height source so the reconstruction path can be exercised before the future PBR/DUFP height-map source is connected.

**Not responsible for:**
- It does not yet infer semantic regions such as trenches, cavities, walls, or raised islands.
- It does not yet perform contour extraction, marching-squares boundary reconstruction, polygon triangulation, region extrusion, or hybrid surface/region decisions.
- It does not yet generate a full PBR material or automatically produce a dedicated generated height map from the original texture.
- Those responsibilities belong to the next understanding/DUFP layers after this basic geometry path is validated.

### Blockbench Geometry Commit Adapter
**What the code is supposed to do:**
- Translate the engine's neutral surface representation into Blockbench's current `Mesh` and `MeshFace` APIs.
- Preserve the generated vertex positions and UV coordinates.
- Apply the selected texture to the generated mesh.
- Add the mesh to the root outliner and refresh the viewport.
- Wrap the creation in Blockbench's undo system so the generated object can be reverted.

**Important constraints:**
- The adapter is the only part of the new reconstruction path that directly depends on Blockbench mesh APIs.
- The adapter must fail with a controlled error when the required `Mesh`/`MeshFace` APIs are unavailable.
- No private Three.js scene object is used as the permanent model representation.

**Not responsible for:**
- It does not decide how height values are interpreted.
- It does not analyze the image or choose geometry strategies.
- It does not replace the foundation's budgets or cancellation rules.

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
