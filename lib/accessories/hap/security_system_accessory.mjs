"use strict";

import BaseAccessory from "./base_accessory.mjs";

class SecuritySystemAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.SECURITY_SYSTEM,
      Service.SecuritySystem,
    );

    this.statusArr = deviceConfig.status || [];

    this.masterMap = null;
    this.sosMap = null;
    this.isNightArm = false;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    service
      .getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .onGet(() => this._currentState());

    service
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .onGet(() => this._targetState())
      .onSet(async (value) => this._setTarget(value));
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      if (statusMap.code === "master_mode") this.masterMap = statusMap;
      if (statusMap.code === "sos_state" || statusMap.code === "sos")
        this.sosMap = statusMap;
    }

    if (isRefresh && this._didInitStatus) {
      this.service
        .getCharacteristic(Characteristic.SecuritySystemCurrentState)
        .updateValue(this._currentState());
      this.service
        .getCharacteristic(Characteristic.SecuritySystemTargetState)
        .updateValue(this._targetState());
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  _currentState() {
    const { SecuritySystemCurrentState } = this.platform.api.hap.Characteristic;
    if (this.sosMap?.value) {
      return SecuritySystemCurrentState.ALARM_TRIGGERED;
    }
    switch (this.masterMap?.value) {
      case "arm":
        return SecuritySystemCurrentState.AWAY_ARM;
      case "home":
        return this.isNightArm
          ? SecuritySystemCurrentState.NIGHT_ARM
          : SecuritySystemCurrentState.STAY_ARM;
      case "disarmed":
      default:
        return SecuritySystemCurrentState.DISARMED;
    }
  }

  _targetState() {
    const { SecuritySystemTargetState } = this.platform.api.hap.Characteristic;
    switch (this.masterMap?.value) {
      case "arm":
        return SecuritySystemTargetState.AWAY_ARM;
      case "home":
        return this.isNightArm
          ? SecuritySystemTargetState.NIGHT_ARM
          : SecuritySystemTargetState.STAY_ARM;
      case "disarmed":
      default:
        return SecuritySystemTargetState.DISARM;
    }
  }

  async _setTarget(value) {
    const { SecuritySystemTargetState } = this.platform.api.hap.Characteristic;
    const commands = [];

    // ביטול דריכה מנקה גם מצב SOS אם פעיל.
    if (value === SecuritySystemTargetState.DISARM && this.sosMap?.value) {
      commands.push({ code: this.sosMap.code, value: false });
    }

    this.isNightArm = value === SecuritySystemTargetState.NIGHT_ARM;

    let mode = "disarmed";
    if (value === SecuritySystemTargetState.AWAY_ARM) mode = "arm";
    else if (
      value === SecuritySystemTargetState.STAY_ARM ||
      value === SecuritySystemTargetState.NIGHT_ARM
    )
      mode = "home";

    commands.push({ code: "master_mode", value: mode });
    await this._send(commands);
  }

  async _send(commands) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, { commands });
    } catch (error) {
      this.log.error(`[SET] Failed to send security command:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default SecuritySystemAccessory;
