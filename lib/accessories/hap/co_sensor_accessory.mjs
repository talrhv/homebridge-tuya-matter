"use strict";

import BaseAccessory from "./base_accessory.mjs";

class CoSensorAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SENSOR,
      Service.CarbonMonoxideSensor,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    this.alarmCodes = ["co_status", "co_state"];
    this.coDetected = 0;
    this.coLevel = null;
    this.levelScale = this._getScale("co_value");

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    service
      .getCharacteristic(Characteristic.CarbonMonoxideDetected)
      .onGet(() => this.coDetected);

    if (this.statusArr.some((s) => s.code === "co_value")) {
      service
        .getCharacteristic(Characteristic.CarbonMonoxideLevel)
        .onGet(() => this.coLevel ?? 0);
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      if (this.alarmCodes.includes(statusMap.code)) {
        this.coDetected = this._isAlarm(statusMap.value)
          ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
          : Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
        this.service
          .getCharacteristic(Characteristic.CarbonMonoxideDetected)
          .updateValue(this.coDetected);
      }

      if (statusMap.code === "co_value") {
        this.coLevel = this._clamp(statusMap.value / this.levelScale, 0, 100);
        this.service
          .getCharacteristic(Characteristic.CarbonMonoxideLevel)
          .updateValue(this.coLevel);
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

export default CoSensorAccessory;
