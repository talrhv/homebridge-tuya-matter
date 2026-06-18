"use strict";

import BaseAccessory from "./base_accessory.mjs";

class LightSensorAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SENSOR,
      Service.LightSensor,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    this.luxCodes = ["bright_value", "bright_value_1", "illuminance_value"];
    this.luxValue = 0.0001;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;

    this.service
      .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .onGet(() => this.luxValue);
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      if (this.luxCodes.includes(statusMap.code)) {
        const scale = this._getScale(statusMap.code);
        this.luxValue = this._clamp(statusMap.value / scale, 0.0001, 100000);
        this.service
          .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
          .updateValue(this.luxValue);
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
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

export default LightSensorAccessory;
