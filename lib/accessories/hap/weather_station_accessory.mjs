"use strict";

import BaseAccessory from "./base_accessory.mjs";

class WeatherStationAccessory extends BaseAccessory {
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

    // איתור הערוצים הדינמיים (ToutCh1.. / HoutCh1..)
    const tempCodes = this._sortChannels(
      this.statusArr.filter((s) => /Tout(Ch)?\d+/i.test(s.code)).map((s) => s.code),
    );
    const humidityCodes = this._sortChannels(
      this.statusArr.filter((s) => /Hout(Ch)?\d+/i.test(s.code)).map((s) => s.code),
    );

    // ערוץ -> { code, service }
    this.tempChannels = tempCodes.map((code, index) => ({
      code,
      service:
        index === 0
          ? this.service
          : this.homebridgeAccessory.getServiceById(
              Service.TemperatureSensor,
              `temp_${index + 1}`,
            ) ||
            this.homebridgeAccessory.addService(
              Service.TemperatureSensor,
              `${this._sanitizeName(deviceConfig.name)} Temp ${index + 1}`,
              `temp_${index + 1}`,
            ),
      value: 0,
    }));

    this.humidityChannels = humidityCodes.map((code, index) => ({
      code,
      service:
        this.homebridgeAccessory.getServiceById(
          Service.HumiditySensor,
          `humidity_${index + 1}`,
        ) ||
        this.homebridgeAccessory.addService(
          Service.HumiditySensor,
          `${this._sanitizeName(deviceConfig.name)} Humidity ${index + 1}`,
          `humidity_${index + 1}`,
        ),
      value: 0,
    }));

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;

    for (const channel of this.tempChannels) {
      channel.service
        .getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -100, maxValue: 100, minStep: 0.1 })
        .onGet(() => channel.value);
    }

    for (const channel of this.humidityChannels) {
      channel.service
        .getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .onGet(() => channel.value);
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      const tempCh = this.tempChannels.find((c) => c.code === statusMap.code);
      if (tempCh) {
        tempCh.value = this._clamp(
          statusMap.value / this._getScale(statusMap.code),
          -100,
          100,
        );
        tempCh.service
          .getCharacteristic(Characteristic.CurrentTemperature)
          .updateValue(tempCh.value);
        continue;
      }

      const humCh = this.humidityChannels.find((c) => c.code === statusMap.code);
      if (humCh) {
        humCh.value = this._clamp(
          statusMap.value / this._getScale(statusMap.code),
          0,
          100,
        );
        humCh.service
          .getCharacteristic(Characteristic.CurrentRelativeHumidity)
          .updateValue(humCh.value);
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  _sortChannels(codes) {
    return codes.sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, "")) || 0;
      const nb = parseInt(b.replace(/\D/g, "")) || 0;
      return na - nb;
    });
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

export default WeatherStationAccessory;
