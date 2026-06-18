"use strict";

import BaseAccessory from "./base_accessory.mjs";

const RESET_DELAY_MS = 500;

class PetFeederAccessory extends BaseAccessory {
  constructor(platform, homebridgeAccessory, deviceConfig) {
    const { Categories, Service } = platform.api.hap;

    super(
      platform,
      homebridgeAccessory,
      deviceConfig,
      Categories.OTHER,
      Service.Switch,
    );

    this.statusArr = deviceConfig.status || [];

    // קוד ההאכלה — ידנית או מהירה.
    this.feedCode = ["manual_feed", "quick_feed", "slow_feed"].find((c) =>
      this.statusArr.some((s) => s.code === c),
    );
    this.feedNumeric = this.feedCode === "manual_feed";
    this.batteryMap = null;
    this.feedStateMap = null;
    this.lightOn = false;

    this.batteryService = this.statusArr.some(
      (s) => s.code === "battery_percentage",
    )
      ? this.homebridgeAccessory.getService(Service.Battery) ||
        this.homebridgeAccessory.addService(
          Service.Battery,
          `${this._sanitizeName(deviceConfig.name)} Battery`,
        )
      : null;

    this.lightService = this.statusArr.some((s) => s.code === "light")
      ? this.homebridgeAccessory.getService(Service.Lightbulb) ||
        this.homebridgeAccessory.addService(
          Service.Lightbulb,
          `${this._sanitizeName(deviceConfig.name)} Light`,
          "feeder_light",
        )
      : null;

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;
    const service = this.service;

    service
      .getCharacteristic(Characteristic.On)
      .onGet(() => false)
      .onSet(async (value) => {
        if (value && this.feedCode) await this._triggerFeed();
      });

    // הזנת מצב האכלה כ-StatusActive (אם נתמך).
    if (this.statusArr.some((s) => s.code === "feed_state")) {
      service
        .getCharacteristic(Characteristic.StatusActive)
        .onGet(() => this.feedStateMap?.value === "feeding");
    }

    if (this.batteryService) {
      this.batteryService
        .getCharacteristic(Characteristic.BatteryLevel)
        .onGet(() => this.batteryMap?.value ?? 100);
      this.batteryService
        .getCharacteristic(Characteristic.StatusLowBattery)
        .onGet(() => ((this.batteryMap?.value ?? 100) <= 20 ? 1 : 0));
    }

    if (this.lightService) {
      this.lightService
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.lightOn)
        .onSet(async (value) => {
          await this._send([{ code: "light", value: Boolean(value) }]);
        });
    }
  }

  async _triggerFeed() {
    const { Characteristic, HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, {
        commands: [{ code: this.feedCode, value: this.feedNumeric ? 1 : true }],
      });
      setTimeout(() => {
        this.service.getCharacteristic(Characteristic.On).updateValue(false);
      }, RESET_DELAY_MS);
    } catch (error) {
      this.log.error(`[FEED] Failed to trigger feed:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      switch (statusMap.code) {
        case "battery_percentage":
          this.batteryMap = statusMap;
          if (this.batteryService) {
            this.batteryService
              .getCharacteristic(Characteristic.BatteryLevel)
              .updateValue(statusMap.value);
            this.batteryService
              .getCharacteristic(Characteristic.StatusLowBattery)
              .updateValue(statusMap.value <= 20 ? 1 : 0);
          }
          break;
        case "feed_state":
          this.feedStateMap = statusMap;
          this.service
            .getCharacteristic(Characteristic.StatusActive)
            .updateValue(statusMap.value === "feeding");
          break;
        case "light":
          this.lightOn = Boolean(statusMap.value);
          this.lightService
            ?.getCharacteristic(Characteristic.On)
            .updateValue(this.lightOn);
          break;
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  async _send(commands) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, { commands });
    } catch (error) {
      this.log.error(`[SET] Failed to send pet feeder command:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default PetFeederAccessory;
