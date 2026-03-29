"use strict";

import BaseAccessory from "./base_accessory.mjs";

const DEFAULT_SPEED_COUNT = 3;

class Fanv2Accessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;
    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.FAN,
      Service.Fanv2,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    // Core Maps
    this.switchMap = null;
    this.modeMap = null;
    this.lockMap = null;
    this.directionMap = null;
    this.speedMap = null;
    this.swingMap = null; // Horizontal swing
    
    // Light Maps
    this.switchLed = null;
    this.brightValue = null;
    this.tempValueMap = null; // Color Temperature

    // Sensor & Extras
    this.tempSensorMap = null;
    this.customSwitchesMap = new Map();

    // Initialize Services
    this.addLightService();
    this.addTemperatureService();
    this.addCustomSwitches();

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  addLightService() {
    const { Service, Characteristic } = this.platform.api.hap;
    const hasLight = this.statusArr.some((item) => item.code === "light");

    if (hasLight) {
      this.lightService =
        this.homebridgeAccessory.getService(Service.Lightbulb) ||
        this.homebridgeAccessory.addService(
          Service.Lightbulb,
          this.deviceConfig.name + " Light",
        );

      this.lightService.setCharacteristic(
        Characteristic.Name,
        this.deviceConfig.name + " Light",
      );
    }
  }

  addTemperatureService() {
    const { Service, Characteristic } = this.platform.api.hap;
    const hasTemp = this.statusArr.some((item) => item.code === "temp");

    if (hasTemp) {
      this.temperatureService =
        this.homebridgeAccessory.getService(Service.TemperatureSensor) ||
        this.homebridgeAccessory.addService(
          Service.TemperatureSensor,
          this.deviceConfig.name + " Temperature",
        );
    }
  }

  addCustomSwitches() {
    const { Service } = this.platform.api.hap;
    
    const customFeatures = [
      { code: "fan_vertical", name: "Vertical Swing" },
      { code: "anion", name: "Ionizer" },
      { code: "humidifier", name: "Humidifier" },
      { code: "oxygan", name: "Oxygen" },
      { code: "fan_cool", name: "Cooling" },
      { code: "fan_beep", name: "Beep Sound" }
    ];

    for (const feature of customFeatures) {
      const exists = this.statusArr.some((item) => item.code === feature.code);
      if (exists) {
        const service = 
          this.homebridgeAccessory.getServiceById(Service.Switch, feature.code) ||
          this.homebridgeAccessory.addService(Service.Switch, feature.name, feature.code);
        
        this.customSwitchesMap.set(feature.code, { service, statusMap: null });
      }
    }
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    // --- Fan Active (On/Off) ---
    service
      .getCharacteristic(Characteristic.Active)
      .onGet(() =>
        this.switchMap?.value
          ? Characteristic.Active.ACTIVE
          : Characteristic.Active.INACTIVE,
      )
      .onSet(async (value) => {
        await this.sendTuyaCommand(Characteristic.Active, value);
      });

    // --- Target Fan State (Auto/Manual) ---
    if (this.modeMap) {
      service
        .getCharacteristic(Characteristic.TargetFanState)
        .onGet(() =>
          this.modeMap.value === "smart" || this.modeMap.value === "auto"
            ? Characteristic.TargetFanState.AUTO
            : Characteristic.TargetFanState.MANUAL,
        )
        .onSet(async (value) => {
          await this.sendTuyaCommand(Characteristic.TargetFanState, value);
        });
    }

    // --- Rotation Speed ---
    if (this.speedMap) {
      service
        .getCharacteristic(Characteristic.RotationSpeed)
        .onGet(() => this._tuyaSpeedToHbPercentage())
        .onSet(async (value) => {
          await this.sendTuyaCommand(Characteristic.RotationSpeed, value);
        });
    }

    // --- Swing Mode (Horizontal) ---
    if (this.swingMap) {
      service
        .getCharacteristic(Characteristic.SwingMode)
        .onGet(() => 
            this.swingMap.value === "auto" || this.swingMap.value === true
            ? 1 : 0
        )
        .onSet(async (value) => await this.sendTuyaCommand(Characteristic.SwingMode, value));
    }

    // --- Lock / Direction ---
    if (this.lockMap) {
      service
        .getCharacteristic(Characteristic.LockPhysicalControls)
        .onGet(() => (this.lockMap.value ? 1 : 0))
        .onSet(async (value) => await this.sendTuyaCommand(Characteristic.LockPhysicalControls, value));
    }

    if (this.directionMap) {
      service
        .getCharacteristic(Characteristic.RotationDirection)
        .onGet(() => (this.directionMap.value === "forward" ? 0 : 1))
        .onSet(async (value) => await this.sendTuyaCommand(Characteristic.RotationDirection, value));
    }

    // --- Light Service Handlers ---
    if (this.lightService) {
      this.lightService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.switchLed?.value || false)
        .onSet(async (value) => await this.sendTuyaCommand(Characteristic.On, value));

      if (this.brightValue) {
        this.lightService
          .getCharacteristic(Characteristic.Brightness)
          .onGet(() => {
            const range = this.getFunctionRange(this.brightValue.code, 10, 1000);
            return Math.floor(((this.brightValue.value - range.min) * 100) / (range.max - range.min));
          })
          .onSet(async (value) => await this.sendTuyaCommand(Characteristic.Brightness, value));
      }

      if (this.tempValueMap) {
        this.lightService
          .getCharacteristic(Characteristic.ColorTemperature)
          .onGet(() => {
             // Tuya: 0 (Warm) - 255 (Cold) -> HomeKit: 140 (Cold) - 500 (Warm)
             const percent = this.tempValueMap.value / 255;
             return Math.floor(500 - (percent * 360));
          })
          .onSet(async (value) => await this.sendTuyaCommand(Characteristic.ColorTemperature, value));
      }
    }

    // --- Temperature Sensor ---
    if (this.temperatureService && this.tempSensorMap) {
      this.temperatureService
        .getCharacteristic(Characteristic.CurrentTemperature)
        .onGet(() => this.tempSensorMap.value);
    }

    // --- Custom Switches ---
    for (const [code, switchData] of this.customSwitchesMap.entries()) {
      switchData.service
        .getCharacteristic(Characteristic.On)
        .onGet(() => {
          const val = switchData.statusMap?.value;
          return val === "auto" || val === true; 
        })
        .onSet(async (value) => await this.sendCustomSwitchCommand(code, value));
    }
  }

  async sendTuyaCommand(characteristic, value) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      const param = this.getSendParam(characteristic, value);
      if (!param || !param.commands || param.commands.length === 0) return;
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, param);
    } catch (error) {
      this.log.error(`[SET] Failed to set ${characteristic.name}:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async sendCustomSwitchCommand(code, hbValue) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {

      const isEnumAuto = code === "fan_vertical";
      const value = isEnumAuto ? (hbValue ? "auto" : "off") : Boolean(hbValue);
      
      const param = { commands: [{ code, value }] };
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, param);
    } catch (error) {
      this.log.error(`[SET] Failed to set custom switch ${code}:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "switch":
        case "fan_switch":
        case "switch_fan":
          this.switchMap = statusMap;
          this.service.getCharacteristic(Characteristic.Active).updateValue(statusMap.value ? 1 : 0);
          break;
        case "mode":
          this.modeMap = statusMap;
          this.service.getCharacteristic(Characteristic.TargetFanState).updateValue(
            statusMap.value === "smart" || statusMap.value === "auto" ? 1 : 0
          );
          break;
        case "fan_speed":
        case "fan_speed_percent":
          this.speedMap = statusMap;
          this.service.getCharacteristic(Characteristic.RotationSpeed).updateValue(this._tuyaSpeedToHbPercentage());
          break;
        case "fan_horizontal":
        case "swing":
          this.swingMap = statusMap;
          this.service.getCharacteristic(Characteristic.SwingMode).updateValue(
            statusMap.value === "auto" || statusMap.value === true ? 1 : 0
          );
          break;
        case "light":
          this.switchLed = statusMap;
          this.lightService?.getCharacteristic(Characteristic.On).updateValue(statusMap.value);
          break;
        case "bright_value":
          this.brightValue = statusMap;
          if (this.lightService) {
              const range = this.getFunctionRange(statusMap.code, 10, 1000);
              const pct = Math.floor(((statusMap.value - range.min) * 100) / (range.max - range.min));
              this.lightService.getCharacteristic(Characteristic.Brightness).updateValue(pct);
          }
          break;
        case "temp_value":
          this.tempValueMap = statusMap;
          if (this.lightService) {
              const percent = statusMap.value / 255;
              this.lightService.getCharacteristic(Characteristic.ColorTemperature).updateValue(Math.floor(500 - (percent * 360)));
          }
          break;
        case "temp":
          this.tempSensorMap = statusMap;
          this.temperatureService?.getCharacteristic(Characteristic.CurrentTemperature).updateValue(statusMap.value);
          break;
        default:
  
          if (this.customSwitchesMap.has(statusMap.code)) {
            const switchData = this.customSwitchesMap.get(statusMap.code);
            switchData.statusMap = statusMap;
            switchData.service.getCharacteristic(Characteristic.On).updateValue(
              statusMap.value === "auto" || statusMap.value === true
            );
          }
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  _tuyaSpeedToHbPercentage() {
    if (!this.speedMap) return 0;
    const rawValue = this.speedMap.value;

    if (typeof rawValue === "string") {
      const count = this.getSpeedFunctionLevel(this.speedMap.code);
      return Math.floor(parseInt(rawValue) * (100 / count));
    }

    const range = this.getFunctionRange(this.speedMap.code, 1, 100);
    return Math.floor(((rawValue - range.min) * 100) / (range.max - range.min));
  }

  getSendParam(name, hbValue) {
    const { Characteristic } = this.platform.api.hap;
    let code, value;

    switch (name) {
      case Characteristic.Active:
        code = this.switchMap.code;
        value = Boolean(hbValue);
        break;
      case Characteristic.TargetFanState:
        code = this.modeMap.code;
        value = hbValue === Characteristic.TargetFanState.AUTO ? "smart" : "nature";
        break;
      case Characteristic.RotationSpeed:
        code = this.speedMap.code;
        if (typeof this.speedMap.value === "string") {
          const count = this.getSpeedFunctionLevel(code);
          value = String(Math.min(count, Math.max(1, Math.ceil(hbValue / (100 / count)))));
        } else {
          const range = this.getFunctionRange(code, 1, 100);
          value = Math.floor((hbValue * (range.max - range.min)) / 100 + range.min);
        }
        break;
      case Characteristic.SwingMode:
        code = this.swingMap.code;
        value = hbValue === 1 ? "auto" : "off";
        break;
      case Characteristic.On:
        code = "light";
        value = Boolean(hbValue);
        break;
      case Characteristic.Brightness:
        code = this.brightValue.code;
        const bRange = this.getFunctionRange(code, 10, 1000);
        value = Math.floor((hbValue * (bRange.max - bRange.min)) / 100 + bRange.min);
        break;
      case Characteristic.ColorTemperature:
        code = this.tempValueMap.code;
        let percent = (500 - hbValue) / 360;
        value = Math.floor(percent * 255);
        break;
    }
    
    if (code) {
        return { commands: [{ code, value }] };
    }
    return null;
  }

  getFunctionRange(code, defaultMin = 1, defaultMax = 100) {
    const func = this.functionArr.find((f) => f.code === code);
    if (func && func.values) {
      try {
        const range = JSON.parse(func.values);
        return { 
            min: parseInt(range.min) || defaultMin, 
            max: parseInt(range.max) || defaultMax 
        };
      } catch (e) {}
    }
    return { min: defaultMin, max: defaultMax };
  }

  getSpeedFunctionLevel(code) {
    const func = this.functionArr.find((f) => f.code === code);
    if (func && func.values) {
      try {
        const val = JSON.parse(func.values);
        return val.range ? val.range.length : DEFAULT_SPEED_COUNT;
      } catch (e) {}
    }
    return DEFAULT_SPEED_COUNT;
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default Fanv2Accessory;