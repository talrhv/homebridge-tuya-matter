"use strict";

import {
  baseIdentity,
  pickSupportedCode,
  POWER_CODES,
  BRIGHTNESS_CODES,
  COLOR_TEMP_CODES,
  COLOR_CODES,
  WORK_MODE_CODES,
  getStatusValue,
  readBrightnessPercent,
  readColorTempPercent,
  readHsColor,
  toBoolean,
  percentToMatterLevel,
  matterLevelToPercent,
  colorTempPercentToMireds,
  miredsToColorTempPercent,
  degreesToMatterHue,
  matterHueToDegrees,
  percentToMatterSat,
  matterSatToPercent,
  getNumericRangeForCode,
  percentToRange,
} from "./_shared.mjs";

const CATEGORIES = new Set(["dj", "dd", "fwd", "tgq", "xdd", "dc", "tgkg"]);

const DEFAULT_COLOR_TEMP_PHYSICAL_MIN_MIREDS = 147;
const DEFAULT_COLOR_TEMP_PHYSICAL_MAX_MIREDS = 454;

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, numeric));
}

function getColorTempBounds() {
  return {
    minMireds: DEFAULT_COLOR_TEMP_PHYSICAL_MIN_MIREDS,
    maxMireds: DEFAULT_COLOR_TEMP_PHYSICAL_MAX_MIREDS,
  };
}

function getCurrentColorTempMireds(device, tempCode) {
  const { minMireds, maxMireds } = getColorTempBounds();
  return clamp(
    colorTempPercentToMireds(readColorTempPercent(device, tempCode)),
    minMireds,
    maxMireds,
  );
}

function getColorControlColorMode(platform, device, context) {
  const workMode = context.workModeCode
    ? getStatusValue(device, context.workModeCode)
    : getStatusValue(device, WORK_MODE_CODES);

  if (context.supportsColor && workMode === "colour") {
    return platform.api.matter.types.ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
  }

  if (context.supportsColorTemp) {
    return platform.api.matter.types.ColorControl.ColorMode.ColorTemperatureMireds;
  }

  if (context.supportsColor) {
    return platform.api.matter.types.ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
  }

  return undefined;
}

function buildInitialColorControlState(platform, device, context) {
  const colorControl = {};

  if (context.supportsColorTemp && context.tempCode) {
    const { minMireds, maxMireds } = getColorTempBounds();

    // Order matters here. Matter validates colorTemperatureMireds against the
    // physical bounds, so publish the bounds and coupling attribute first.
    colorControl.colorTempPhysicalMinMireds = minMireds;
    colorControl.colorTempPhysicalMaxMireds = maxMireds;
    colorControl.coupleColorTempToLevelMinMireds = minMireds;
    colorControl.colorTemperatureMireds = getCurrentColorTempMireds(device, context.tempCode);
  }

  if (context.supportsColor && context.colorCode) {
    const hsColor = readHsColor(device, context.colorCode);
    if (hsColor) {
      colorControl.currentHue = degreesToMatterHue(hsColor.h);
      colorControl.currentSaturation = percentToMatterSat(hsColor.s);
    }
  }

  const colorMode = getColorControlColorMode(platform, device, context);
  if (colorMode !== undefined) {
    colorControl.colorMode = colorMode;
  }

  return colorControl;
}

export default class LightMatterAccessory {
  static id = "light";

  static matches(device) {
    return CATEGORIES.has(device?.category);
  }

  static create(platform, bridge, device) {
    const powerCode = pickSupportedCode(device, POWER_CODES);
    if (!powerCode) return null;

    const brightnessCode = pickSupportedCode(device, BRIGHTNESS_CODES);
    const tempCode = pickSupportedCode(device, COLOR_TEMP_CODES);
    const colorCode = pickSupportedCode(device, COLOR_CODES);
    const workModeCode = pickSupportedCode(device, WORK_MODE_CODES);

    const supportsBrightness = Boolean(brightnessCode);

    // Matter ColorTemperatureLight and ExtendedColorLight assume level control.
    // Tuya category dj normally provides bright_value[_v2], but if it does not,
    // we degrade the bridged representation instead of publishing an invalid shape.
    const supportsColorTemp = supportsBrightness && Boolean(tempCode);
    const supportsColor = supportsBrightness && Boolean(colorCode);

    const deviceType = supportsColor
      ? platform.api.matter.deviceTypes.ExtendedColorLight
      : supportsColorTemp
        ? platform.api.matter.deviceTypes.ColorTemperatureLight
        : supportsBrightness
          ? platform.api.matter.deviceTypes.DimmableLight
          : platform.api.matter.deviceTypes.OnOffLight;

    const context = {
      matterAccessoryType: this.id,
      powerCode,
      brightnessCode,
      tempCode,
      colorCode,
      workModeCode,
      supportsBrightness,
      supportsColorTemp,
      supportsColor,
    };

    const accessory = {
      ...baseIdentity(bridge, device, context),
      deviceType,
      clusters: {
        onOff: {
          onOff: toBoolean(getStatusValue(device, powerCode), false),
        },
      },
      handlers: this.buildHandlers(platform, bridge, context, device),
    };

    if (supportsBrightness) {
      accessory.clusters.levelControl = {
        currentLevel: percentToMatterLevel(readBrightnessPercent(device, brightnessCode)),
        minLevel: 1,
        maxLevel: 254,
      };
    }

    if (supportsColor || supportsColorTemp) {
      accessory.clusters.colorControl = buildInitialColorControlState(platform, device, context);
    }

    return accessory;
  }

  static rebind(platform, bridge, accessory, device) {
    accessory.handlers = this.buildHandlers(platform, bridge, accessory.context ?? {}, device);
  }

  static buildHandlers(platform, bridge, context, discoveredDevice) {
    const handlers = {
      onOff: {
        on: async () => bridge.sendCommands(context.deviceId, [{ code: context.powerCode, value: true }]),
        off: async () => bridge.sendCommands(context.deviceId, [{ code: context.powerCode, value: false }]),
      },
    };

    if (context.supportsBrightness && context.brightnessCode) {
      handlers.levelControl = {
        moveToLevelWithOnOff: async ({ level }) => {
          const source = discoveredDevice ?? bridge.latestDevices.get(context.deviceId);
          const range = getNumericRangeForCode(source, context.brightnessCode, 10, 1000);
          const value = percentToRange(matterLevelToPercent(level), range.min, range.max);
          await bridge.sendCommands(context.deviceId, [{ code: context.brightnessCode, value }]);
        },
      };
    }

    if (context.supportsColor || context.supportsColorTemp) {
      handlers.colorControl = {};
    }

    if (context.supportsColorTemp && context.tempCode) {
      handlers.colorControl.moveToColorTemperatureLogic = async ({ colorTemperatureMireds }) => {
        const source = discoveredDevice ?? bridge.latestDevices.get(context.deviceId);
        const range = getNumericRangeForCode(source, context.tempCode, 0, 1000);
        const { minMireds, maxMireds } = getColorTempBounds();
        const safeMireds = clamp(colorTemperatureMireds, minMireds, maxMireds);
        const value = percentToRange(miredsToColorTempPercent(safeMireds), range.min, range.max);
        const commands = [{ code: context.tempCode, value }];
        if (context.workModeCode) commands.push({ code: context.workModeCode, value: "white" });
        await bridge.sendCommands(context.deviceId, commands);
      };
    }

    if (context.supportsColor && context.colorCode) {
      handlers.colorControl.moveToHueAndSaturationLogic = async ({ hue, saturation }) => {
        const source = discoveredDevice ?? bridge.latestDevices.get(context.deviceId);
        const brightnessPercent = context.brightnessCode
          ? readBrightnessPercent(source, context.brightnessCode)
          : 100;
        const commands = [{
          code: context.colorCode,
          value: JSON.stringify({
            h: matterHueToDegrees(hue),
            s: Math.max(0, Math.min(1000, Math.round(matterSatToPercent(saturation) * 10))),
            v: Math.max(0, Math.min(1000, Math.round(brightnessPercent * 10))),
          }),
        }];
        if (context.workModeCode) commands.push({ code: context.workModeCode, value: "colour" });
        await bridge.sendCommands(context.deviceId, commands);
      };
    }

    return handlers;
  }

  static async sync(platform, bridge, accessory, device) {
    const uuid = accessory.UUID;
    const context = accessory.context ?? {};

    await bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.OnOff, {
      onOff: toBoolean(getStatusValue(device, context.powerCode), false),
    });

    if (context.supportsBrightness && context.brightnessCode) {
      await bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.LevelControl, {
        currentLevel: percentToMatterLevel(readBrightnessPercent(device, context.brightnessCode)),
      });
    }

    if ((context.supportsColorTemp || context.supportsColor) && platform.api.matter.clusterNames.ColorControl) {
      const colorState = {};

      if (context.supportsColorTemp && context.tempCode) {
        const { minMireds, maxMireds } = getColorTempBounds();
        colorState.colorTempPhysicalMinMireds = minMireds;
        colorState.colorTempPhysicalMaxMireds = maxMireds;
        colorState.coupleColorTempToLevelMinMireds = minMireds;
        colorState.colorTemperatureMireds = getCurrentColorTempMireds(device, context.tempCode);
      }

      if (context.supportsColor && context.colorCode) {
        const hsColor = readHsColor(device, context.colorCode);
        if (hsColor) {
          colorState.currentHue = degreesToMatterHue(hsColor.h);
          colorState.currentSaturation = percentToMatterSat(hsColor.s);
        }
      }

      const colorMode = getColorControlColorMode(platform, device, context);
      if (colorMode !== undefined) {
        colorState.colorMode = colorMode;
      }

      if (Object.keys(colorState).length > 0) {
        await bridge.safeUpdateAccessoryState(
          uuid,
          platform.api.matter.clusterNames.ColorControl,
          colorState,
        );
      }
    }
  }
}
