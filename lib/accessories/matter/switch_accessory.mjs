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

function aggregateGangOnOff(source, gangCodes = []) {
  return gangCodes.some((code) => toBoolean(getStatusValue(source, code), false));
}

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
          onOff:
            gangCodes.length === 1
              ? toBoolean(getStatusValue(device, gangCodes[0]), false)
              : aggregateGangOnOff(device, gangCodes),
        },
      },
      handlers: {
        onOff: {
          on: async () =>
            bridge.sendCommands(
              device.id,
              (gangCodes.length === 1 ? [gangCodes[0]] : gangCodes).map((code) => ({
                code,
                value: true,
              })),
            ),
          off: async () =>
            bridge.sendCommands(
              device.id,
              (gangCodes.length === 1 ? [gangCodes[0]] : gangCodes).map((code) => ({
                code,
                value: false,
              })),
            ),
        },
      },
    };

    if (gangCodes.length > 1) {
      accessory.parts = gangCodes.map((code, index) => ({
        id: toPartId(code, this.id),
        displayName: partLabel("Switch", index),
        deviceType: platform.api.matter.deviceTypes.OnOffSwitch,
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
        onOff:
          gangCodes.length === 1
            ? toBoolean(getStatusValue(device, gangCodes[0]), false)
            : aggregateGangOnOff(device, gangCodes),
      },
    };

    accessory.handlers = {
      ...(accessory.handlers || {}),
      onOff: {
        on: async () =>
          bridge.sendCommands(
            accessory.context.deviceId,
            (gangCodes.length === 1 ? [gangCodes[0]] : gangCodes).map((code) => ({
              code,
              value: true,
            })),
          ),
        off: async () =>
          bridge.sendCommands(
            accessory.context.deviceId,
            (gangCodes.length === 1 ? [gangCodes[0]] : gangCodes).map((code) => ({
              code,
              value: false,
            })),
          ),
      },
    };

    if (!accessory.context?.multiGang) {
      return;
    }

    accessory.parts = gangCodes.map((code, index) => ({
      id: toPartId(code, this.id),
      displayName: partLabel("Switch", index),
      deviceType: platform.api.matter.deviceTypes.OnOffSwitch,
      clusters: {
        onOff: { onOff: toBoolean(getStatusValue(device, code), false) },
      },
      handlers: {
        onOff: {
          on: async () =>
            bridge.sendCommands(accessory.context.deviceId, [
              { code, value: true },
            ]),
          off: async () =>
            bridge.sendCommands(accessory.context.deviceId, [
              { code, value: false },
            ]),
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

    if (!accessory.context?.multiGang) {
      const code = gangCodes[0];
      await bridge.safeUpdateAccessoryState(
        uuid,
        platform.api.matter.clusterNames.OnOff,
        {
          onOff: toBoolean(getStatusValue(device, code), false),
        },
      );
      return;
    }

    await bridge.safeUpdateAccessoryState(
      uuid,
      platform.api.matter.clusterNames.OnOff,
      {
        onOff: aggregateGangOnOff(device, gangCodes),
      },
    );

    for (const code of gangCodes) {
      await bridge.safeUpdateAccessoryState(
        uuid,
        platform.api.matter.clusterNames.OnOff,
        { onOff: toBoolean(getStatusValue(device, code), false) },
        { partId: toPartId(code, this.id) },
      );
    }
  }
}
