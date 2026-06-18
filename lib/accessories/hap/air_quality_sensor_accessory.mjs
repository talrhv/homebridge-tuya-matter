"use strict";

import BaseAccessory from "./base_accessory.mjs";

class AirQualitySensorAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SENSOR,
      Service.AirQualitySensor,
    );

    this.statusArr = deviceConfig.status || [];
    this.functionArr = deviceConfig.functions || [];

    this.aqCode = ["pm25_value", "air_quality"].find((c) =>
      this.statusArr.some((s) => s.code === c),
    );
    this.pm25Code = "pm25_value";
    this.pm10Code = ["pm10_value", "pm10"].find((c) =>
      this.statusArr.some((s) => s.code === c),
    );
    this.vocCode = ["voc_value", "tvoc"].find((c) =>
      this.statusArr.some((s) => s.code === c),
    );
    this.tempCodes = ["va_temperature", "temp_indoor", "temp_current"];
    this.humidityCodes = ["va_humidity", "humidity_value"];

    this.airQuality = 0; // UNKNOWN
    this.densities = {}; // code -> value
    this.tempValue = null;
    this.humidityValue = null;

    const { Service: Svc } = platform.api.hap;
    this.tempService = this.statusArr.some((s) => this.tempCodes.includes(s.code))
      ? this.homebridgeAccessory.getService(Svc.TemperatureSensor) ||
        this.homebridgeAccessory.addService(
          Svc.TemperatureSensor,
          `${this._sanitizeName(deviceConfig.name)} Temperature`,
        )
      : null;
    this.humidityService = this.statusArr.some((s) =>
      this.humidityCodes.includes(s.code),
    )
      ? this.homebridgeAccessory.getService(Svc.HumiditySensor) ||
        this.homebridgeAccessory.addService(
          Svc.HumiditySensor,
          `${this._sanitizeName(deviceConfig.name)} Humidity`,
        )
      : null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    service
      .getCharacteristic(Characteristic.AirQuality)
      .onGet(() => this.airQuality);

    if (this.pm25Code && this.statusArr.some((s) => s.code === this.pm25Code)) {
      service
        .getCharacteristic(Characteristic.PM2_5Density)
        .onGet(() => this.densities[this.pm25Code] ?? 0);
    }
    if (this.pm10Code) {
      service
        .getCharacteristic(Characteristic.PM10Density)
        .onGet(() => this.densities[this.pm10Code] ?? 0);
    }
    if (this.vocCode) {
      service
        .getCharacteristic(Characteristic.VOCDensity)
        .onGet(() => this.densities[this.vocCode] ?? 0);
    }

    if (this.tempService) {
      this.tempService
        .getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -100, maxValue: 100, minStep: 0.1 })
        .onGet(() => this.tempValue ?? 0);
    }
    if (this.humidityService) {
      this.humidityService
        .getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .onGet(() => this.humidityValue ?? 0);
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      const { code, value } = statusMap;

      if (code === this.aqCode) {
        this.airQuality = this._toAirQuality(code, value);
        this.service
          .getCharacteristic(Characteristic.AirQuality)
          .updateValue(this.airQuality);
      }

      if (code === this.pm25Code) {
        this.densities[code] = this._clamp(value / this._getScale(code), 0, 1000);
        this.service
          .getCharacteristic(Characteristic.PM2_5Density)
          .updateValue(this.densities[code]);
      }
      if (code === this.pm10Code) {
        this.densities[code] = this._clamp(value / this._getScale(code), 0, 1000);
        this.service
          .getCharacteristic(Characteristic.PM10Density)
          .updateValue(this.densities[code]);
      }
      if (code === this.vocCode) {
        this.densities[code] = this._clamp(value / this._getScale(code), 0, 1000);
        this.service
          .getCharacteristic(Characteristic.VOCDensity)
          .updateValue(this.densities[code]);
      }

      if (this.tempService && this.tempCodes.includes(code)) {
        this.tempValue = this._clamp(value / this._getScale(code), -100, 100);
        this.tempService
          .getCharacteristic(Characteristic.CurrentTemperature)
          .updateValue(this.tempValue);
      }
      if (this.humidityService && this.humidityCodes.includes(code)) {
        this.humidityValue = this._clamp(value / this._getScale(code), 0, 100);
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

  /**
   * המרת ערך PM2.5 (מספרי) או דירוג איכות (enum) לדלי של HomeKit.
   */
  _toAirQuality(code, value) {
    const { AirQuality } = this.platform.api.hap.Characteristic;

    if (typeof value === "string") {
      const map = {
        great: AirQuality.EXCELLENT,
        good: AirQuality.GOOD,
        mild: AirQuality.FAIR,
        medium: AirQuality.INFERIOR,
        severe: AirQuality.POOR,
      };
      return map[value] ?? AirQuality.UNKNOWN;
    }

    const v = this._clamp(value / this._getScale(code), 0, 1000);
    if (v <= 10) return AirQuality.EXCELLENT;
    if (v <= 50) return AirQuality.GOOD;
    if (v <= 100) return AirQuality.FAIR;
    if (v <= 200) return AirQuality.INFERIOR;
    return AirQuality.POOR;
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

export default AirQualitySensorAccessory;
