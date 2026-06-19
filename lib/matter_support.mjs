"use strict";

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import { MATTER_ACCESSORY_TYPES } from "./accessories/matter/index.mjs";
import {
  extractStatusEntries,
  getStatusValue,
  hasCode,
  mergeStatusArrays,
  pickSupportedCode,
  getNumericRangeForCode,
  rangeToPercent,
  percentToRange,
  percentToMatterLevel,
  matterLevelToPercent,
  percentToMatterSat,
  matterSatToPercent,
  degreesToMatterHue,
  matterHueToDegrees,
  colorTempPercentToMireds,
  miredsToColorTempPercent,
  toBoolean,
} from "./accessories/matter/_shared.mjs";

function deepEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function cloneJson(value, fallback = undefined) {
  if (value === undefined) {
    return fallback;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  return String(error?.message || error || "Unknown error");
}

function deviceTypeName(deviceType) {
  return (
    deviceType?.name ||
    deviceType?.deviceType ||
    deviceType?.code ||
    (typeof deviceType === "string" ? deviceType : null) ||
    null
  );
}

function normalizeDisplayName(value, fallback = null) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function partsSignature(parts) {
  return (Array.isArray(parts) ? parts : []).map((part) => ({
    id: part?.id ?? null,
    displayName: part?.displayName ?? null,
    deviceType: deviceTypeName(part?.deviceType),
  }));
}

function clampRetryCount(value, fallback = 2) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) {
    return fallback;
  }
  return Math.floor(count);
}

function isRetryableStateError(message) {
  return (
    message.includes("not found or not registered") ||
    message.includes("not registered") ||
    message.includes("not found")
  );
}

function disposeRuntimeValue(value) {
  if (!value) return;

  if (typeof value?.stop === "function") {
    try {
      value.stop();
    } catch {
      // ignore cleanup errors
    }
  }

  if (typeof value?.end === "function") {
    try {
      value.end();
    } catch {
      // ignore cleanup errors
    }
  }

  if (typeof value?.close === "function") {
    try {
      value.close();
    } catch {
      // ignore cleanup errors
    }
  }

  try {
    clearTimeout(value);
  } catch {
    // ignore cleanup errors
  }

  try {
    clearInterval(value);
  } catch {
    // ignore cleanup errors
  }
}

export default class TuyaMatterBridge {
constructor(platform) {
  this.platform = platform;
  this.api = platform.api;
  this.log = platform.log;
  this.pluginName = platform.PLUGIN_NAME;
  this.platformName = platform.PLATFORM_NAME;

  this.accessories = new Map();
  this.deviceIndex = new Map();
  this.latestDevices = new Map();

  this.pendingRegistrations = new Set();
  this.accessoriesToRegister = [];
  this.structureWarnings = new Set();
  this.runtimeBuckets = new Map();

  // UUIDs registered with the Matter framework during this process lifetime.
  // The framework throws on duplicate UUID registration, so this guards against
  // re-registering an accessory that was already restored early from cache.
  this.sessionRegistered = new Set();

  this.isBooting = false;

  // Bridge-managed UUID salt ledger (deviceId -> integer salt). Persisted to a
  // side file so it survives accessory removal (the Matter cache is wiped on
  // removal). Auto-incremented when a device returns after being removed, which
  // forces Apple Home to treat the returning device as brand-new and avoids the
  // "stuck/unmovable" state caused by reusing the deterministic UUID.
  this.salts = new Map();
  this.loadSalts();

  if (typeof this.api?.on === "function") {
    this.api.on("shutdown", () => {
      this.cleanup();
    });
  }
}

  isAvailable() {
    return typeof this.api?.isMatterAvailable === "function"
      ? this.api.isMatterAvailable()
      : Boolean(this.api?.matter);
  }

  isEnabled() {
    return typeof this.api?.isMatterEnabled === "function"
      ? this.api.isMatterEnabled()
      : Boolean(this.api?.matter);
  }

  uuidFor(deviceId) {
    const salt = this.getDeviceUUIDSalt(deviceId);
    const key = salt ? `tuya:${deviceId}:${salt}` : `tuya:${deviceId}`;
    return this.api.matter.uuid.generate(key);
  }

  getDeviceUUIDSalt(deviceId) {
    // Manual config override always wins (escape hatch for power users).
    const manual = this.getManualUUIDSalt(deviceId);
    if (manual != null) {
      return manual;
    }

    // Otherwise use the bridge-managed ledger value. Salt 0 (or absent) means
    // "no suffix" so existing devices keep their original UUID — do NOT change
    // this, or every paired device would re-pair on upgrade.
    const auto = this.salts.get(deviceId);
    if (auto && auto > 0) {
      return String(auto);
    }
    return null;
  }

  getManualUUIDSalt(deviceId) {
    const opts = this.platform.config?.options;
    const devices = opts?.troubleshooting?.devices ?? opts?.devices;
    if (!Array.isArray(devices)) return null;
    const entry = devices.find((d) => d?.deviceId === deviceId);
    const salt = entry?.uuidSalt;
    if (salt == null) return null;
    return String(salt);
  }

  saltsFilePath() {
    const base =
      typeof this.api?.user?.storagePath === "function"
        ? this.api.user.storagePath()
        : null;
    if (!base) return null;
    return join(base, "tuya-matter-salts.json");
  }

  loadSalts() {
    const file = this.saltsFilePath();
    if (!file) return;

    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw && typeof raw === "object") {
        for (const [id, salt] of Object.entries(raw)) {
          const n = Number(salt);
          if (id && Number.isFinite(n)) {
            this.salts.set(id, n);
          }
        }
      }
    } catch (error) {
      // Missing file on first run is expected; anything else is non-fatal.
      if (error?.code !== "ENOENT") {
        this.log.debug?.(`[Matter] Could not read salt ledger: ${errorText(error)}`);
      }
    }
  }

  persistSalts() {
    const file = this.saltsFilePath();
    if (!file) return;

    try {
      mkdirSync(dirname(file), { recursive: true });
      const obj = Object.fromEntries(this.salts.entries());
      writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
    } catch (error) {
      this.log.warn(`[Matter] Could not persist salt ledger: ${errorText(error)}`);
    }
  }

  // Record that we have seen this device (first registration). Salt starts at 0
  // so the UUID is unchanged from the original deterministic value.
  ensureSaltEntry(deviceId) {
    if (!deviceId || this.salts.has(deviceId)) return;
    this.salts.set(deviceId, 0);
    this.persistSalts();
  }

  // Increment a device's salt, forcing a fresh Apple Home identity on next
  // registration. Returns the new salt value.
  bumpSalt(deviceId) {
    const next = (this.salts.get(deviceId) ?? 0) + 1;
    this.salts.set(deviceId, next);
    this.persistSalts();
    return next;
  }

restoreAccessory(accessory,device) {
  if (!accessory?.UUID) return;
  this.accessories.set(accessory.UUID, accessory);

  const deviceId = accessory.context?.deviceId;
  if (deviceId) {
    this.deviceIndex.set(deviceId, accessory.UUID);
  }
  
}

  noteDevice(device) {
    if (device?.id) {
      this.latestDevices.set(device.id, device);
    }
  }

  supports(device) {
    if (!device?.id || !device?.category) return false;

    if (this.platform.isDeviceIgnored(device.id, "matter")) {
      return false;
    }

    return Boolean(this.resolveType(device, { requireCanCreate: true }));
  }

  resolveType(deviceOrContext, options = {}) {
    if (!deviceOrContext) return null;

    const forced =
      deviceOrContext?.matterAccessoryType ||
      deviceOrContext?.context?.matterAccessoryType;
    if (forced) {
      return (
        MATTER_ACCESSORY_TYPES.find((entry) => entry.id === forced) || null
      );
    }

    const requireCanCreate = options.requireCanCreate !== false;

    for (const MatterType of MATTER_ACCESSORY_TYPES) {
      if (
        typeof MatterType.matches === "function" &&
        !MatterType.matches(deviceOrContext)
      ) {
        continue;
      }

      if (
        requireCanCreate &&
        typeof MatterType.canCreate === "function" &&
        !MatterType.canCreate(this.platform, this, deviceOrContext)
      ) {
        continue;
      }

      return MatterType;
    }

    return null;
  }

  getMotionConfig(deviceId) {
    return (
      (this.platform.config?.options?.motion || []).find(
        (entry) => !entry?.deviceId || entry?.deviceId === deviceId,
      ) || null
    );
  }

  isValveDevice(device) {
    const deviceId = typeof device === "string" ? device : device?.id;
    if (!deviceId) return false;

    const cleanId = String(deviceId).trim();
    const configuredValves = this.platform.config?.options?.valve;

    // this.log.debug?.(
    //   `[Matter][Valve] Checking ${cleanId}. Config found: ${JSON.stringify(configuredValves ?? [])}`,
    // );

    return Boolean(
      (configuredValves || []).find((entry) => {
        const entryId = String(entry?.deviceId || "").trim();
        const protocol = entry?.protocol ?? "hap";
        return entryId === cleanId && (protocol === "matter" || protocol === "both");
      }),
    );
  }

  getRuntimeBucket(name) {
    if (!this.runtimeBuckets.has(name)) {
      this.runtimeBuckets.set(name, new Map());
    }

    return this.runtimeBuckets.get(name);
  }

  buildPersistedContext(rawContext, device, matterType, previousContext = undefined) {
    const context = {
      ...(cloneJson(previousContext, {}) || {}),
      ...(cloneJson(rawContext, {}) || {}),
    };

    if (device?.id) {
      context.deviceId = device.id;
    }

    if (matterType?.id) {
      context.matterAccessoryType = matterType.id;
    }

    if (device?.category && context.category === undefined) {
      context.category = device.category;
    }

    if(device){
      context.device = device;
    }

    return context;
  }

  prepareAccessoryForRegistration(created, device, matterType) {
    if (!created) return null;

    const UUID = created.UUID || this.uuidFor(device.id);
    const context = this.buildPersistedContext(
      created.context,
      device,
      matterType,
    );

    return {
      ...created,
      UUID,
      displayName: created.displayName || device.name || device.id,
      context,
    };

  }

  compareAccessoryShape(existing, desired, matterType) {
    const reasons = [];

    const existingDeviceType = deviceTypeName(existing?.deviceType);
    const desiredDeviceType = deviceTypeName(desired?.deviceType);
    if (
      existingDeviceType &&
      desiredDeviceType &&
      existingDeviceType !== desiredDeviceType
    ) {
      reasons.push(`device type ${existingDeviceType} -> ${desiredDeviceType}`);
    }

    const existingTypeId = existing?.context?.matterAccessoryType;
    const desiredTypeId =
      desired?.context?.matterAccessoryType || matterType?.id;
    if (existingTypeId && desiredTypeId && existingTypeId !== desiredTypeId) {
      reasons.push(`matterAccessoryType ${existingTypeId} -> ${desiredTypeId}`);
    }

    if (typeof matterType?.hasDifferentShape === "function") {
      try {
        if (
          matterType.hasDifferentShape(existing, desired, this.platform, this)
        ) {
          reasons.push("custom shape check reported a difference");
        }
      } catch (error) {
        this.log.warn(
          `[Matter] Shape comparison failed for ${desired?.displayName || existing?.displayName || desired?.UUID || existing?.UUID}: ${errorText(error)}`,
        );
      }
    }

    const existingParts = partsSignature(existing?.parts);
    const desiredParts = partsSignature(desired?.parts);
    if (!deepEqual(existingParts, desiredParts)) {
      reasons.push("parts signature changed");
    }

    return {
      changed: reasons.length > 0,
      reasons,
    };
  }

/**
 * Re-register cached Matter accessories immediately at startup, reconstructed
 * from the persisted device snapshot in each accessory's context — BEFORE the
 * (slow) Tuya cloud login. Homebridge does not re-create Matter endpoints for
 * cached accessories automatically; only registerPlatformAccessories() does.
 * If we waited for the cloud login + device fetch, Apple Home would reconnect to
 * an empty bridge and move all accessories to the Default Room (or drop them).
 *
 * Endpoint numbers are persisted by the Matter framework keyed by UUID, so
 * re-registering with the same UUID restores the exact same endpoint — preserving
 * pairing, rooms, names and icons.
 *
 * Accessories without a persisted snapshot (e.g. first boot after upgrade) are
 * skipped here and registered later by registerDevices() once the live device
 * list arrives; a snapshot is then persisted so the next restart is seamless.
 */
async registerCachedAccessories() {
  if (!this.isEnabled()) {
    return;
  }

  let restored = 0;
  let deferred = 0;
  this.isBooting = true;

  try {
    // Copy first — we mutate this.accessories inside the loop.
    const cachedEntries = Array.from(this.accessories.entries());

    for (const [uuid, cached] of cachedEntries) {
      try {
        const context = cached?.context || {};
        const device = context.device;
        const deviceId = context.deviceId;

        if (!device || !deviceId) {
          deferred += 1;
          continue;
        }

        if (this.platform.isDeviceIgnored(deviceId, "matter")) {
          this.log.debug(
            `[Matter] Skipping cached accessory (ignored by config): ${cached?.displayName || deviceId}`,
          );
          await this.removeDevice(deviceId);
          continue;
        }

        // matterAccessoryType is persisted in context, so resolveType pins the
        // exact type chosen at pairing time (no re-detection from the snapshot).
        const matterType = this.resolveType(context, { requireCanCreate: false });
        if (!matterType?.create) {
          deferred += 1;
          continue;
        }

        const desired = this.prepareAccessoryForRegistration(
          matterType.create(this.platform, this, device),
          device,
          matterType,
        );
        if (!desired) {
          deferred += 1;
          continue;
        }

        // If uuidSalt changed, desired.UUID differs from the cached uuid.
        // Skip early re-registration so registerDevices() treats it as new,
        // causing Apple Home to see a brand-new device with no prior state.
        if (desired.UUID !== uuid) {
          this.log.debug?.(
            `[Matter] UUID changed for ${cached?.displayName || deviceId} — deferring to registerDevices() for fresh registration.`,
          );
          deferred += 1;
          continue;
        }

        // Merge: cached.context is the base (preserves identity/pairing fields),
        // desired.context overrides it so fresh config values (e.g. overrideTime)
        // take effect immediately on the first restart after a config change.
        desired.context = this.buildPersistedContext(
          desired.context,
          device,
          matterType,
          cached.context,
        );
        desired.displayName = cached.displayName || desired.displayName;

        this.rebindHandlers(desired, device, matterType);
        this.accessories.set(uuid, desired);
        this.deviceIndex.set(deviceId, uuid);
        this.latestDevices.set(deviceId, device);

        await this.registerPlatformAccessory(desired);
        this.sessionRegistered.add(uuid);
        restored += 1;
      } catch (error) {
        this.log.debug?.(
          `[Matter] Early re-registration failed for ${cached?.displayName || uuid}: ${errorText(error)}`,
        );
      }
    }
  } finally {
    this.isBooting = false;
  }

  if (restored > 0 || deferred > 0) {
    this.log.info(
      `[Matter] Restored ${restored} cached accessor${restored === 1 ? "y" : "ies"} from cache at startup` +
        (deferred > 0 ? ` (${deferred} deferred until device sync).` : "."),
    );
  }
}

async registerDevices(devices = []) {
  if (!this.isEnabled()) {
    if (this.isAvailable()) {
      this.log.info("Matter is available but disabled for this bridge instance.");
    }
    return;
  }

  let newAccessories = 0;
  const seenCached = new Set();

  this.isBooting = true;

  try {
    for (const device of devices) {
      try {
        this.noteDevice(device);

        if (!this.supports(device)) {
          continue;
        }

        const matterType = this.resolveType(device, { requireCanCreate: true });
        if (!matterType?.create) {
          continue;
        }

        // Auto-salt: if we have a ledger entry for this device (we've registered
        // it before) but it is no longer in the cache, it was removed from the
        // bridge and is now re-appearing. Bump its salt so it registers under a
        // fresh UUID — Apple Home then treats it as a brand-new device instead
        // of reattaching the broken/unmovable state to the old identity.
        // Skipped when a manual override is configured (that takes precedence).
        if (
          this.getManualUUIDSalt(device.id) == null &&
          this.salts.has(device.id) &&
          !this.deviceIndex.has(device.id)
        ) {
          const next = this.bumpSalt(device.id);
          this.log.info(
            `[Matter][${device.id}] Device returned after removal — reset Apple Home identity (salt ${next}).`,
          );
        }
        this.ensureSaltEntry(device.id);

        const desired = this.prepareAccessoryForRegistration(
          matterType.create(this.platform, this, device),
          device,
          matterType,
        );
        if (!desired) {
          continue;
        }

        const cachedUuid = this.deviceIndex.get(device.id);
        // If the cached UUID no longer matches the desired UUID (e.g. uuidSalt was
        // added/changed), bypass the stale cache so the device registers fresh.
        const uuid = (cachedUuid && cachedUuid === desired.UUID) ? cachedUuid : desired.UUID;
        const existing = this.accessories.get(uuid);

        if (existing) {
          seenCached.add(uuid);

          if (this.sessionRegistered.has(uuid)) {
            // Already re-registered from cache at startup. The Matter framework
            // throws on duplicate UUID registration, so do NOT register again.
            // Refresh the persisted device snapshot with live data (for the next
            // restart) and let MQTT push the current state via sync().
            await this.refreshStoredMetadata(existing, desired, device, matterType);
            continue;
          }

          const shape = this.compareAccessoryShape(existing, desired, matterType);
          if (shape.changed) {
            if (!this.structureWarnings.has(uuid)) {
              this.structureWarnings.add(uuid);
              this.log.warn(
                `[Matter][${device.id}] Cached accessory shape differs from the current implementation (${shape.reasons.join(", ")}). Keeping cached accessory to preserve pairing. Remove and re-pair manually if you want the new shape applied.`,
              );
            }
            // Rebind handlers on the old-shape existing object so the endpoint
            // stays functional until the user manually re-pairs.
            this.rebindHandlers(existing, device, matterType);
            try {
              await this.registerPlatformAccessory(existing);
            } catch (error) {
              this.log.debug?.(
                `[Matter][${device?.id || uuid}] Re-registration of shape-changed cached accessory: ${errorText(error)}`,
              );
            }
          } else {
            await this.refreshStoredMetadata(existing, desired, device, matterType);

            desired.context = existing.context;
            desired.displayName = existing.displayName;
            this.rebindHandlers(desired, device, matterType);
            this.accessories.set(uuid, desired);

            // Re-register to restore the Matter endpoint with command handlers.
            // Homebridge removes any endpoint not re-claimed here at startup.
            try {
              await this.registerPlatformAccessory(desired);
            } catch (error) {
              this.log.debug?.(
                `[Matter][${device?.id || uuid}] Re-registration of cached accessory: ${errorText(error)}`,
              );
            }
          }

          continue;
        }

        if (await this.setRegisterNewAccessory(desired, device, matterType)) {
          newAccessories += 1;
        }

      } catch (error) {
        this.log.error(
          `[Matter][${device?.id || "unknown"}] Failed to prepare accessory: ${errorText(error)}`,
        );
      }
    }
  } finally {
    this.isBooting = false;
  }

  for (const [uuid, accessory] of this.accessories.entries()) {
    const deviceId = accessory?.context?.deviceId;
    if (!deviceId) continue;
    if (seenCached.has(uuid)) continue;

    this.log.debug?.(
      `[Matter] Cached accessory not rediscovered during startup: ${accessory?.displayName || uuid}`,
    );
  }

  this.log.info(
    `[Matter] Ready: ${newAccessories} new accessory${newAccessories === 1 ? "" : "ies"}.`,
  );
}

async setRegisterNewAccessory(accessory, device, matterType) {

  const uuid = accessory?.UUID;
  if (!uuid) return false;

  this.pendingRegistrations.add(uuid);

  try {
    this.accessories.set(uuid, accessory);
    this.deviceIndex.set(device.id, uuid);
    this.rebindHandlers(accessory, device, matterType);

    await this.registerPlatformAccessory(accessory);
    this.sessionRegistered.add(uuid);


    return true;
  } catch (error) {

    return false;
  } finally{
    this.pendingRegistrations.delete(uuid);
  }
}

async registerPlatformAccessory(accessory) {
  return await this.api.matter.registerPlatformAccessories(
      this.pluginName,
      this.platformName,
      [accessory],
    );
}

async refreshStoredMetadata(existing, desired, device, matterType) {
  let changed = false;

  const desiredContext = this.buildPersistedContext(
    desired.context,
    device,
    matterType,
    existing.context,
  );

  const desiredDisplayName = normalizeDisplayName(
    desiredContext.homeDisplayName,
    desired.displayName || device?.name || existing.displayName,
  );

  if (!deepEqual(existing.context ?? {}, desiredContext ?? {})) {
    existing.context = desiredContext;
    changed = true;
  }

  if (desiredDisplayName && existing.displayName !== desiredDisplayName) {
    existing.displayName = desiredDisplayName;
    changed = true;
  }

  if (changed && typeof this.api?.matter?.updatePlatformAccessories === "function") {
    try {
      await this.api.matter.updatePlatformAccessories([existing]);
    } catch (error) {
      this.log.warn(
        `[Matter][${device?.id || existing.UUID}] Failed to persist cached accessory metadata: ${errorText(error)}`,
      );
    }
  }

  return changed;
}


rebindHandlers(accessory, discoveredDevice, matterType = null) {
    const resolvedType =
      matterType ||
      this.resolveType(accessory?.context ?? accessory, {
        requireCanCreate: false,
      });
    const device =
      discoveredDevice ?? this.latestDevices.get(accessory?.context?.deviceId);

    if (resolvedType?.rebind) {
      try {
        resolvedType.rebind(
          this.platform,
          this,
          accessory,
          device,
        );
      } catch (error) {
        this.log.warn(
          `[Matter] Failed to rebind handlers for ${accessory?.displayName || accessory?.UUID}: ${errorText(error)}`,
        );
      }
    }
  }

async syncMessage(message) {
  const deviceId = message?.devId || message?.deviceId || message?.id;
  if (!deviceId) return;

  if (message.bizCode === "delete") {
    await this.removeDevice(deviceId);
    return;
  }

  const previous = this.latestDevices.get(deviceId) ?? {};
  const merged = {
    ...previous,
    ...message,
    id: deviceId,
    category: message?.category || previous?.category,
    name: message?.name || previous?.name,
  };

  const nextStatus = extractStatusEntries(message);
  if (nextStatus.length > 0) {
    merged.status = mergeStatusArrays(previous?.status, nextStatus);
  }

  this.latestDevices.set(deviceId, merged);

  const uuid = this.deviceIndex.get(deviceId) || this.uuidFor(deviceId);
  if (this.isBooting || this.pendingRegistrations.has(uuid)) {
    return;
  }

  await this.syncDeviceSnapshot(merged);
}

async syncDeviceSnapshot(device) {
    if (!device?.id) return;

    const uuid = this.deviceIndex.get(device.id) || this.uuidFor(device.id);
    const accessory = this.accessories.get(uuid);
    if (!accessory) return;

    const matterType = this.resolveType(accessory?.context ?? device, {
      requireCanCreate: false,
    });
    if (!matterType?.sync) return;

    await matterType.sync(this.platform, this, accessory, device);
  }


  getCachedClusterState(uuid, clusterName, partId) {
    const accessory = this.accessories.get(uuid);
    if (!accessory) return undefined;

    if (!partId) {
      return accessory?.clusters?.[clusterName];
    }

    const part = Array.isArray(accessory.parts)
      ? accessory.parts.find((candidate) => candidate?.id === partId)
      : undefined;
    return part?.clusters?.[clusterName];
  }

async safeUpdateAccessoryState(uuid, clusterName, patch, options = {}) {
  if (!uuid || !clusterName || !patch || Object.keys(patch).length === 0) {
    return false;
  }

  const partId = options.partId;
  const retries = clampRetryCount(options.retries, 2);
  const force = options.force === true;

  if (!force && (this.isBooting)) {
    return false;
  }

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      let currentState = this.getCachedClusterState(uuid, clusterName, partId);

      if (!currentState) {
        currentState = await this.api.matter.getAccessoryState(
          uuid,
          clusterName,
          partId,
        );
      }

      const delta = {};
      for (const [key, value] of Object.entries(patch)) {
        if (!deepEqual(currentState?.[key], value)) {
          delta[key] = value;
        }
      }

      if (Object.keys(delta).length === 0) {
        return false;
      }

      if (partId) {
        await this.api.matter.updateAccessoryState(uuid, clusterName, delta, partId);
      } else {
        await this.api.matter.updateAccessoryState(uuid, clusterName, delta);
      }

      const cachedCluster = this.getCachedClusterState(uuid, clusterName, partId);
      if (cachedCluster && typeof cachedCluster === "object") {
        Object.assign(cachedCluster, delta);
      }

      return true;
    } catch (error) {
      const message = errorText(error);

      if (attempt < retries && isRetryableStateError(message)) {
        await sleep(400 * (attempt + 1));
        continue;
      }

      this.log.warn(
        `[Matter] Failed to update ${uuid} ${clusterName}${partId ? ` (${partId})` : ""}: ${message}`,
      );
      return false;
    }
  }

  return false;
}

  async removeDevice(deviceId) {
    const uuid = this.deviceIndex.get(deviceId) || this.uuidFor(deviceId);
    const accessory = this.accessories.get(uuid);

    this.pendingRegistrations.delete(uuid);
    this.structureWarnings.delete(uuid);
    this.sessionRegistered.delete(uuid);

    for (const bucket of this.runtimeBuckets.values()) {
      if (!bucket.has(uuid)) {
        continue;
      }

      disposeRuntimeValue(bucket.get(uuid));
      bucket.delete(uuid);
    }

    this.latestDevices.delete(deviceId);

    if (!accessory) {
      this.deviceIndex.delete(deviceId);
      return;
    }

    try {
      await this.api.matter.unregisterPlatformAccessories(
        this.pluginName,
        this.platformName,
        [{ UUID: uuid }],
      );
    } catch (error) {
      this.log.warn(
        `[Matter] Failed to unregister ${accessory.displayName || uuid}: ${errorText(error)}`,
      );
    }

    this.accessories.delete(uuid);
    this.deviceIndex.delete(deviceId);
  }

  cleanup() {
  this.pendingRegistrations.clear();
  this.sessionRegistered.clear();
  this.isBooting = false;

  for (const bucket of this.runtimeBuckets.values()) {
    for (const value of bucket.values()) {
      disposeRuntimeValue(value);
    }
    bucket.clear();
  }

  this.log.debug?.("[Matter] Cleanup complete.");
}

  async sendCommands(deviceId, commands) {
    if (!this.platform?.tuyaOpenApi?.sendCommand) {
      throw new Error("Tuya API is not initialized");
    }

    await this.platform.tuyaOpenApi.sendCommand(deviceId, { commands });
  }

  extractStatusEntries(source) {
    return extractStatusEntries(source);
  }

  getStatusValue(source, ...codes) {
    return getStatusValue(source, ...codes);
  }

  hasCode(device, code) {
    return hasCode(device, code);
  }

  pickSupportedCode(device, candidates) {
    return pickSupportedCode(device, candidates);
  }

  getNumericRangeForCode(deviceIdOrDevice, code, fallbackMin, fallbackMax) {
    const device =
      typeof deviceIdOrDevice === "string"
        ? this.latestDevices.get(deviceIdOrDevice) || { id: deviceIdOrDevice }
        : deviceIdOrDevice;

    return getNumericRangeForCode(device, code, fallbackMin, fallbackMax);
  }

  rangeToPercent(raw, range, fallback = 100) {
    return rangeToPercent(raw, range, fallback);
  }

  percentToRange(percent, min, max) {
    return percentToRange(percent, min, max);
  }

  percentToMatterLevel(percent) {
    return percentToMatterLevel(percent);
  }

  matterLevelToPercent(level) {
    return matterLevelToPercent(level);
  }

  percentToMatterSat(percent) {
    return percentToMatterSat(percent);
  }

  matterSatToPercent(value) {
    return matterSatToPercent(value);
  }

  degreesToMatterHue(degrees) {
    return degreesToMatterHue(degrees);
  }

  matterHueToDegrees(value) {
    return matterHueToDegrees(value);
  }

  colorTempPercentToMireds(percent) {
    return colorTempPercentToMireds(percent);
  }

  miredsToColorTempPercent(mireds) {
    return miredsToColorTempPercent(mireds);
  }

  toBoolean(value, fallback = false) {
    return toBoolean(value, fallback);
  }
}
