"use strict";

import { baseIdentity, getStatusValue, toBoolean } from "./_shared.mjs";

// Tuya qn heaters report temperature in whole degrees (e.g. 25 = 25°C)
// Matter Thermostat uses hundredths of a degree (e.g. 2500 = 25.00°C)
function tuyaTempToMatter(value) {
  if (value == null) return null;
  return Math.round(Number(value) * 100);
}

function matterTempToTuya(value) {
  if (value == null) return null;
  return Math.round(Number(value) / 100);
}

export default class HeaterMatterAccessory {
  static id = "heater";

  static matches(device) {
    return device?.category === "qn";
  }

  static create(platform, bridge, device) {
    // Always use "switch" for qn heaters — hasCode may return false when device is offline
    const powerCode = "switch";

    // Probe live status first, fall back to standard codes for offline devices
    const tempCurrentCode = bridge.hasCode(device, "temp_current") ? "temp_current"
      : bridge.hasCode(device, "temp_current_f") ? "temp_current_f" : "temp_current";
    const tempSetCode = bridge.hasCode(device, "temp_set") ? "temp_set"
      : bridge.hasCode(device, "temp_set_f") ? "temp_set_f" : "temp_set";

    const isOn = toBoolean(getStatusValue(device, powerCode), false);
    const rawTempCurrent = tempCurrentCode ? getStatusValue(device, tempCurrentCode) : null;
    const rawTempSet = tempSetCode ? getStatusValue(device, tempSetCode) : null;

    const localTemperature = tuyaTempToMatter(rawTempCurrent) ?? 2000;
    const occupiedHeatingSetpoint = tuyaTempToMatter(rawTempSet) ?? 2000;

    return {
      ...baseIdentity(bridge, device, {
        matterAccessoryType: this.id,
        powerCode,
        tempCurrentCode,
        tempSetCode,
      }),
      deviceType: platform.api.matter.deviceTypes.Thermostat,
      clusters: {
        thermostat: {
          localTemperature: localTemperature,
          occupiedHeatingSetpoint: occupiedHeatingSetpoint,
          occupiedCoolingSetpoint: 2600,
          systemMode: isOn ? 4 : 0,
          controlSequenceOfOperation: 2,
          minHeatSetpointLimit: 500,
          maxHeatSetpointLimit: 4000,
          absMinHeatSetpointLimit: 500,
          absMaxHeatSetpointLimit: 4000,
          // PRES feature (Presets) — required by ThermostatServer.for(Thermostat) in matter.js
          presetTypes: [{ presetScenario: 1, numberOfPresets: 1, presetTypeFeatures: { automatic: false, supportsNames: false } }],
          numberOfPresets: 1,
          activePresetHandle: null,
          presets: [],
        },
      },
      handlers: {
        thermostat: {
          systemModeChange: async ({ systemMode }) => {
            await bridge.sendCommands(device.id, [{ code: powerCode, value: systemMode !== 0 }]);
          },
          occupiedHeatingSetpointChange: tempSetCode
            ? async ({ occupiedHeatingSetpoint }) => {
                await bridge.sendCommands(device.id, [{ code: tempSetCode, value: matterTempToTuya(occupiedHeatingSetpoint) }]);
              }
            : undefined,
        },
      },
    };
  }

  static rebind(platform, bridge, accessory) {
    const { powerCode, tempSetCode } = accessory.context;
    accessory.handlers = {
      thermostat: {
        systemModeChange: async ({ systemMode }) => {
          await bridge.sendCommands(accessory.context.deviceId, [{ code: powerCode, value: systemMode !== 0 }]);
        },
        occupiedHeatingSetpointChange: tempSetCode
          ? async ({ occupiedHeatingSetpoint }) => {
              await bridge.sendCommands(accessory.context.deviceId, [{ code: tempSetCode, value: matterTempToTuya(occupiedHeatingSetpoint) }]);
            }
          : undefined,
      },
    };
  }

  static async sync(platform, bridge, accessory, device) {
    const { powerCode, tempCurrentCode, tempSetCode } = accessory.context;
    const isOn = toBoolean(getStatusValue(device, powerCode), false);

    const state = { systemMode: isOn ? 4 : 0 };

    if (tempCurrentCode) {
      const raw = getStatusValue(device, tempCurrentCode);
      const val = tuyaTempToMatter(raw);
      if (val != null) state.localTemperature = val;
    }

    if (tempSetCode) {
      const raw = getStatusValue(device, tempSetCode);
      const val = tuyaTempToMatter(raw);
      if (val != null) state.occupiedHeatingSetpoint = val;
    }

    await bridge.safeUpdateAccessoryState(
      accessory.UUID,
      platform.api.matter.clusterNames.Thermostat,
      state,
    );
  }
}
