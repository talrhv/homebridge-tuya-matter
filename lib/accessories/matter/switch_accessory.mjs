"use strict";

import {
  baseIdentity,
  comparePartShape,
  getGangCodes,
  getStatusValue,
  partLabel,
  toBoolean,
  toPartId,
} from "./_shared.mjs";

const CATEGORIES = new Set(["tdq", "dlq", "kg"]);

export default class SwitchMatterAccessory {
  static id = "switch";

  static matches(device) {
    return CATEGORIES.has(device?.category);
  }

  static canCreate(platform, bridge, device) {
    return !bridge.isValveDevice(device);
  }

  static create(platform, bridge, device) {
    const gangCodes = getGangCodes(device);
    if (gangCodes.length === 0) return null;

    const context = {
      matterAccessoryType: this.id,
      gangCodes,
      multiGang: gangCodes.length > 1,
    };

    const accessory = {
      ...baseIdentity(bridge, device, context),
      deviceType: platform.api.matter.deviceTypes.OnOffSwitch,
      clusters: {
        onOff: {
          onOff: toBoolean(getStatusValue(device, gangCodes[0]), false),
        },
      },
      handlers: {
        onOff: {
          on: async () =>
            bridge.sendCommands(device.id, [{ code: gangCodes[0], value: true }]),
          off: async () =>
            bridge.sendCommands(device.id, [{ code: gangCodes[0], value: false }]),
        },
      },
    };

    if (gangCodes.length > 1) {
      accessory.parts = gangCodes.slice(1).map((code, index) => ({
        id: toPartId(code, this.id),
        displayName: partLabel("Switch", index + 1),
        deviceType: accessory.deviceType,
        clusters: {
          onOff: { onOff: toBoolean(getStatusValue(device, code), false) },
        },
        handlers: {
          onOff: {
            on: async () =>
              bridge.sendCommands(device.id, [{ code, value: true }]),
            off: async () =>
              bridge.sendCommands(device.id, [{ code, value: false }]),
          },
        },
      }));
    }

    return accessory;
  }

  static rebind(platform, bridge, accessory, device) {
    const gangCodes = accessory.context?.gangCodes || [];

    accessory.clusters = {
      ...(accessory.clusters || {}),
      onOff: {
        onOff: toBoolean(getStatusValue(device, gangCodes[0]), false),
      },
    };

    accessory.handlers = {
      ...(accessory.handlers || {}),
      onOff: {
        on: async () =>
          bridge.sendCommands(accessory.context.deviceId, [{ code: gangCodes[0], value: true }]),
        off: async () =>
          bridge.sendCommands(accessory.context.deviceId, [{ code: gangCodes[0], value: false }]),
      },
    };

    if (!accessory.context?.multiGang) {
      return;
    }

    accessory.parts = gangCodes.slice(1).map((code, index) => ({
      id: toPartId(code, this.id),
      displayName: partLabel("Switch", index + 1),
      deviceType: accessory.deviceType,
      clusters: {
        onOff: { onOff: toBoolean(getStatusValue(device, code), false) },
      },
      handlers: {
        onOff: {
          on: async () =>
            bridge.sendCommands(accessory.context.deviceId, [{ code, value: true }]),
          off: async () =>
            bridge.sendCommands(accessory.context.deviceId, [{ code, value: false }]),
        },
      },
    }));
  }

  static hasDifferentShape(existing, created) {
    return comparePartShape(existing, created);
  }

  static async sync(platform, bridge, accessory, device) {
    const uuid = accessory.UUID;
    const gangCodes = accessory.context?.gangCodes || [];

    await bridge.safeUpdateAccessoryState(
      uuid,
      platform.api.matter.clusterNames.OnOff,
      {
        onOff: toBoolean(getStatusValue(device, gangCodes[0]), false),
      },
    );

    if (!accessory.context?.multiGang) {
      return;
    }

    for (const code of gangCodes.slice(1)) {
      await bridge.safeUpdateAccessoryState(
        uuid,
        platform.api.matter.clusterNames.OnOff,
        { onOff: toBoolean(getStatusValue(device, code), false) },
        { partId: toPartId(code, this.id) },
      );
    }
  }
}
