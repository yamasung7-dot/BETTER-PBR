/*
 * BETTER-PBR
 * First feature: MO (Mobile Optimization)
 *
 * MO is a lightweight viewport optimization layer for Blockbench.
 * When enabled, textures use increasingly aggressive nearest-mipmap
 * filtering as the camera moves farther from the model. This makes
 * distant surfaces visibly more pixelated while reducing texture
 * filtering work on mobile GPUs.
 *
 * IMPORTANT UPDATE/INSTALL RULE:
 * - There is only one plugin file: better_pbr.js.
 * - The version is embedded in this file.
 * - The startup guard removes stale duplicate BETTER-PBR instances before
 *   the current copy starts, preventing old copies from running alongside it.
 */

(function() {
    'use strict';

    const PLUGIN_ID = 'better_pbr';
    const PLUGIN_VERSION = '0.1.1';
    const MO_STORAGE_KEY = 'better_pbr.mo.enabled';

    let moAction;
    let updateTimer = null;
    let running = false;

    // Keep original texture sampling settings so MO can be disabled cleanly.
    const originalTextureState = new WeakMap();

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
        } catch (e) {
            // Storage is optional. MO still works for the current session.
        }
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
        // The public Preview API exposes the renderer/camera; Canvas.scene is
        // available in Blockbench builds that expose the main scene directly.
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
        texture.magFilter = level >= 3
            ? THREE_.NearestFilter
            : THREE_.LinearFilter;

        if ('anisotropy' in texture) texture.anisotropy = 1;
        texture.needsUpdate = true;
    }

    function walkMaterials(scene, callback) {
        if (!scene) return;
        scene.traverse(object => {
            if (!object || !object.material) return;
            const materials = Array.isArray(object.material)
                ? object.material
                : [object.material];
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
        // Blockbench can temporarily have more than one Plugin object for a
        // remotely loaded URL. Keep the object currently registered for this
        // ID and unload any older BETTER-PBR instances so old code cannot run.
        if (typeof Plugins === 'undefined' || !Array.isArray(Plugins.all)) return;

        const current = Plugins.registered && Plugins.registered[PLUGIN_ID];
        Plugins.all.slice().forEach(plugin => {
            if (!plugin || plugin === current || plugin.id !== PLUGIN_ID) return;
            try {
                plugin.unload();
            } catch (e) {
                console.warn('BETTER-PBR: failed to unload stale instance', e);
            }
            try {
                Plugins.all.remove(plugin);
            } catch (e) {
                const index = Plugins.all.indexOf(plugin);
                if (index !== -1) Plugins.all.splice(index, 1);
            }
        });
    }

    Plugin.register(PLUGIN_ID, {
        title: 'BETTER-PBR',
        author: 'yamasung7-dot',
        description: 'Generic-first PBR and geometry tools with MO mobile optimization.',
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
                click() {
                    setMO(!isEnabled());
                }
            });

            if (MenuBar && MenuBar.menus && MenuBar.menus.tools) {
                MenuBar.menus.tools.addAction(moAction);
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
            moAction = null;
        }
    });
})();
