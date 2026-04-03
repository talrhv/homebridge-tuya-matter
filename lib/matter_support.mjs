"use strict";

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
  this.structureWarnings = new Set();
  this.runtimeBuckets = new Map();

  this.isBooting = false;

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
    return this.api.matter.uuid.generate(`tuya:${deviceId}`);
  }

restoreAccessory(accessory,devices) {
  if (!accessory?.UUID) return;
  this.accessories.set(accessory.UUID, accessory);

  const deviceId = accessory.context?.deviceId;
  if (deviceId) {
    this.deviceIndex.set(deviceId, accessory.UUID);
  }

  this.rebindHandlers(accessory,accessory.context);
  
}

  noteDevice(device) {
    if (device?.id) {
      this.latestDevices.set(device.id, device);
    }
  }

  supports(device) {
    if (!device?.id || !device?.category) return false;

    const ignoreDevices = this.platform.config?.options?.ignoreDevices ?? [];
    if (Array.isArray(ignoreDevices) && ignoreDevices.includes(device.id)) {
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
        (entry) => entry?.deviceId === deviceId,
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
        const isActive =
          entry?.isActive === true ||
          String(entry?.isActive).toLowerCase() === "true";
        return entryId === cleanId && isActive;
      }),
    );
  }

  getRuntimeBucket(name) {
    if (!this.runtimeBuckets.has(name)) {
      this.runtimeBuckets.set(name, new Map());
    }

    return this.runtimeBuckets.get(name);
  }

  getBridgedClusterName() {
    return (
      this.api?.matter?.clusterNames?.BridgedDeviceBasicInformation ||
      "bridgedDeviceBasicInformation"
    );
  }

  getResolvedAccessoryDisplayName(accessory, device) {
    return normalizeDisplayName(
      accessory?.context?.homeDisplayName,
      normalizeDisplayName(
        accessory?.displayName,
        normalizeDisplayName(
          device?.name,
          device?.id || accessory?.UUID || "Accessory",
        ),
      ),
    );
  }

  getResolvedPartDisplayName(accessory, part, index = null) {
    const storedName = part?.id
      ? accessory?.context?.partDisplayNames?.[part.id]
      : undefined;

    return normalizeDisplayName(
      storedName,
      normalizeDisplayName(
        part?.displayName,
        part?.id || (index === null ? "Part" : `Part ${index + 1}`),
      ),
    );
  }

  async handleNodeLabelWrite(accessory, target, request, options = {}) {
    const partId = options.partId;
    const latestDevice = this.latestDevices.get(accessory?.context?.deviceId);
    const nextName = normalizeDisplayName(
      request?.nodeLabel ?? request?.value ?? request?.name ?? request,
      partId
        ? this.getResolvedPartDisplayName(accessory, target)
        : this.getResolvedAccessoryDisplayName(accessory, latestDevice),
    );

    if (!nextName) {
      return target?.displayName;
    }

    accessory.context = accessory.context || {};

    if (partId) {
      accessory.context.partDisplayNames = {
        ...(cloneJson(accessory.context.partDisplayNames, {}) || {}),
        [partId]: nextName,
      };
    } else {
      accessory.context.homeDisplayName = nextName;
      accessory.displayName = nextName;
    }

    target.displayName = nextName;
    target.clusters = target.clusters || {};
    target.clusters[this.getBridgedClusterName()] = {
      ...(target.clusters[this.getBridgedClusterName()] || {}),
      nodeLabel: nextName,
    };

    this.log.info(
      `[Matter][${accessory.context?.deviceId}${partId ? `/${partId}` : ""}] Renamed in Home app to: ${nextName}`,
    );

    if (typeof this.api?.matter?.updatePlatformAccessories === "function") {
      try {
        await this.api.matter.updatePlatformAccessories([accessory]);
      } catch (error) {
        this.log.debug?.(
          `[Matter][${accessory.context?.deviceId}] Could not persist rename to cache: ${errorText(error)}`,
        );
      }
    }

    return nextName;
  }

  applyNameSupport(accessory, device = null) {
    if (!accessory) {
      return accessory;
    }

    const bridgedCluster = this.getBridgedClusterName();

    const applyTarget = (target, options = {}) => {
      if (!target) {
        return;
      }

      const nextName = options.partId
        ? this.getResolvedPartDisplayName(accessory, target, options.index)
        : this.getResolvedAccessoryDisplayName(accessory, device);

      target.displayName = nextName;
      target.clusters = target.clusters || {};
      target.clusters[bridgedCluster] = {
        ...(target.clusters[bridgedCluster] || {}),
        nodeLabel: nextName,
      };
      target.handlers = target.handlers || {};
      target.handlers[bridgedCluster] = {
        ...(target.handlers[bridgedCluster] || {}),
        nodeLabel: async (request) =>
          this.handleNodeLabelWrite(accessory, target, request, options),
      };
    };

    applyTarget(accessory);

    if (Array.isArray(accessory.parts)) {
      accessory.parts.forEach((part, index) => {
        applyTarget(part, {
          partId: part?.id,
          index,
        });
      });
    }

    return accessory;
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

    return this.applyNameSupport(
      {
        ...created,
        UUID,
        displayName: created.displayName || device.name || device.id,
        context,
      },
      device,
    );
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

        const desired = this.prepareAccessoryForRegistration(
          matterType.create(this.platform, this, device),
          device,
          matterType,
        );
        if (!desired) {
          continue;
        }

        const uuid = this.deviceIndex.get(device.id) || desired.UUID;
        const existing = this.accessories.get(uuid);

        if (existing) {
          seenCached.add(uuid);

          this.accessories.set(uuid, existing);
          this.deviceIndex.set(device.id, uuid);

          this.rebindHandlers(existing, device, matterType);

          const shape = this.compareAccessoryShape(existing, desired, matterType);
          if (shape.changed) {
            if (!this.structureWarnings.has(uuid)) {
              this.structureWarnings.add(uuid);
              this.log.warn(
                `[Matter][${device.id}] Cached accessory shape differs from the current implementation (${shape.reasons.join(", ")}). Keeping cached accessory to preserve pairing. Remove and re-pair manually if you want the new shape applied.`,
              );
            }
          } else {
            await this.refreshStoredMetadata(existing, desired, device, matterType);
          }

          continue;
        }

        this.log('registering!!!')
        const registered = await this.registerNewAccessory(
          desired,
          device,
          matterType,
        );

        if (registered) {
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

  // After boot, push latest external state into all discovered accessories
  for (const device of devices) {
    try {
      if (!device?.id || !this.supports(device)) {
        continue;
      }

      await this.syncDeviceSnapshot(device);
    } catch (error) {
      this.log.warn(
        `[Matter][${device?.id || "unknown"}] Initial sync failed: ${errorText(error)}`,
      );
    }
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

async registerNewAccessory(accessory, device, matterType) {
  accessory = this.applyNameSupport(accessory, device);

  const uuid = accessory?.UUID;
  if (!uuid) return false;

  this.pendingRegistrations.add(uuid);

  try {
    await this.api.matter.registerPlatformAccessories(
      this.pluginName,
      this.platformName,
      [accessory],
    );

    this.accessories.set(uuid, accessory);
    this.deviceIndex.set(device.id, uuid);
    this.rebindHandlers(accessory, device, matterType);

    return true;
  } catch (error) {
    this.log.error(
      `[Matter] Failed to register ${accessory.displayName || device?.id || uuid}: ${errorText(error)}`,
    );
    return false;
  } finally {
    this.pendingRegistrations.delete(uuid);
  }
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

  this.applyNameSupport(existing, device);
  this.accessories.set(existing.UUID, existing);
  this.deviceIndex.set(device.id, existing.UUID);

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

      this.log.debug("rebinding handlers", `${JSON.stringify(device)}` );

    if (resolvedType?.rebind) {
      try {
        this.log.debug('rebinding!!')
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

    this.applyNameSupport(accessory, device);
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

    const liveName = this.getResolvedAccessoryDisplayName(accessory, device);

    if (liveName && liveName !== accessory.displayName) {
      await this.safeUpdateAccessoryState(
        uuid,
        this.getBridgedClusterName(),
        { nodeLabel: liveName },
      );
      accessory.displayName = liveName;
    }

    this.applyNameSupport(accessory, device);

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
