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
  rangeToPercent,
} from "./_shared.mjs";

const CATEGORIES = new Set(["dj", "dd", "fwd", "tgq", "xdd", "dc", "tgkg", "wg2"]);

const DEFAULT_COLOR_TEMP_PHYSICAL_MIN_MIREDS = 147;
const DEFAULT_COLOR_TEMP_PHYSICAL_MAX_MIREDS = 454;

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, numeric));
}

function getColorModeValue(platform, mode) {
  const ColorMode = platform?.api?.matter?.types?.ColorControl?.ColorMode;
  if (mode === "temperature") {
    return ColorMode?.ColorTemperatureMireds ?? 2;
  }
  return ColorMode?.CurrentHueAndCurrentSaturation ?? 0;
}

function isV2Code(code) {
  return typeof code === "string" && code.endsWith("_v2");
}

function getBrightnessFallbackRange(code) {
  if (code === "bright_value") {
    return { min: 25, max: 255 };
  }
  return { min: 10, max: 1000 };
}

function getColorTempFallbackRange(code) {
  if (code === "temp_value") {
    return { min: 0, max: 255 };
  }
  return { min: 0, max: 1000 };
}

function getRangeForCode(source, code, fallback) {
  if (!code) {
    return fallback;
  }
  return getNumericRangeForCode(source, code, fallback.min, fallback.max);
}



function readBrightnessPercentFromSource(source, brightnessCode) {
  if (!brightnessCode) {
    return 100;
  }
  const range = getRangeForCode(source, brightnessCode, getBrightnessFallbackRange(brightnessCode));
  return rangeToPercent(getStatusValue(source, brightnessCode), range, 100);
}

function readColorTempPercentFromSource(source, tempCode) {
  if (!tempCode) {
    return 100;
  }
  const range = getRangeForCode(source, tempCode, getColorTempFallbackRange(tempCode));
  return rangeToPercent(getStatusValue(source, tempCode), range, 100);
}

function parseHexColorData(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^[0-9a-fA-F]{12}$/.test(text)) {
    return null;
  }

  const h = Number.parseInt(text.slice(0, 4), 16);
  const s = Number.parseInt(text.slice(4, 8), 16);
  const v = Number.parseInt(text.slice(8, 12), 16);

  if (![h, s, v].every(Number.isFinite)) {
    return null;
  }

  return { h, s, v };
}

function parseColorPayload(raw) {
  if (raw && typeof raw === "object") {
    return raw;
  }

  if (typeof raw !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // Fall through to hexadecimal decoding.
  }

  return parseHexColorData(raw);
}

function getDeviceColorScale(device, colorCode) {
  // 1. If it explicitly uses a _v2 code
  if (isV2Code(colorCode)) return 1000;
  
  // 2. dynamically extract the "max" from the exact JSON schema you found!
  try {
    const schemaList = device?.functions || device?.properties || [];
    const colorFunction = schemaList.find(f => f.code === colorCode);
    if (colorFunction && colorFunction.values) {
      const valuesJson = typeof colorFunction.values === 'string' 
        ? JSON.parse(colorFunction.values) 
        : colorFunction.values;
        
      if (valuesJson?.s?.max !== undefined) {
        return Number(valuesJson.s.max); // Dynamically returns 1000 straight from Tuya!
      }
    }
  } catch (e) {
    // Ignore JSON parse errors
  }

  // 3. Fallback: check if the device category is in the CATEGORIES set (which includes wg2)
  if (device?.category && CATEGORIES.has(device.category)) return 1000;
  
  return 255;
}

function getTargetColorMode(device, workModeCode) {
  // Do the exact same thing to determine if it wants "color" or "colour"
  try {
    const schemaList = device?.functions || device?.properties || [];
    const modeFunction = schemaList.find(f => f.code === workModeCode);
    if (modeFunction && modeFunction.values) {
      const valsStr = typeof modeFunction.values === 'string' ? modeFunction.values : JSON.stringify(modeFunction.values);
      if (valsStr.includes('"color"')) return "color";
      if (valsStr.includes('"colour"')) return "colour";
    }
  } catch (e) {}
  
  return (device?.category && CATEGORIES.has(device.category)) ? "color" : "colour";
}

function readTuyaHsColor(device, context) {
  if (!context.colorCode) return null;

  const raw = getStatusValue(device, context.colorCode);
  const parsed = parseColorPayload(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const rawHue = Number(parsed.h ?? 0);
  const rawSat = Number(parsed.s ?? 0);
  const rawVal = Number(parsed.v ?? 1000);

  // Get the exact scale dynamically
  const svMax = getDeviceColorScale(device, context.colorCode);

  return {
    h: clamp(rawHue, 0, 360),
    s: clamp(Math.round((rawSat / svMax) * 100), 0, 100),
    v: clamp(Math.round((rawVal / svMax) * 100), 0, 100),
  };
}

function encodeTuyaHsColor(device, context, hueDegrees, saturationPercent, valuePercent) {
  // Get the exact scale dynamically
  const svMax = getDeviceColorScale(device, context.colorCode);

  const h = clamp(Math.round(hueDegrees), 0, 360);
  const s = clamp(Math.round((clamp(saturationPercent, 0, 100) / 100) * svMax), 0, svMax);
  const v = clamp(Math.round((clamp(valuePercent, 0, 100) / 100) * svMax), 0, svMax);

  if (isV2Code(context.colorCode)) {
    return { h, s, v };
  }

  const hexH = h.toString(16).padStart(4, '0');
  const hexS = s.toString(16).padStart(4, '0');
  const hexV = v.toString(16).padStart(4, '0');
  return hexH + hexS + hexV;
}

function getTargetColorMode(context) {
  // wg2 devices heavily favor the American spelling
  return context.category === "wg2" ? "color" : "colour";
}

function getColorTempBounds() {
  return {
    minMireds: DEFAULT_COLOR_TEMP_PHYSICAL_MIN_MIREDS,
    maxMireds: DEFAULT_COLOR_TEMP_PHYSICAL_MAX_MIREDS,
  };
}

function getCurrentColorTempMireds(source, tempCode) {
  const { minMireds, maxMireds } = getColorTempBounds();
  return clamp(
    colorTempPercentToMireds(readColorTempPercentFromSource(source, tempCode)),
    minMireds,
    maxMireds,
  );
}

function resolveWorkMode(source, context) {
  const value = context.workModeCode
    ? getStatusValue(source, context.workModeCode)
    : getStatusValue(source, WORK_MODE_CODES);

  if (typeof value === "string" && value) {
    return value;
  }

  if (context.supportsColor && !context.supportsColorTemp) {
    return "colour";
  }

  if (context.supportsColorTemp) {
    return "white";
  }

  return null;
}

function getCurrentBrightnessPercent(source, context) {
  const workMode = resolveWorkMode(source, context);

  if (context.colorCode && (!context.brightnessCode || workMode === "colour" || workMode === "color")) {
    const hsColor = readTuyaHsColor(source, context);
    if (hsColor) {
      return hsColor.v;
    }
  }

  if (context.brightnessCode) {
    return readBrightnessPercentFromSource(source, context.brightnessCode);
  }

  if (context.colorCode) {
    const hsColor = readTuyaHsColor(source, context);
    if (hsColor) {
      return hsColor.v;
    }
  }

  return 100;
}

function xyToHueAndSaturation(targetX, targetY) {
  const x = clamp(Number(targetX) / 65535, 0.0001, 0.9999);
  const y = clamp(Number(targetY) / 65535, 0.0001, 0.9999);
  const z = Math.max(0, 1 - x - y);

  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * z;

  let r = (X * 1.656492) - (Y * 0.354851) - (Z * 0.255038);
  let g = (-X * 0.707196) + (Y * 1.655397) + (Z * 0.036152);
  let b = (X * 0.051713) - (Y * 0.121364) + (Z * 1.01153);

  r = Math.max(0, r);
  g = Math.max(0, g);
  b = Math.max(0, b);

  const maxRgb = Math.max(r, g, b);
  if (maxRgb > 0) {
    r /= maxRgb;
    g /= maxRgb;
    b /= maxRgb;
  }

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let hue = 0;
  if (delta > 0) {
    if (max === r) {
      hue = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      hue = 60 * (((b - r) / delta) + 2);
    } else {
      hue = 60 * (((r - g) / delta) + 4);
    }
  }

  if (hue < 0) {
    hue += 360;
  }

  const saturation = max === 0 ? 0 : (delta / max) * 100;

  return {
    hue: clamp(Math.round(hue), 0, 360),
    saturation: clamp(Math.round(saturation), 0, 100),
  };
}

function buildInitialColorControlState(platform, source, context) {
  const state = {};

  const { minMireds, maxMireds } = getColorTempBounds();
  state.colorTempPhysicalMinMireds = minMireds;
  state.colorTempPhysicalMaxMireds = maxMireds;
  state.coupleColorTempToLevelMinMireds = minMireds;

  if (context.supportsColorTemp && context.tempCode) {
    state.colorTemperatureMireds = getCurrentColorTempMireds(source, context.tempCode);
  } else {
    state.colorTemperatureMireds = 250; 
  }

  state.features = {
    hueAndSaturation: context.supportsColor,
    enhancedHue: context.supportsColor,
    colorLoop: context.supportsColor,
    xy: context.supportsColor,
    colorTemperature: context.supportsColorTemp,
  };

  let capabilities = 0;
  if (context.supportsColorTemp) capabilities |= 16;
  if (context.supportsColor) {
    capabilities |= 1;
    capabilities |= 8;
  }
  state.colorCapabilities = capabilities;

  if (context.supportsColor && context.colorCode) {
    const hsColor = readTuyaHsColor(source, context);
    if (hsColor) {
      state.currentHue = degreesToMatterHue(hsColor.h);
      state.currentSaturation = percentToMatterSat(hsColor.s);
    }
  }

  const workMode = resolveWorkMode(source, context);
  state.colorMode = workMode === "white" && context.supportsColorTemp
    ? getColorModeValue(platform, "temperature")
    : getColorModeValue(platform, "hs");

  return state;
}

function getClusterSignature(value) {
  return JSON.stringify(Object.keys(value ?? {}).sort());
}

export default class LightMatterAccessory {
  static id = "light";

  static matches(device) {
    return CATEGORIES.has(device?.category);
  }

  static hasDifferentShape(existing, desired) {
    if (getClusterSignature(existing?.clusters) !== getClusterSignature(desired?.clusters)) {
      return true;
    }

    const existingContext = existing?.context ?? {};
    const desiredContext = desired?.context ?? {};
    const keysToCompare = [
      "supportsLevel",
      "supportsBrightness",
      "supportsColorTemp",
      "supportsColor",
      "powerCode",
      "brightnessCode",
      "tempCode",
      "colorCode",
    ];

    return keysToCompare.some((key) => existingContext?.[key] !== desiredContext?.[key]);
  }

  static create(platform, bridge, device) {
    const powerCode = pickSupportedCode(device, POWER_CODES);
    if (!powerCode) {
      return null;
    }

    const brightnessCode = pickSupportedCode(device, BRIGHTNESS_CODES);
    const tempCode = pickSupportedCode(device, COLOR_TEMP_CODES);
    const colorCode = pickSupportedCode(device, COLOR_CODES);
    const workModeCode = pickSupportedCode(device, WORK_MODE_CODES);

    const supportsBrightness = Boolean(brightnessCode);
    const supportsLevel = Boolean(brightnessCode || colorCode);
    const supportsColorTemp = Boolean(tempCode) && supportsLevel;
    const supportsColor = Boolean(colorCode) && supportsLevel;

    const deviceType = supportsColor
      ? platform.api.matter.deviceTypes.ExtendedColorLight
      : supportsColorTemp
        ? platform.api.matter.deviceTypes.ColorTemperatureLight
        : supportsLevel
          ? platform.api.matter.deviceTypes.DimmableLight
          : platform.api.matter.deviceTypes.OnOffLight;

    const context = {
      matterAccessoryType: this.id,
      deviceId: device.id,
      category: device?.category,
      powerCode,
      brightnessCode,
      tempCode,
      colorCode,
      workModeCode,
      supportsLevel,
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

    if (supportsLevel) {
      accessory.clusters.levelControl = {
        currentLevel: percentToMatterLevel(getCurrentBrightnessPercent(device, context)),
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
    if (!accessory.context) {
      accessory.context = {};
    }
    // Inject the category so existing/cached devices get the fix
    accessory.context.category = device?.category;
    
    accessory.handlers = this.buildHandlers(platform, bridge, accessory.context, device);
  }

  static buildHandlers(platform, bridge, context, discoveredDevice) {
    const getSource = () => bridge.latestDevices.get(context.deviceId) ?? discoveredDevice;

    const optimisticCache = {
      color: null,      
      brightness: null, 
      timeoutId: null,
      update(normalizedColor, brightnessPercent) {
        if (normalizedColor) this.color = normalizedColor;
        if (brightnessPercent !== undefined && brightnessPercent !== null) this.brightness = brightnessPercent;
        
        if (this.timeoutId) clearTimeout(this.timeoutId);
        this.timeoutId = setTimeout(() => {
          this.color = null;
          this.brightness = null;
        }, 3000); 
      }
    };

    const sendCommands = async (commands) => {
      const filtered = (commands ?? []).filter((entry) => entry && entry.code);
      if (filtered.length === 0) {
        return;
      }
      await bridge.sendCommands(context.deviceId, filtered);
    };

    const setLevelPercent = async (percent, options = {}) => {
      const safePercent = clamp(Math.round(percent), 0, 100);
      const source = getSource();
      const workMode = resolveWorkMode(source, context);
      const commands = [];

      if (options.withOnOff === true) {
        if (safePercent <= 0) {
          commands.push({ code: context.powerCode, value: false });
          await sendCommands(commands);
          return;
        }
        commands.push({ code: context.powerCode, value: true });
      }

      if (context.colorCode && (!context.brightnessCode || workMode === "colour" || workMode === "color")) {
        const currentColor = optimisticCache.color ?? readTuyaHsColor(source, context) ?? { h: 0, s: 0, v: 100 };
        const nextColorNormalized = { h: currentColor.h, s: currentColor.s, v: safePercent };
        
        if (context.workModeCode) {
          commands.push({ code: context.workModeCode, value: getTargetColorMode(device, context.workModeCode) });
        }
        
        commands.push({
        code: context.colorCode,
        value: encodeTuyaHsColor(device, context, nextColorNormalized.h, nextColorNormalized.s, nextColorNormalized.v),
      });
        
        optimisticCache.update(nextColorNormalized, safePercent);
        await sendCommands(commands);
        return;
      }

      if (context.brightnessCode) {
        const range = getRangeForCode(source, context.brightnessCode, getBrightnessFallbackRange(context.brightnessCode));
        commands.push({
          code: context.brightnessCode,
          value: percentToRange(safePercent, range.min, range.max),
        });
        optimisticCache.update(undefined, safePercent);
      }

      await sendCommands(commands);
    };

    const setHueSaturation = async (hueDegrees, saturationPercent, valuePercent = null) => {
      if (!context.colorCode) {
        return;
      }

      const source = getSource();
      const nextValue = valuePercent == null
        ? (optimisticCache.brightness ?? getCurrentBrightnessPercent(source, context))
        : clamp(Math.round(valuePercent), 0, 100);

      const nextColorNormalized = {
        h: clamp(Math.round(hueDegrees), 0, 360),
        s: clamp(Math.round(saturationPercent), 0, 100),
        v: nextValue
      };

      const commands = [];

      if (context.workModeCode) {
        commands.push({ code: context.workModeCode, value: getTargetColorMode(device, context.workModeCode) });
      }
      
      commands.push({
        code: context.colorCode,
        value: encodeTuyaHsColor(device, context, nextColorNormalized.h, nextColorNormalized.s, nextColorNormalized.v),
      });
      
      optimisticCache.update(nextColorNormalized, nextValue);
      await sendCommands(commands);
    };

    const handlers = {
      onOff: {
        on: async () => sendCommands([{ code: context.powerCode, value: true }]),
        off: async () => sendCommands([{ code: context.powerCode, value: false }]),
      },
    };

    if (context.supportsLevel) {
      handlers.levelControl = {
        moveToLevel: async ({ level }) => setLevelPercent(matterLevelToPercent(level), { withOnOff: false }),
        moveToLevelWithOnOff: async ({ level }) => setLevelPercent(matterLevelToPercent(level), { withOnOff: true }),
      };
    }

    if (context.supportsColor || context.supportsColorTemp) {
      handlers.colorControl = {
        stopAllColorMovement: async () => undefined,
      };
    }

  if (context.supportsColorTemp && context.tempCode) {
      handlers.colorControl.moveToColorTemperatureLogic = async ({ colorTemperatureMireds }) => {
        const source = getSource();
        const range = getRangeForCode(source, context.tempCode, getColorTempFallbackRange(context.tempCode));
        const { minMireds, maxMireds } = getColorTempBounds();
        const safeMireds = clamp(colorTemperatureMireds, minMireds, maxMireds);
        
        const percent = miredsToColorTempPercent(safeMireds);
        const value = percentToRange(percent, range.min, range.max);

        const commands = [];
        if (context.workModeCode) {
          commands.push({ code: context.workModeCode, value: "white" }); // Temperature uses "white" mode
        }
        
        commands.push({
          code: context.tempCode,
          value: value,
        });
        
        await sendCommands(commands);
      };
    }

    if (context.supportsColor && context.colorCode) {
      handlers.colorControl.moveToHueAndSaturationLogic = async ({ hue, saturation }) => {
        await setHueSaturation(matterHueToDegrees(hue), matterSatToPercent(saturation));
      };

      handlers.colorControl.moveToHueLogic = async ({ targetHue }) => {
        const source = getSource();
        const currentColor = optimisticCache.color ?? readTuyaHsColor(source, context) ?? { h: 0, s: 0, v: 100 };
        await setHueSaturation(matterHueToDegrees(targetHue), currentColor.s, currentColor.v);
      };

      handlers.colorControl.moveToSaturationLogic = async ({ targetSaturation }) => {
        const source = getSource();
        const currentColor = optimisticCache.color ?? readTuyaHsColor(source, context) ?? { h: 0, s: 0, v: 100 };
        await setHueSaturation(currentColor.h, matterSatToPercent(targetSaturation), currentColor.v);
      };

      handlers.colorControl.moveToColorLogic = async ({ targetX, targetY }) => {
        const source = getSource();
        const brightnessPercent = optimisticCache.brightness ?? getCurrentBrightnessPercent(source, context);
        const converted = xyToHueAndSaturation(targetX, targetY);
        await setHueSaturation(converted.hue, converted.saturation, brightnessPercent);
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

    if (context.supportsLevel && platform.api.matter.clusterNames.LevelControl) {
      await bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.LevelControl, {
        currentLevel: percentToMatterLevel(getCurrentBrightnessPercent(device, context)),
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
        const hsColor = readTuyaHsColor(device, context.colorCode);
        if (hsColor) {
          colorState.currentHue = degreesToMatterHue(hsColor.h);
          colorState.currentSaturation = percentToMatterSat(hsColor.s);
        }
      }

      const workMode = resolveWorkMode(device, context);
      colorState.colorMode = workMode === "white" && context.supportsColorTemp
        ? getColorModeValue(platform, "temperature")
        : getColorModeValue(platform, "hs");

      await bridge.safeUpdateAccessoryState(
        uuid,
        platform.api.matter.clusterNames.ColorControl,
        colorState,
      );
    }
  }
  
}