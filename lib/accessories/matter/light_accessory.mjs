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

const CATEGORIES = new Set(["dj", "dd", "fwd", "tgq", "xdd", "dc", "tgkg"]);

const DEFAULT_COLOR_TEMP_PHYSICAL_MIN_MIREDS = 147;
const DEFAULT_COLOR_TEMP_PHYSICAL_MAX_MIREDS = 454;

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function getColorModeValue(platform, mode) {
  const ColorMode = platform?.api?.matter?.types?.ColorControl?.ColorMode;
  return mode === "temperature"
    ? (ColorMode?.ColorTemperatureMireds ?? 2)
    : (ColorMode?.CurrentHueAndCurrentSaturation ?? 0);
}

function isV2Code(code) {
  return typeof code === "string" && code.endsWith("_v2");
}

function getRange(device, code, defaultMin, defaultMax) {
  if (!code) return { min: defaultMin, max: defaultMax };
  return getNumericRangeForCode(device, code, defaultMin, defaultMax);
}

// Dynamically scale Brightness based on the schemas provided
function readBrightnessPercent(device, code) {
  if (!code) return 100;
  const isDJ_V1 = device?.category === "dj" && !isV2Code(code);
  const fallback = isDJ_V1 ? { min: 25, max: 255 } : { min: 10, max: 1000 };
  const range = getRange(device, code, fallback.min, fallback.max);
  return rangeToPercent(getStatusValue(device, code), range, 100);
}

// Dynamically scale Temp based on the schemas provided
function readColorTempPercent(device, code) {
  if (!code) return 100;
  const isDJ_V1 = device?.category === "dj" && !isV2Code(code);
  const fallback = isDJ_V1 ? { min: 0, max: 255 } : { min: 0, max: 1000 };
  const range = getRange(device, code, fallback.min, fallback.max);
  return rangeToPercent(getStatusValue(device, code), range, 100);
}

function parseColorPayload(raw) {
  if (typeof raw === "object" && raw) return raw;
  if (typeof raw !== "string") return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    const text = raw.trim();
    if (/^[0-9a-fA-F]{12}$/.test(text)) {
      const h = Number.parseInt(text.slice(0, 4), 16);
      const s = Number.parseInt(text.slice(4, 8), 16);
      const v = Number.parseInt(text.slice(8, 12), 16);
      if ([h, s, v].every(Number.isFinite)) return { h, s, v };
    }
  }
  return null;
}

// Extracts 1000 or 255 natively from Tuya JSON schema definitions
function getDeviceColorScale(device, colorCode) {
  if (isV2Code(colorCode)) return 1000;
  try {
    const schemaList = device?.functions || device?.properties || [];
    const func = schemaList.find(f => f.code === colorCode);
    if (func && func.values) {
      const vals = typeof func.values === 'string' ? JSON.parse(func.values) : func.values;
      if (vals?.s?.max !== undefined) return Number(vals.s.max);
    }
  } catch {}
  return (device?.category && device.category !== "dj") ? 1000 : 255;
}

function getTargetColorMode(device, workModeCode) {
  try {
    const schemaList = device?.functions || device?.properties || [];
    const func = schemaList.find(f => f.code === workModeCode);
    if (func && func.values) {
      const valsStr = typeof func.values === 'string' ? func.values : JSON.stringify(func.values);
      if (valsStr.includes('"color"')) return "color";
    }
  } catch {}
  return "colour"; // Fallback to 'colour' since all new categories expect it
}

function readTuyaHsColor(device, colorCode) {
  if (!colorCode) return null;
  const parsed = parseColorPayload(getStatusValue(device, colorCode));
  if (!parsed) return null;

  const svMax = getDeviceColorScale(device, colorCode);
  return {
    h: clamp(Number(parsed.h ?? 0), 0, 360),
    s: clamp(Math.round((Number(parsed.s ?? 0) / svMax) * 100), 0, 100),
    v: clamp(Math.round((Number(parsed.v ?? 1000) / svMax) * 100), 0, 100),
  };
}

function encodeTuyaHsColor(device, colorCode, hueDegrees, saturationPercent, valuePercent) {
  const svMax = getDeviceColorScale(device, colorCode);

  const h = clamp(Math.round(hueDegrees), 0, 360);
  const s = clamp(Math.round((clamp(saturationPercent, 0, 100) / 100) * svMax), 0, svMax);
  const v = clamp(Math.round((clamp(valuePercent, 0, 100) / 100) * svMax), 0, svMax);

  if (isV2Code(colorCode)) return { h, s, v };

  return h.toString(16).padStart(4, '0') + 
         s.toString(16).padStart(4, '0') + 
         v.toString(16).padStart(4, '0');
}

function resolveWorkMode(device, context) {
  const val = context.workModeCode ? getStatusValue(device, context.workModeCode) : getStatusValue(device, WORK_MODE_CODES);
  if (typeof val === "string" && val) return val;
  if (context.supportsColor && !context.supportsColorTemp) return "colour";
  if (context.supportsColorTemp) return "white";
  return null;
}

function getCurrentBrightnessPercent(device, context) {
  const workMode = resolveWorkMode(device, context);

  if (context.colorCode && (!context.brightnessCode || workMode === "colour" || workMode === "color")) {
    const hs = readTuyaHsColor(device, context.colorCode);
    if (hs) return hs.v;
  }

  if (context.brightnessCode) return readBrightnessPercent(device, context.brightnessCode);
  
  if (context.colorCode) {
    const hs = readTuyaHsColor(device, context.colorCode);
    if (hs) return hs.v;
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
  if (maxRgb > 0) { r /= maxRgb; g /= maxRgb; b /= maxRgb; }

  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * (((b - r) / delta) + 2);
    else hue = 60 * (((r - g) / delta) + 4);
  }

  if (hue < 0) hue += 360;
  return {
    hue: clamp(Math.round(hue), 0, 360),
    saturation: clamp(Math.round(max === 0 ? 0 : (delta / max) * 100), 0, 100),
  };
}

export default class LightMatterAccessory {
  static id = "light";

  static matches(device) {
    return CATEGORIES.has(device?.category);
  }

  static hasDifferentShape(existing, desired) {
    const getClusterSignature = (value) => JSON.stringify(Object.keys(value ?? {}).sort());
    if (getClusterSignature(existing?.clusters) !== getClusterSignature(desired?.clusters)) return true;

    const existingContext = existing?.context ?? {};
    const desiredContext = desired?.context ?? {};
    const keys = ["supportsLevel", "supportsBrightness", "supportsColorTemp", "supportsColor", "powerCode", "brightnessCode", "tempCode", "colorCode"];
    return keys.some((key) => existingContext?.[key] !== desiredContext?.[key]);
  }

  static create(platform, bridge, device) {
    const powerCode = pickSupportedCode(device, POWER_CODES);
    if (!powerCode) return null;

    const brightnessCode = pickSupportedCode(device, BRIGHTNESS_CODES);
    const tempCode = pickSupportedCode(device, COLOR_TEMP_CODES);
    const colorCode = pickSupportedCode(device, COLOR_CODES);
    const workModeCode = pickSupportedCode(device, WORK_MODE_CODES);

    const supportsBrightness = Boolean(brightnessCode);
    const supportsLevel = Boolean(brightnessCode || colorCode);
    const supportsColorTemp = Boolean(tempCode) && supportsLevel;
    const supportsColor = Boolean(colorCode) && supportsLevel;

    const deviceType = supportsColor ? platform.api.matter.deviceTypes.ExtendedColorLight : 
                       supportsColorTemp ? platform.api.matter.deviceTypes.ColorTemperatureLight : 
                       supportsLevel ? platform.api.matter.deviceTypes.DimmableLight : 
                       platform.api.matter.deviceTypes.OnOffLight;

    const context = { matterAccessoryType: this.id, deviceId: device.id, category: device?.category, powerCode, brightnessCode, tempCode, colorCode, workModeCode, supportsLevel, supportsBrightness, supportsColorTemp, supportsColor };

    const accessory = {
      ...baseIdentity(bridge, device, context),
      deviceType,
      clusters: { onOff: { onOff: toBoolean(getStatusValue(device, powerCode), false) } },
      handlers: this.buildHandlers(platform, bridge, context, device),
    };

    if (supportsLevel) {
      accessory.clusters.levelControl = { currentLevel: percentToMatterLevel(getCurrentBrightnessPercent(device, context)), minLevel: 1, maxLevel: 254 };
    }

    if (supportsColor || supportsColorTemp) {
      const state = { colorTempPhysicalMinMireds: DEFAULT_COLOR_TEMP_PHYSICAL_MIN_MIREDS, colorTempPhysicalMaxMireds: DEFAULT_COLOR_TEMP_PHYSICAL_MAX_MIREDS, coupleColorTempToLevelMinMireds: DEFAULT_COLOR_TEMP_PHYSICAL_MIN_MIREDS, colorTemperatureMireds: context.supportsColorTemp && context.tempCode ? clamp(colorTempPercentToMireds(readColorTempPercent(device, context.tempCode)), DEFAULT_COLOR_TEMP_PHYSICAL_MIN_MIREDS, DEFAULT_COLOR_TEMP_PHYSICAL_MAX_MIREDS) : 250 };
      state.features = { hueAndSaturation: supportsColor, enhancedHue: supportsColor, colorLoop: supportsColor, xy: supportsColor, colorTemperature: supportsColorTemp };
      state.colorCapabilities = (supportsColorTemp ? 16 : 0) | (supportsColor ? 9 : 0);

      if (supportsColor && colorCode) {
        const hs = readTuyaHsColor(device, colorCode);
        if (hs) { state.currentHue = degreesToMatterHue(hs.h); state.currentSaturation = percentToMatterSat(hs.s); }
      }

      state.colorMode = resolveWorkMode(device, context) === "white" && supportsColorTemp ? getColorModeValue(platform, "temperature") : getColorModeValue(platform, "hs");
      accessory.clusters.colorControl = state;
    }

    return accessory;
  }

  static rebind(platform, bridge, accessory, device) {
    if (!accessory.context) accessory.context = {};
    accessory.handlers = this.buildHandlers(platform, bridge, accessory.context, device);
  }

  static buildHandlers(platform, bridge, context, device) {
    const getSource = () => bridge.latestDevices.get(context.deviceId) ?? device;

    const optimisticCache = {
      color: null, brightness: null, timeoutId: null,
      update(normalizedColor, brightnessPercent) {
        if (normalizedColor) this.color = normalizedColor;
        if (brightnessPercent != null) this.brightness = brightnessPercent;
        if (this.timeoutId) clearTimeout(this.timeoutId);
        this.timeoutId = setTimeout(() => { this.color = null; this.brightness = null; }, 3000);
      }
    };

    const sendCommands = async (commands) => {
      const filtered = (commands ?? []).filter((entry) => entry && entry.code);
      if (filtered.length > 0) await bridge.sendCommands(context.deviceId, filtered);
    };

    const setLevelPercent = async (percent, options = {}) => {
      const safePercent = clamp(Math.round(percent), 0, 100);
      const source = getSource();
      const workMode = resolveWorkMode(source, context);
      const commands = [];

      if (options.withOnOff) {
        if (safePercent <= 0) return sendCommands([{ code: context.powerCode, value: false }]);
        commands.push({ code: context.powerCode, value: true });
      }

      if (context.colorCode && (!context.brightnessCode || workMode === "colour" || workMode === "color")) {
        const hs = optimisticCache.color ?? readTuyaHsColor(source, context.colorCode) ?? { h: 0, s: 0, v: 100 };
        const next = { h: hs.h, s: hs.s, v: safePercent };
        
        if (context.workModeCode) commands.push({ code: context.workModeCode, value: getTargetColorMode(source, context.workModeCode) });
        commands.push({ code: context.colorCode, value: encodeTuyaHsColor(source, context.colorCode, next.h, next.s, next.v) });
        
        optimisticCache.update(next, safePercent);
        return sendCommands(commands);
      }

      if (context.brightnessCode) {
        const isDJ_V1 = source?.category === "dj" && !isV2Code(context.brightnessCode);
        const fallback = isDJ_V1 ? { min: 25, max: 255 } : { min: 10, max: 1000 };
        const range = getRange(source, context.brightnessCode, fallback.min, fallback.max);
        
        commands.push({ code: context.brightnessCode, value: percentToRange(safePercent, range.min, range.max) });
        optimisticCache.update(undefined, safePercent);
      }

      await sendCommands(commands);
    };

    const setHueSaturation = async (hueDegrees, saturationPercent, valuePercent = null) => {
      if (!context.colorCode) return;
      const source = getSource();
      const nextValue = valuePercent == null ? (optimisticCache.brightness ?? getCurrentBrightnessPercent(source, context)) : clamp(Math.round(valuePercent), 0, 100);
      const next = { h: clamp(Math.round(hueDegrees), 0, 360), s: clamp(Math.round(saturationPercent), 0, 100), v: nextValue };
      const commands = [];

      if (context.workModeCode) commands.push({ code: context.workModeCode, value: getTargetColorMode(source, context.workModeCode) });
      commands.push({ code: context.colorCode, value: encodeTuyaHsColor(source, context.colorCode, next.h, next.s, next.v) });
      
      optimisticCache.update(next, nextValue);
      await sendCommands(commands);
    };

    const handlers = { onOff: { on: async () => sendCommands([{ code: context.powerCode, value: true }]), off: async () => sendCommands([{ code: context.powerCode, value: false }]) } };

    if (context.supportsLevel) handlers.levelControl = { moveToLevel: async ({ level }) => setLevelPercent(matterLevelToPercent(level), { withOnOff: false }), moveToLevelWithOnOff: async ({ level }) => setLevelPercent(matterLevelToPercent(level), { withOnOff: true }) };

    if (context.supportsColor || context.supportsColorTemp) handlers.colorControl = { stopAllColorMovement: async () => undefined };

    if (context.supportsColorTemp && context.tempCode) {
      handlers.colorControl.moveToColorTemperatureLogic = async ({ colorTemperatureMireds }) => {
        const source = getSource();
        const safeMireds = clamp(colorTemperatureMireds, DEFAULT_COLOR_TEMP_PHYSICAL_MIN_MIREDS, DEFAULT_COLOR_TEMP_PHYSICAL_MAX_MIREDS);
        
        const isDJ_V1 = source?.category === "dj" && !isV2Code(context.tempCode);
        const fallback = isDJ_V1 ? { min: 0, max: 255 } : { min: 0, max: 1000 };
        const range = getRange(source, context.tempCode, fallback.min, fallback.max);
        
        const commands = [];
        if (context.workModeCode) commands.push({ code: context.workModeCode, value: "white" });
        commands.push({ code: context.tempCode, value: percentToRange(miredsToColorTempPercent(safeMireds), range.min, range.max) });
        
        await sendCommands(commands);
      };
    }

    if (context.supportsColor && context.colorCode) {
      handlers.colorControl.moveToHueAndSaturationLogic = async ({ hue, saturation }) => setHueSaturation(matterHueToDegrees(hue), matterSatToPercent(saturation));
      handlers.colorControl.moveToHueLogic = async ({ targetHue }) => { const hs = optimisticCache.color ?? readTuyaHsColor(getSource(), context.colorCode) ?? { h: 0, s: 0, v: 100 }; await setHueSaturation(matterHueToDegrees(targetHue), hs.s, hs.v); };
      handlers.colorControl.moveToSaturationLogic = async ({ targetSaturation }) => { const hs = optimisticCache.color ?? readTuyaHsColor(getSource(), context.colorCode) ?? { h: 0, s: 0, v: 100 }; await setHueSaturation(hs.h, matterSatToPercent(targetSaturation), hs.v); };
      handlers.colorControl.moveToColorLogic = async ({ targetX, targetY }) => { const b = optimisticCache.brightness ?? getCurrentBrightnessPercent(getSource(), context); const { hue, saturation } = xyToHueAndSaturation(targetX, targetY); await setHueSaturation(hue, saturation, b); };
    }

    return handlers;
  }

  static async sync(platform, bridge, accessory, device) {
    const uuid = accessory.UUID, context = accessory.context ?? {};
    await bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.OnOff, { onOff: toBoolean(getStatusValue(device, context.powerCode), false) });

    if (context.supportsLevel && platform.api.matter.clusterNames.LevelControl) {
      await bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.LevelControl, { currentLevel: percentToMatterLevel(getCurrentBrightnessPercent(device, context)) });
    }

    if ((context.supportsColorTemp || context.supportsColor) && platform.api.matter.clusterNames.ColorControl) {
      const state = {};
      if (context.supportsColorTemp && context.tempCode) {
        state.colorTempPhysicalMinMireds = DEFAULT_COLOR_TEMP_PHYSICAL_MIN_MIREDS;
        state.colorTempPhysicalMaxMireds = DEFAULT_COLOR_TEMP_PHYSICAL_MAX_MIREDS;
        state.coupleColorTempToLevelMinMireds = DEFAULT_COLOR_TEMP_PHYSICAL_MIN_MIREDS;
        state.colorTemperatureMireds = clamp(colorTempPercentToMireds(readColorTempPercent(device, context.tempCode)), DEFAULT_COLOR_TEMP_PHYSICAL_MIN_MIREDS, DEFAULT_COLOR_TEMP_PHYSICAL_MAX_MIREDS);
      }

      if (context.supportsColor && context.colorCode) {
        const hs = readTuyaHsColor(device, context.colorCode);
        if (hs) { state.currentHue = degreesToMatterHue(hs.h); state.currentSaturation = percentToMatterSat(hs.s); }
      }

      state.colorMode = resolveWorkMode(device, context) === "white" && context.supportsColorTemp ? getColorModeValue(platform, "temperature") : getColorModeValue(platform, "hs");
      await bridge.safeUpdateAccessoryState(uuid, platform.api.matter.clusterNames.ColorControl, state);
    }
  }
}