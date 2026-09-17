/*
 * BETTER-PBR
 *
 * Foundation-first architecture:
 * - MO (Mobile Optimization) is the first user-facing feature.
 * - HeightGeometryFoundation is the stable core for the height-map pipeline.
 * - GeometryReconstructionEngine is the first real geometry consumer of that foundation.
 *
 * FOUNDATION RULE:
 * The foundation does not depend on Blockbench's private geometry internals.
 * It owns data validation, height normalization, sampling, smoothing,
 * proportional depth mapping, feature thresholds, budgets, cancellation,
 * and transaction planning. Geometry creation consumes the foundation plan
 * instead of changing its math.
 *
 * VERSION RULE:
 * - BETTER-PBR uses whole-number major versions only.
 * - Versions advance 1.0.0 -> 2.0.0 -> 3.0.0 -> 4.0.0, etc.
 * - No minor/patch version progression such as 1.0.1 or 2.0.1.
 *
 * UPDATE/INSTALL RULE:
 * - There is only one plugin implementation file: better_pbr.js.
 * - Updates replace this file instead of creating versioned/nested copies.
 * - The startup guard removes stale duplicate BETTER-PBR instances.
 */

(function() {
    'use strict';

    const PLUGIN_ID = 'better_pbr';
    const PLUGIN_VERSION = '3.0.0';
    const MO_STORAGE_KEY = 'better_pbr.mo.enabled';

    let moAction;
    let geometryAction;
    let updateTimer = null;
    let running = false;

    const originalTextureState = new WeakMap();

    /* --------------------------------------------------------------------- */
    /* HeightGeometryFoundation                                             */
    /* --------------------------------------------------------------------- */
    const HeightGeometryFoundation = (() => {
        const EPSILON = 1e-8;
        const DEFAULTS = Object.freeze({
            maxResolution: 128,
            maxVertices: 16384,
            maxFaces: 32768,
            depth: 1,
            baseDepth: 0,
            invert: false,
            smoothing: 0,
            lowThreshold: 0.25,
            highThreshold: 0.75,
            minimumFeatureSize: 1,
            wallWidth: 1,
            edgeSoftness: 0,
            mode: 'height_field'
        });

        class FoundationError extends Error {
            constructor(message, code) {
                super(message);
                this.name = 'FoundationError';
                this.code = code || 'FOUNDATION_ERROR';
            }
        }

        class CancellationToken {
            constructor() {
                this.cancelled = false;
            }
            cancel() {
                this.cancelled = true;
            }
            throwIfCancelled() {
                if (this.cancelled) {
                    throw new FoundationError('Geometry operation cancelled.', 'CANCELLED');
                }
            }
        }

        function clamp01(value) {
            value = Number(value);
            if (!Number.isFinite(value)) return 0;
            return Math.max(0, Math.min(1, value));
        }

        function positiveInt(value, fallback, max) {
            value = Math.floor(Number(value));
            if (!Number.isFinite(value) || value < 1) value = fallback;
            if (max) value = Math.min(value, max);
            return value;
        }

        function finiteNumber(value, fallback) {
            value = Number(value);
            return Number.isFinite(value) ? value : fallback;
        }

        function normalizeOptions(options) {
            options = options || {};
            const result = Object.assign({}, DEFAULTS, options);
            result.maxResolution = positiveInt(result.maxResolution, DEFAULTS.maxResolution, 512);
            result.maxVertices = positiveInt(result.maxVertices, DEFAULTS.maxVertices, 262144);
            result.maxFaces = positiveInt(result.maxFaces, DEFAULTS.maxFaces, 524288);
            result.depth = finiteNumber(result.depth, DEFAULTS.depth);
            result.baseDepth = finiteNumber(result.baseDepth, DEFAULTS.baseDepth);
            result.smoothing = clamp01(result.smoothing);
            result.lowThreshold = clamp01(result.lowThreshold);
            result.highThreshold = clamp01(result.highThreshold);
            if (result.highThreshold < result.lowThreshold) {
                const swap = result.lowThreshold;
                result.lowThreshold = result.highThreshold;
                result.highThreshold = swap;
            }
            result.minimumFeatureSize = Math.max(0, finiteNumber(result.minimumFeatureSize, DEFAULTS.minimumFeatureSize));
            result.wallWidth = Math.max(0, finiteNumber(result.wallWidth, DEFAULTS.wallWidth));
            result.edgeSoftness = clamp01(result.edgeSoftness);
            result.invert = !!result.invert;
            result.mode = ['height_field', 'regions', 'hybrid'].includes(result.mode)
                ? result.mode
                : DEFAULTS.mode;
            return Object.freeze(result);
        }

        function sourceToGray(source) {
            if (!source) throw new FoundationError('A height-map source is required.', 'NO_SOURCE');

            if (source.data && Number.isInteger(source.width) && Number.isInteger(source.height)) {
                return {
                    data: source.data,
                    width: source.width,
                    height: source.height,
                    channels: source.channels || 4
                };
            }

            if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement ||
                typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
                const canvas = document.createElement('canvas');
                canvas.width = source.naturalWidth || source.width;
                canvas.height = source.naturalHeight || source.height;
                if (!canvas.width || !canvas.height) {
                    throw new FoundationError('Height-map image has no usable dimensions.', 'BAD_IMAGE');
                }
                const context = canvas.getContext('2d', {willReadFrequently: true});
                if (!context) throw new FoundationError('Could not create a 2D image reader.', 'NO_2D_CONTEXT');
                context.drawImage(source, 0, 0, canvas.width, canvas.height);
                const image = context.getImageData(0, 0, canvas.width, canvas.height);
                return {data: image.data, width: image.width, height: image.height, channels: 4};
            }

            throw new FoundationError('Unsupported height-map source.', 'BAD_SOURCE');
        }

        class HeightField {
            constructor(width, height, values, metadata) {
                if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
                    throw new FoundationError('Invalid height-field dimensions.', 'BAD_DIMENSIONS');
                }
                if (!values || values.length !== width * height) {
                    throw new FoundationError('Height-field data does not match its dimensions.', 'BAD_DATA');
                }
                this.width = width;
                this.height = height;
                this.values = values instanceof Float32Array ? values : Float32Array.from(values);
                this.metadata = Object.assign({
                    sourceWidth: width,
                    sourceHeight: height,
                    colorSpace: 'linear-luminance',
                    normalized: true
                }, metadata || {});
            }

            index(x, y) {
                return y * this.width + x;
            }

            get(x, y) {
                x = Math.max(0, Math.min(this.width - 1, x | 0));
                y = Math.max(0, Math.min(this.height - 1, y | 0));
                return this.values[this.index(x, y)];
            }

            sample(u, v) {
                u = clamp01(u);
                v = clamp01(v);
                const fx = u * (this.width - 1);
                const fy = v * (this.height - 1);
                const x0 = Math.floor(fx);
                const y0 = Math.floor(fy);
                const x1 = Math.min(x0 + 1, this.width - 1);
                const y1 = Math.min(y0 + 1, this.height - 1);
                const tx = fx - x0;
                const ty = fy - y0;
                const a = this.get(x0, y0);
                const b = this.get(x1, y0);
                const c = this.get(x0, y1);
                const d = this.get(x1, y1);
                return a + (b - a) * tx + (c - a) * ty + (d - a - (b - a)) * tx * ty;
            }

            clone() {
                return new HeightField(this.width, this.height, new Float32Array(this.values), this.metadata);
            }
        }

        function luminance(r, g, b) {
            return clamp01((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255);
        }

        function fromSource(source, options) {
            options = normalizeOptions(options);
            const raw = sourceToGray(source);
            const target = Math.min(options.maxResolution, Math.max(raw.width, raw.height));
            const scale = target / Math.max(raw.width, raw.height);
            const width = Math.max(1, Math.round(raw.width * scale));
            const height = Math.max(1, Math.round(raw.height * scale));
            const values = new Float32Array(width * height);
            const channels = raw.channels || 4;

            for (let y = 0; y < height; y++) {
                const sy = Math.min(raw.height - 1, Math.floor((y / height) * raw.height));
                for (let x = 0; x < width; x++) {
                    const sx = Math.min(raw.width - 1, Math.floor((x / width) * raw.width));
                    const i = (sy * raw.width + sx) * channels;
                    let value;
                    if (channels === 1) {
                        value = clamp01(Number(raw.data[i]) / 255);
                    } else {
                        value = luminance(raw.data[i], raw.data[i + 1], raw.data[i + 2]);
                    }
                    values[y * width + x] = options.invert ? 1 - value : value;
                }
            }

            return new HeightField(width, height, values, {
                sourceWidth: raw.width,
                sourceHeight: raw.height,
                downsampled: width !== raw.width || height !== raw.height,
                inverted: options.invert
            });
        }

        function smooth(field, amount, token) {
            amount = clamp01(amount);
            if (!amount) return field;
            const source = field.values;
            const output = new Float32Array(source.length);
            const radius = amount < 0.34 ? 1 : amount < 0.67 ? 2 : 3;

            for (let y = 0; y < field.height; y++) {
                if (token && (y & 7) === 0) token.throwIfCancelled();
                for (let x = 0; x < field.width; x++) {
                    let sum = 0;
                    let count = 0;
                    for (let oy = -radius; oy <= radius; oy++) {
                        for (let ox = -radius; ox <= radius; ox++) {
                            const distance = Math.sqrt(ox * ox + oy * oy);
                            if (distance > radius) continue;
                            sum += field.get(x + ox, y + oy);
                            count++;
                        }
                    }
                    const blurred = count ? sum / count : source[field.index(x, y)];
                    output[field.index(x, y)] = source[field.index(x, y)] * (1 - amount) + blurred * amount;
                }
            }
            return new HeightField(field.width, field.height, output, field.metadata);
        }

        function depthAt(field, u, v, options) {
            options = normalizeOptions(options);
            const h = field.sample(u, v);
            return options.baseDepth + h * options.depth;
        }

        function classify(field, options, token) {
            options = normalizeOptions(options);
            const classes = new Uint8Array(field.values.length);
            for (let y = 0; y < field.height; y++) {
                if (token && (y & 15) === 0) token.throwIfCancelled();
                for (let x = 0; x < field.width; x++) {
                    const value = field.get(x, y);
                    let kind = 1;
                    if (value <= options.lowThreshold) kind = 0;
                    else if (value >= options.highThreshold) kind = 2;
                    classes[field.index(x, y)] = kind;
                }
            }
            return classes;
        }

        function countRegionCells(field, classes, classId, token) {
            const visited = new Uint8Array(field.values.length);
            const regions = [];
            const queueX = new Int32Array(field.values.length);
            const queueY = new Int32Array(field.values.length);

            for (let y = 0; y < field.height; y++) {
                if (token && (y & 15) === 0) token.throwIfCancelled();
                for (let x = 0; x < field.width; x++) {
                    const start = field.index(x, y);
                    if (visited[start] || classes[start] !== classId) continue;

                    let head = 0;
                    let tail = 0;
                    queueX[tail] = x;
                    queueY[tail++] = y;
                    visited[start] = 1;
                    let count = 0;
                    let minX = x, maxX = x, minY = y, maxY = y;

                    while (head < tail) {
                        const cx = queueX[head];
                        const cy = queueY[head++];
                        count++;
                        minX = Math.min(minX, cx);
                        maxX = Math.max(maxX, cx);
                        minY = Math.min(minY, cy);
                        maxY = Math.max(maxY, cy);

                        const nx0 = cx - 1, nx1 = cx + 1, ny0 = cy - 1, ny1 = cy + 1;
                        const neighbors = [nx0, nx1, cx, cx];
                        const neighborY = [cy, cy, ny0, ny1];
                        for (let n = 0; n < 4; n++) {
                            const nx = neighbors[n];
                            const ny = neighborY[n];
                            if (nx < 0 || ny < 0 || nx >= field.width || ny >= field.height) continue;
                            const ni = field.index(nx, ny);
                            if (visited[ni] || classes[ni] !== classId) continue;
                            visited[ni] = 1;
                            queueX[tail] = nx;
                            queueY[tail++] = ny;
                        }
                    }

                    regions.push({
                        id: regions.length,
                        classId,
                        cells: count,
                        minX,
                        maxX,
                        minY,
                        maxY,
                        width: maxX - minX + 1,
                        height: maxY - minY + 1
                    });
                }
            }
            return regions;
        }

        function estimateBudget(field, options) {
            options = normalizeOptions(options);
            const samples = Math.min(field.width * field.height, options.maxVertices);
            const side = Math.max(1, Math.floor(Math.sqrt(samples)));
            const width = Math.min(field.width, side);
            const height = Math.min(field.height, Math.max(1, Math.floor(samples / width)));
            const vertices = width * height;
            const faces = Math.max(0, (width - 1) * (height - 1) * 2);
            return {
                requestedSamples: field.width * field.height,
                plannedWidth: width,
                plannedHeight: height,
                estimatedVertices: vertices,
                estimatedFaces: faces,
                withinVertexBudget: vertices <= options.maxVertices,
                withinFaceBudget: faces <= options.maxFaces,
                safe: vertices <= options.maxVertices && faces <= options.maxFaces
            };
        }

        function buildPlan(source, options, token) {
            options = normalizeOptions(options);
            token = token || new CancellationToken();
            token.throwIfCancelled();
            let field = fromSource(source, options);
            token.throwIfCancelled();
            field = smooth(field, options.smoothing, token);
            token.throwIfCancelled();
            const classes = classify(field, options, token);
            const budget = estimateBudget(field, options);
            if (!budget.safe) {
                throw new FoundationError('Geometry budget exceeds the configured mobile-safe limit.', 'BUDGET_EXCEEDED');
            }
            const lowRegions = countRegionCells(field, classes, 0, token);
            const highRegions = countRegionCells(field, classes, 2, token);
            return Object.freeze({
                version: 1,
                field,
                classes,
                options,
                budget,
                regions: Object.freeze({
                    low: Object.freeze(lowRegions),
                    high: Object.freeze(highRegions)
                }),
                depthAt: (u, v) => depthAt(field, u, v, options)
            });
        }

        return Object.freeze({
            VERSION: 1,
            DEFAULTS,
            FoundationError,
            CancellationToken,
            HeightField,
            normalizeOptions,
            fromSource,
            smooth,
            depthAt,
            classify,
            estimateBudget,
            buildPlan,
            constants: Object.freeze({EPSILON})
        });
    })();

    /* --------------------------------------------------------------------- */
    /* GeometryReconstructionEngine                                          */
    /* --------------------------------------------------------------------- */
    // Version 3.0.0 deliberately implements one simple, auditable geometry
    // path first: a proportional height-field surface. Region-aware walls,
    // cavities and hybrid reconstruction remain extension points for DUFP.
    const GeometryReconstructionEngine = (() => {
        const VERSION = 1;

        function chooseGrid(plan) {
            const maxVertices = plan.options.maxVertices;
            const field = plan.field;
            const maxSide = Math.max(2, Math.floor(Math.sqrt(maxVertices)));
            let width = Math.min(field.width, maxSide);
            let height = Math.min(field.height, Math.max(2, Math.floor(maxVertices / width)));
            while (width * height > maxVertices && height > 2) height--;
            while (width * height > maxVertices && width > 2) width--;
            return {width: Math.max(2, width), height: Math.max(2, height)};
        }

        function buildSurface(plan, token) {
            if (!plan || !plan.field || !plan.options) {
                throw new HeightGeometryFoundation.FoundationError('A valid foundation plan is required.', 'NO_PLAN');
            }
            token = token || new HeightGeometryFoundation.CancellationToken();
            token.throwIfCancelled();

            const grid = chooseGrid(plan);
            const vertices = {};
            const faces = [];
            const width = grid.width;
            const height = grid.height;
            const xScale = width > 1 ? 16 / (width - 1) : 16;
            const zScale = height > 1 ? 16 / (height - 1) : 16;

            for (let y = 0; y < height; y++) {
                if ((y & 7) === 0) token.throwIfCancelled();
                const v = y / (height - 1);
                for (let x = 0; x < width; x++) {
                    const u = x / (width - 1);
                    const key = `v${y * width + x}`;
                    vertices[key] = [
                        u * 16,
                        plan.depthAt(u, v),
                        v * 16
                    ];
                }
            }

            for (let y = 0; y < height - 1; y++) {
                if ((y & 15) === 0) token.throwIfCancelled();
                for (let x = 0; x < width - 1; x++) {
                    const a = `v${y * width + x}`;
                    const b = `v${y * width + x + 1}`;
                    const c = `v${(y + 1) * width + x + 1}`;
                    const d = `v${(y + 1) * width + x}`;
                    faces.push({
                        vertices: [a, b, c, d],
                        uv: {
                            [a]: [uCoord(x, width), 16 - vCoord(y, height)],
                            [b]: [uCoord(x + 1, width), 16 - vCoord(y, height)],
                            [c]: [uCoord(x + 1, width), 16 - vCoord(y + 1, height)],
                            [d]: [uCoord(x, width), 16 - vCoord(y + 1, height)]
                        }
                    });
                }
            }

            return Object.freeze({
                version: VERSION,
                mode: 'height_field_surface',
                width,
                height,
                vertices: Object.freeze(vertices),
                faces: Object.freeze(faces),
                vertexCount: width * height,
                faceCount: faces.length
            });
        }

        function uCoord(index, size) {
            return size > 1 ? (index / (size - 1)) * 16 : 0;
        }

        function vCoord(index, size) {
            return size > 1 ? (index / (size - 1)) * 16 : 0;
        }

        function createBlockbenchMesh(surface, texture) {
            if (typeof Mesh === 'undefined' || typeof MeshFace === 'undefined') {
                throw new HeightGeometryFoundation.FoundationError('Blockbench Mesh APIs are unavailable.', 'MESH_API_UNAVAILABLE');
            }

            const mesh = new Mesh({
                name: 'BETTER-PBR Height Surface',
                vertices: surface.vertices,
                origin: [0, 0, 0],
                rotation: [0, 0, 0],
                shading: 'smooth',
                visibility: true
            }).init();

            const faceObjects = surface.faces.map(face => new MeshFace(mesh, {
                vertices: face.vertices,
                uv: face.uv
            }));
            mesh.addFaces(...faceObjects);
            if (texture && typeof mesh.applyTexture === 'function') {
                mesh.applyTexture(texture);
            }
            mesh.addTo('root');
            if (typeof mesh.calculateNormals === 'function') mesh.calculateNormals();
            if (typeof Canvas !== 'undefined' && Canvas.updateView) {
                Canvas.updateView({
                    elements: [mesh],
                    element_aspects: {geometry: true, faces: true, uv: true},
                    selection: true
                });
            }
            return mesh;
        }

        return Object.freeze({VERSION, chooseGrid, buildSurface, createBlockbenchMesh});
    })();

    if (typeof globalThis !== 'undefined') {
        globalThis.BETTER_PBR = globalThis.BETTER_PBR || {};
        globalThis.BETTER_PBR.HeightGeometryFoundation = HeightGeometryFoundation;
        globalThis.BETTER_PBR.GeometryReconstructionEngine = GeometryReconstructionEngine;
    }

    /* --------------------------------------------------------------------- */
    /* Height -> 3D action                                                  */
    /* --------------------------------------------------------------------- */

    function getSelectedTextureSource() {
        if (typeof Texture === 'undefined') return null;
        const texture = Texture.selected;
        if (!texture) return null;
        const canvas = texture.canvas || (typeof texture.getActiveCanvas === 'function' && texture.getActiveCanvas().canvas);
        if (!canvas) return null;
        return {texture, source: canvas};
    }

    function reconstructSelectedTexture() {
        const selected = getSelectedTextureSource();
        if (!selected) {
            Blockbench.showQuickMessage('BETTER-PBR: select a texture first.');
            return;
        }
        const token = new HeightGeometryFoundation.CancellationToken();
        const options = HeightGeometryFoundation.normalizeOptions({
            maxResolution: Blockbench.isMobile ? 64 : 128,
            maxVertices: Blockbench.isMobile ? 4096 : 16384,
            maxFaces: Blockbench.isMobile ? 8192 : 32768,
            depth: 4,
            baseDepth: 0,
            smoothing: 0,
            mode: 'height_field'
        });

        try {
            const plan = HeightGeometryFoundation.buildPlan(selected.source, options, token);
            const surface = GeometryReconstructionEngine.buildSurface(plan, token);

            if (typeof Undo !== 'undefined' && Undo.initEdit) {
                Undo.initEdit({elements: [], outliner: true, selection: true});
            }

            try {
                const mesh = GeometryReconstructionEngine.createBlockbenchMesh(surface, selected.texture);
                if (typeof Undo !== 'undefined' && Undo.finishEdit) {
                    Undo.finishEdit('BETTER-PBR: Height to 3D');
                }
                Blockbench.showQuickMessage(`BETTER-PBR: created ${surface.vertexCount} vertices / ${surface.faceCount} faces`);
                return mesh;
            } catch (error) {
                if (typeof Undo !== 'undefined' && Undo.cancelEdit) Undo.cancelEdit(true);
                throw error;
            }
        } catch (error) {
            console.error('BETTER-PBR height reconstruction failed:', error);
            Blockbench.showQuickMessage(`BETTER-PBR: ${error.message || 'height reconstruction failed'}`);
        }
    }

    /* --------------------------------------------------------------------- */
    /* MO — Mobile Optimization                                             */
    /* --------------------------------------------------------------------- */

    function isEnabled() {
        try {
            return localStorage.getItem(MO_STORAGE_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function setEnabled(value) {
        try {
            localStorage.setItem(MO_STORAGE_KEY, value ? '1' : '0');
        } catch (e) {}
    }

    function getThree() {
        return typeof THREE !== 'undefined' ? THREE : null;
    }

    function getPreviews() {
        if (typeof Preview === 'undefined') return [];
        if (Array.isArray(Preview.all) && Preview.all.length) return Preview.all;
        return Preview.selected ? [Preview.selected] : [];
    }

    function getScene(preview) {
        if (typeof Canvas !== 'undefined' && Canvas.scene) return Canvas.scene;
        if (preview && preview.scene) return preview.scene;
        return null;
    }

    function getModelCenter(scene, THREE_) {
        if (!scene || !THREE_) return null;
        const box = new THREE_.Box3();
        let found = false;
        scene.traverse(object => {
            if (!object || !object.visible) return;
            if (!object.isMesh && !object.isSkinnedMesh) return;
            if (!object.geometry) return;
            box.expandByObject(object);
            found = true;
        });
        if (!found || box.isEmpty()) return null;
        return box.getCenter(new THREE_.Vector3());
    }

    function distanceToModel(preview, scene, THREE_) {
        if (!preview || !preview.camera || !THREE_) return Infinity;
        const center = getModelCenter(scene, THREE_);
        if (!center) return Infinity;
        return preview.camera.position.distanceTo(center);
    }

    function filterLevel(distance) {
        if (distance < 24) return 0;
        if (distance < 48) return 1;
        if (distance < 96) return 2;
        if (distance < 192) return 3;
        return 4;
    }

    function rememberTexture(texture) {
        if (!texture || originalTextureState.has(texture)) return;
        originalTextureState.set(texture, {
            minFilter: texture.minFilter,
            magFilter: texture.magFilter,
            anisotropy: texture.anisotropy,
            generateMipmaps: texture.generateMipmaps
        });
    }

    function restoreTexture(texture) {
        const state = originalTextureState.get(texture);
        if (!state) return;
        texture.minFilter = state.minFilter;
        texture.magFilter = state.magFilter;
        texture.anisotropy = state.anisotropy;
        texture.generateMipmaps = state.generateMipmaps;
        texture.needsUpdate = true;
        originalTextureState.delete(texture);
    }

    function applyFilter(texture, level, THREE_) {
        if (!texture || !THREE_) return;
        rememberTexture(texture);
        if (level === 0) {
            restoreTexture(texture);
            return;
        }
        texture.generateMipmaps = true;
        texture.minFilter = THREE_.NearestMipmapNearestFilter;
        texture.magFilter = level >= 3 ? THREE_.NearestFilter : THREE_.LinearFilter;
        if ('anisotropy' in texture) texture.anisotropy = 1;
        texture.needsUpdate = true;
    }

    function walkMaterials(scene, callback) {
        if (!scene) return;
        scene.traverse(object => {
            if (!object || !object.material) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach(material => {
                if (!material) return;
                callback(material.map);
                callback(material.normalMap);
                callback(material.roughnessMap);
                callback(material.metalnessMap);
                callback(material.aoMap);
                callback(material.emissiveMap);
                callback(material.alphaMap);
                callback(material.bumpMap);
                callback(material.displacementMap);
            });
        });
    }

    function updateMO() {
        if (!running || !isEnabled()) return;
        const THREE_ = getThree();
        if (!THREE_) return;
        getPreviews().forEach(preview => {
            const scene = getScene(preview);
            if (!scene) return;
            const distance = distanceToModel(preview, scene, THREE_);
            const level = filterLevel(distance);
            walkMaterials(scene, texture => applyFilter(texture, level, THREE_));
        });
    }

    function scheduleUpdate() {
        if (!running || !isEnabled()) return;
        if (updateTimer) return;
        updateTimer = setTimeout(() => {
            updateTimer = null;
            updateMO();
        }, 80);
    }

    function restoreAllTextures() {
        getPreviews().forEach(preview => {
            const scene = getScene(preview);
            walkMaterials(scene, texture => {
                if (texture) restoreTexture(texture);
            });
        });
    }

    function setMO(value) {
        setEnabled(value);
        if (moAction) moAction.setIcon(value ? 'phone_android' : 'phone_disabled');
        if (value) {
            updateMO();
            Blockbench.showQuickMessage('MO: Mobile Optimization ON');
        } else {
            restoreAllTextures();
            Blockbench.showQuickMessage('MO: Mobile Optimization OFF');
        }
    }

    function cleanupDuplicateInstances() {
        if (typeof Plugins === 'undefined' || !Array.isArray(Plugins.all)) return;
        const current = Plugins.registered && Plugins.registered[PLUGIN_ID];
        Plugins.all.slice().forEach(plugin => {
            if (!plugin || plugin === current || plugin.id !== PLUGIN_ID) return;
            try { plugin.unload(); } catch (e) { console.warn('BETTER-PBR: failed to unload stale instance', e); }
            try { Plugins.all.remove(plugin); }
            catch (e) {
                const index = Plugins.all.indexOf(plugin);
                if (index !== -1) Plugins.all.splice(index, 1);
            }
        });
    }

    Plugin.register(PLUGIN_ID, {
        title: 'BETTER-PBR',
        author: 'yamasung7-dot',
        description: 'Generic-first PBR, height-to-geometry foundation, and MO mobile optimization.',
        icon: 'speed',
        version: PLUGIN_VERSION,
        variant: 'both',
        min_version: '4.0.0',
        repository: 'https://github.com/yamasung7-dot/BETTER-PBR',

        onload() {
            cleanupDuplicateInstances();
            running = true;

            moAction = new Action('better_pbr_mo', {
                name: 'MO — Mobile Optimization',
                description: 'Toggle mobile optimization. Farther camera distance uses more pixelated texture filtering to reduce GPU work.',
                icon: isEnabled() ? 'phone_android' : 'phone_disabled',
                click() { setMO(!isEnabled()); }
            });

            geometryAction = new Action('better_pbr_height_to_3d', {
                name: 'BETTER-PBR — Height to 3D',
                description: 'Convert the selected texture into a mobile-safe proportional height-field mesh.',
                icon: 'landscape',
                click: reconstructSelectedTexture
            });

            if (MenuBar && MenuBar.menus && MenuBar.menus.tools) {
                MenuBar.menus.tools.addAction(moAction);
                MenuBar.menus.tools.addAction(geometryAction);
            }

            Blockbench.on('update_camera_position', scheduleUpdate);
            Blockbench.on('render_frame', scheduleUpdate);
            Blockbench.on('update_view', scheduleUpdate);
            Blockbench.on('load_project', scheduleUpdate);
            Blockbench.on('new_project', scheduleUpdate);

            if (isEnabled()) scheduleUpdate();
        },

        onunload() {
            running = false;
            if (updateTimer) {
                clearTimeout(updateTimer);
                updateTimer = null;
            }
            Blockbench.removeListener('update_camera_position', scheduleUpdate);
            Blockbench.removeListener('render_frame', scheduleUpdate);
            Blockbench.removeListener('update_view', scheduleUpdate);
            Blockbench.removeListener('load_project', scheduleUpdate);
            Blockbench.removeListener('new_project', scheduleUpdate);
            restoreAllTextures();
            if (moAction) moAction.delete();
            if (geometryAction) geometryAction.delete();
            moAction = null;
            geometryAction = null;
        }
    });
})();
