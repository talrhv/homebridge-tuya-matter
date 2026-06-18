"use strict";

import BaseAccessory from "./base_accessory.mjs";

class Co2SensorAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SENSOR,
      Service.CarbonDioxideSensor,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    this.alarmCodes = ["co2_status", "co2_state"];
    this.co2Detected = 0;
    this.co2Level = null;
    this.levelScale = this._getScale("co2_value");

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    service
      .getCharacteristic(Characteristic.CarbonDioxideDetected)
      .onGet(() => this.co2Detected);

    if (this.statusArr.some((s) => s.code === "co2_value")) {
      service
        .getCharacteristic(Characteristic.CarbonDioxideLevel)
        .onGet(() => this.co2Level ?? 0);
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      if (this.alarmCodes.includes(statusMap.code)) {
        this.co2Detected = this._isAlarm(statusMap.value)
          ? Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
          : Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL;
        this.service
          .getCharacteristic(Characteristic.CarbonDioxideDetected)
          .updateValue(this.co2Detected);
      }

      if (statusMap.code === "co2_value") {
        this.co2Level = this._clamp(
          statusMap.value / this.levelScale,
          0,
          100000,
        );
        this.service
          .getCharacteristic(Characteristic.CarbonDioxideLevel)
          .updateValue(this.co2Level);
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  _isAlarm(value) {
    return value === "alarm" || value === "1" || value === 1 || value === true;
  }

  _clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  _getScale(code) {
    const func = this.functionArr.find((f) => f.code === code);
    if (func) {
      try {
        const values = JSON.parse(func.values);
        return Math.pow(10, values.scale || 0);
      } catch (e) {
        return 1;
      }
    }
    return 1;
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default Co2SensorAccessory;
