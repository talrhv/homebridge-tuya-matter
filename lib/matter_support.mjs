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
    this.restoringAccessories = new Set();
    this.postRegistrationTimers = new Map();
    this.structureWarnings = new Set();
    this.runtimeBuckets = new Map();

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

  restoreAccessory(accessory) {
    if (!accessory?.UUID) return;

    this.accessories.set(accessory.UUID, accessory);

    const deviceId = accessory.context?.deviceId;
    if (deviceId) {
      this.deviceIndex.set(deviceId, accessory.UUID);
    }

    this.restoringAccessories.add(accessory.UUID);
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

    this.log.debug?.(
      `[Matter][Valve] Checking ${cleanId}. Config found: ${JSON.stringify(configuredValves ?? [])}`,
    );

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
        this.log.info(
          "Matter is available but disabled for this bridge instance.",
        );
      }
      return;
    }

    let newAccessories = 0;
    const discoveredUuids = new Set();

    // ── PASS 1: re-register ALL restoring accessories up-front ──────
    const restoringBatch = [];

    for (const device of devices) {
      this.noteDevice(device);

      if (!this.supports(device)) continue;

      const matterType = this.resolveType(device, { requireCanCreate: true });
      if (!matterType?.create) continue;

      const created = this.prepareAccessoryForRegistration(
        matterType.create(this.platform, this, device),
        device,
        matterType,
      );
      if (!created) continue;

      const uuid = this.deviceIndex.get(device.id) || created.UUID;
      const existing = this.accessories.get(uuid);

      if (existing && this.restoringAccessories.has(existing.UUID)) {
        restoringBatch.push({ existing, created, device, matterType });
        this.pendingRegistrations.add(existing.UUID);
      }
    }

    // ── PASS 1: re-register cached accessories in the current Matter session ─
    //
    // Homebridge Matter 2.0 requires registerPlatformAccessories() on every boot
    // to register accessories in the current session — even for devices that are
    // already commissioned. Without this call the Matter server rejects any
    // subsequent updateAccessoryState calls with "not registered in current session".
    //
    // The room-placement bug was NOT caused by calling registerPlatformAccessories.
    // It was caused by passing `...created` as the registration object. Spreading
    // the freshly-built `created` object replaced the cached accessory's committed
    // structure (deviceType, parts, cluster shapes) with a potentially different one.
    // The Matter server detected the shape mismatch and treated the accessory as a
    // new device, causing the Home app to move it back to the bridge room.
    //
    // Fix: register using `existing` as the base so the server sees the same
    // structure it previously committed. Only the context is merged in from `created`.
    if (restoringBatch.length > 0) {
      const toRegisterList = [];

      for (const { existing, created, device, matterType } of restoringBatch) {
        // Merge fresh context (deviceId, matterAccessoryType, category, etc.) into
        // the cached accessory in-place. Do NOT spread `...created` — that replaces
        // deviceType / parts / cluster shapes and triggers a shape-mismatch
        // re-commission in the Matter server, resetting room placement.
        existing.context = this.buildPersistedContext(
          created.context,
          device,
          matterType,
          existing.context,
        );

        this.accessories.set(existing.UUID, existing);
        this.deviceIndex.set(device.id, existing.UUID);

        // Apply name support on the cached object (handlers only — no shape change).
        toRegisterList.push(this.applyNameSupport(existing, device));
      }

      try {
        await this.api.matter.registerPlatformAccessories(
          this.pluginName,
          this.platformName,
          toRegisterList,
        );
      } catch (error) {
        this.log.error(`[Matter] Batch session-restore failed: ${errorText(error)}`);
      }

      for (const { existing, device, matterType } of restoringBatch) {
        this.pendingRegistrations.delete(existing.UUID);
        this.rebindHandlers(existing, device, matterType);
        this.schedulePostRegistrationSync(existing, { restoring: true, delayMs: 250 });
      }
    }

    // ── PASS 2: new accessories + sync (existing loop logic) ────────
    for (const device of devices) {
      try {
        // (noteDevice was already called for all devices in Pass 1)
        if (!this.supports(device)) {
          continue;
        }

        const matterType = this.resolveType(device, { requireCanCreate: true });
        if (!matterType?.create) {
          continue;
        }

        const created = this.prepareAccessoryForRegistration(
          matterType.create(this.platform, this, device),
          device,
          matterType,
        );
        if (!created) {
          continue;
        }

        const uuid = this.deviceIndex.get(device.id) || created.UUID;
        const existing = this.accessories.get(uuid);
        discoveredUuids.add(uuid);

        // Skip already-handled UUIDs from Pass 1
        if (existing && this.restoringAccessories.has(existing.UUID)) {
          continue; 
        }

        if (!existing) {
          const registered = await this.registerNewAccessory(
            created,
            device,
            matterType,
          );
          if (registered) {
            newAccessories += 1;
          }
          continue;
        }

        this.accessories.set(existing.UUID, existing);
        this.deviceIndex.set(device.id, existing.UUID);
        this.rebindHandlers(existing, device, matterType);

        const shape = this.compareAccessoryShape(existing, created, matterType);
        if (shape.changed) {
          if (!this.structureWarnings.has(existing.UUID)) {
            this.structureWarnings.add(existing.UUID);
            this.log.warn(
              `[Matter][${device.id}] Cached accessory shape differs from the current implementation (${shape.reasons.join(", ")}). Keeping the cached accessory to preserve pairing. Remove and re-pair manually if you want the new shape applied.`,
            );
          }
        } else {
          await this.refreshStoredMetadata(
            existing,
            created,
            device,
            matterType,
          );
        }

        if (!this.pendingRegistrations.has(existing.UUID)) {
          await this.syncDeviceSnapshot(device);
        }
      } catch (error) {
        this.log.error(
          `[Matter][${device?.id || "unknown"}] Failed to prepare accessory: ${errorText(error)}`,
        );
      }
    }

    await this.releaseUnseenRestorations(discoveredUuids);

    this.log.info(
      `[Matter] Ready: ${newAccessories} new accessory${newAccessories === 1 ? "" : "ies"}.`,
    );
  }

  async registerNewAccessory(accessory, device, matterType) {
    accessory = this.applyNameSupport(accessory, device);

    const uuid = accessory?.UUID;
    if (!uuid) return false;

    try {
      this.pendingRegistrations.add(uuid);

      await this.api.matter.registerPlatformAccessories(
        this.pluginName,
        this.platformName,
        [accessory],
      );

      this.accessories.set(uuid, accessory);
      this.deviceIndex.set(device.id, uuid);
      this.rebindHandlers(accessory, device, matterType);
      this.schedulePostRegistrationSync(accessory, { delayMs: 1500 });

      return true;
    } catch (error) {
      this.pendingRegistrations.delete(uuid);
      this.log.error(
        `[Matter] Failed to register ${accessory.displayName || device?.id || uuid}: ${errorText(error)}`,
      );
      return false;
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

    if (desiredDisplayName && existing.displayName !== desiredDisplayName) {
      const oldName = existing.displayName;
      existing.displayName = desiredDisplayName;
      changed = true;

      this.log.debug?.(
        `[Matter][${device.id}] Startup name sync: ${oldName} -> ${desiredDisplayName}`,
      );

      await this.safeUpdateAccessoryState(
        existing.UUID,
        this.getBridgedClusterName(),
        { nodeLabel: desiredDisplayName },
        { force: true },
      );
    }

    if (!deepEqual(existing.context ?? {}, desiredContext ?? {})) {
      existing.context = desiredContext;
      changed = true;
    }

    this.applyNameSupport(existing, device);
    this.accessories.set(existing.UUID, existing);
    this.deviceIndex.set(device.id, existing.UUID);

    if (changed) {
      this.log.debug?.(
        `[Matter][${device.id}] Runtime metadata differs from persisted cache for ${existing.displayName || device?.name || existing.UUID}; keeping the cached accessory registration unchanged for this session.`,
      );
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

    this.applyNameSupport(accessory, device);
  }


  schedulePostRegistrationSync(accessory, options = {}) {
    const uuid = accessory?.UUID;
    if (!uuid) return;

    const deviceId = accessory?.context?.deviceId;
    const restoring = options.restoring === true;
    const delayMs = Number(options.delayMs ?? 1500);

    const previousTimer = this.postRegistrationTimers.get(uuid);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    const timer = setTimeout(
      async () => {
        this.postRegistrationTimers.delete(uuid);

        if (restoring) {
          this.restoringAccessories.delete(uuid);
        } else {
          this.pendingRegistrations.delete(uuid);
        }

        try {
          const snapshot = deviceId
            ? this.latestDevices.get(deviceId)
            : undefined;
          if (snapshot) {
            this.log.debug?.(
              `[Matter][${deviceId}] Device -> Home app: applying post-registration sync.`,
            );
            await this.syncDeviceSnapshot(snapshot);
          }
        } catch (error) {
          this.log.warn(
            `[Matter][${deviceId || uuid}] Post-registration sync failed: ${errorText(error)}`,
          );
        }
      },
      Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 1500,
    );

    this.postRegistrationTimers.set(uuid, timer);
  }

  async releaseUnseenRestorations(discoveredUuids) {
    for (const uuid of Array.from(this.restoringAccessories)) {
      if (discoveredUuids.has(uuid)) {
        continue;
      }

      this.restoringAccessories.delete(uuid);

      const accessory = this.accessories.get(uuid);
      this.log.debug?.(
        `[Matter] Cached accessory not rediscovered during startup: ${accessory?.displayName || uuid}`,
      );
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
    if (
      this.pendingRegistrations.has(uuid) ||
      this.restoringAccessories.has(uuid) ||
      this.postRegistrationTimers.has(uuid)
    ) {
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

    if (
      !force &&
      (this.pendingRegistrations.has(uuid) ||
        this.restoringAccessories.has(uuid) ||
        this.postRegistrationTimers.has(uuid))
    ) {
      return false;
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        let currentState = this.getCachedClusterState(
          uuid,
          clusterName,
          partId,
        );

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
          await this.api.matter.updateAccessoryState(
            uuid,
            clusterName,
            delta,
            partId,
          );
        } else {
          await this.api.matter.updateAccessoryState(uuid, clusterName, delta);
        }

        const cachedCluster = this.getCachedClusterState(
          uuid,
          clusterName,
          partId,
        );
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

    const timer = this.postRegistrationTimers.get(uuid);
    if (timer) {
      clearTimeout(timer);
      this.postRegistrationTimers.delete(uuid);
    }

    this.pendingRegistrations.delete(uuid);
    this.restoringAccessories.delete(uuid);
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
    for (const timer of this.postRegistrationTimers.values()) {
      clearTimeout(timer);
    }
    this.postRegistrationTimers.clear();
    this.pendingRegistrations.clear();
    this.restoringAccessories.clear();

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
