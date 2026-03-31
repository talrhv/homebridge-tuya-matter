"use strict";

import {
  baseIdentity,
  getGangCodes,
  getCountdownCodes,
  getStatusValue,
  toBoolean,
} from "./_shared.mjs";

export default class ValveMatterAccessory {
  static id = "valve";

  static matches(device) {
    return device?.category === "kg";
  }

  static canCreate(platform, bridge, device) {
    return bridge.isValveDevice(device);
  }

  static create(platform, bridge, device) {
    const switchCode = getGangCodes(device)[0] || "switch_1";
    const countdownCode = getCountdownCodes(device)[0] || null;

    const supportsValve = !!platform.api.matter.deviceTypes.WaterValve;
    const deviceType = supportsValve
      ? platform.api.matter.deviceTypes.WaterValve
      : platform.api.matter.deviceTypes.OnOffSwitch;

    const isOpen = toBoolean(getStatusValue(device, switchCode), false);
    const remaining = countdownCode ? Number(getStatusValue(device, countdownCode)) || 0 : 0;

    const context = {
      matterAccessoryType: this.id,
      deviceId: device.id,
      switchCode,
      countdownCode,
      supportsValve,
      defaultOpenDuration: countdownCode && !isOpen && remaining > 0 ? remaining : null,
    };

    const clusters = supportsValve
      ? {
          valveConfigurationAndControl: {
            currentState: isOpen ? 1 : 0,
            targetState: isOpen ? 1 : 0,
            defaultOpenDuration: context.defaultOpenDuration,
            openDuration: isOpen && remaining > 0 ? remaining : null,
            remainingDuration: isOpen && remaining > 0 ? remaining : null,
          },
        }
      : {
          onOff: { onOff: isOpen },
        };

    return {
      ...baseIdentity(bridge, device, context),
      deviceType,
      clusters,
      handlers: this.buildHandlers(platform, bridge, context),
    };
  }

  static buildHandlers(platform, bridge, context) {
    const normalizeDuration = (value) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return null;
      }
      return Math.trunc(value);
    };

    const writeDefaultDuration = async (value) => {
      context.defaultOpenDuration = normalizeDuration(value);

      if (!context.countdownCode) {
        return;
      }

      await bridge.sendCommands(context.deviceId, [{
        code: context.countdownCode,
        value: context.defaultOpenDuration ?? 0,
      }]);
    };

    const turnOn = async (requestedDuration = null) => {
      const effectiveDuration = normalizeDuration(requestedDuration) ?? context.defaultOpenDuration;
      const commands = [{ code: context.switchCode, value: true }];

      if (context.countdownCode && typeof effectiveDuration === "number" && effectiveDuration > 0) {
        commands.push({ code: context.countdownCode, value: effectiveDuration });
      }

      await bridge.sendCommands(context.deviceId, commands);
    };

    const turnOff = async () => {
      await bridge.sendCommands(context.deviceId, [
        { code: context.switchCode, value: false },
      ]);
    };

    if (!context.supportsValve) {
      return {
        onOff: {
          on: async () => turnOn(),
          off: async () => turnOff(),
        },
      };
    }

    return {
      valveConfigurationAndControl: {
        open: async (args) => {
          const reqDuration = args?.openDuration ?? args?.request?.openDuration ?? null;
          await turnOn(reqDuration);
        },
        close: async () => turnOff(),
        defaultOpenDurationChange: async (args) => {
          await writeDefaultDuration(args?.defaultOpenDuration ?? null);
        },
      },
    };
  }

  static rebind(platform, bridge, accessory) {
    accessory.handlers = this.buildHandlers(
      platform,
      bridge,
      accessory.context ?? {},
    );
  }

  static async sync(platform, bridge, accessory, device) {
    const switchCode = accessory.context?.switchCode;
    const countdownCode = accessory.context?.countdownCode;
    const supportsValve = accessory.context?.supportsValve;

    const isOpen = toBoolean(getStatusValue(device, switchCode), false);
    const remaining = countdownCode
      ? Number(getStatusValue(device, countdownCode)) || 0
      : null;

    if (!isOpen && typeof remaining === "number" && remaining > 0) {
      accessory.context.defaultOpenDuration = remaining;
    }

    if (!supportsValve) {
      await bridge.safeUpdateAccessoryState(
        accessory.UUID,
        platform.api.matter.clusterNames.OnOff,
        { onOff: isOpen },
      );
      return;
    }

    await bridge.safeUpdateAccessoryState(
      accessory.UUID,
      platform.api.matter.clusterNames.ValveConfigurationAndControl,
      {
        currentState: isOpen ? 1 : 0,
        targetState: isOpen ? 1 : 0,
        defaultOpenDuration: accessory.context?.defaultOpenDuration ?? null,
        openDuration: isOpen && remaining && remaining > 0 ? remaining : null,
        remainingDuration: isOpen && remaining && remaining > 0 ? remaining : null,
      },
    );
  }
}
