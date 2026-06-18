"use strict";

import BaseAccessory from "./base_accessory.mjs";

const RESET_DELAY_MS = 3000;

class VibrationSensorAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SENSOR,
      Service.MotionSensor,
    );

    this.statusArr = deviceConfig.status || [];

    this.motionDetected = false;
    this.lowBatteryStatus = 0;
    this._resetTimer = null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    service
      .getCharacteristic(Characteristic.MotionDetected)
      .onGet(() => this.motionDetected);

    if (this._hasBattery()) {
      service
        .getCharacteristic(Characteristic.StatusLowBattery)
        .onGet(() => this.lowBatteryStatus);
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "shock_state":
          if (statusMap.value === "vibration" || statusMap.value === "drop") {
            this._triggerMotion();
          }
          break;
        case "battery_percentage":
        case "battery_value":
        case "battery_state":
          this.lowBatteryStatus = this._parseBatteryStatus(
            statusMap.code,
            statusMap.value,
          );
          this.service
            .getCharacteristic(Characteristic.StatusLowBattery)
            .updateValue(this.lowBatteryStatus);
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  /**
   * אירוע רגעי: מסמן תנועה ומאפס אוטומטית אחרי 3 שניות.
   */
  _triggerMotion() {
    const { Characteristic } = this.platform.api.hap;
    const characteristic = this.service.getCharacteristic(
      Characteristic.MotionDetected,
    );

    this.motionDetected = true;
    characteristic.updateValue(true);

    if (this._resetTimer) clearTimeout(this._resetTimer);
    this._resetTimer = setTimeout(() => {
      this.motionDetected = false;
      characteristic.updateValue(false);
      this._resetTimer = null;
    }, RESET_DELAY_MS);
  }

  _hasBattery() {
    return this.statusArr.some((s) =>
      ["battery_percentage", "battery_value", "battery_state"].includes(s.code),
    );
  }

  _parseBatteryStatus(code, value) {
    if (code === "battery_percentage") return value <= 20 ? 1 : 0;
    if (code === "battery_value") return value <= 2000 ? 1 : 0;
    if (code === "battery_state")
      return value === "low" || value === "empty" ? 1 : 0;
    return 0;
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default VibrationSensorAccessory;
