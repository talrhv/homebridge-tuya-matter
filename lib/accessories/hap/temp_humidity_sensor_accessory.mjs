"use strict";

import BaseAccessory from "./base_accessory.mjs";

class TempHumiditySensorAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SENSOR,
      Service.TemperatureSensor,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    this.tempCodes = ["va_temperature", "temp_current"];
    this.humidityCodes = ["va_humidity", "humidity_value"];

    this.tempValue = 0;
    this.humidityValue = null;

    // השירות הראשי הוא הטמפרטורה; שירות הלחות נוסף בנפרד.
    this.humidityService = this.statusArr.some((s) =>
      this.humidityCodes.includes(s.code),
    )
      ? this.homebridgeAccessory.getService(Service.HumiditySensor) ||
        this.homebridgeAccessory.addService(
          Service.HumiditySensor,
          `${this._sanitizeName(deviceConfig.name)} Humidity`,
        )
      : null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;

    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -100, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.tempValue);

    if (this.humidityService) {
      this.humidityService
        .getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .onGet(() => this.humidityValue ?? 0);
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      if (this.tempCodes.includes(statusMap.code)) {
        const scale = this._getScale(statusMap.code);
        this.tempValue = this._clamp(statusMap.value / scale, -100, 100);
        this.service
          .getCharacteristic(Characteristic.CurrentTemperature)
          .updateValue(this.tempValue);
      }

      if (this.humidityService && this.humidityCodes.includes(statusMap.code)) {
        const scale = this._getScale(statusMap.code);
        this.humidityValue = this._clamp(statusMap.value / scale, 0, 100);
        this.humidityService
          .getCharacteristic(Characteristic.CurrentRelativeHumidity)
          .updateValue(this.humidityValue);
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

export default TempHumiditySensorAccessory;
