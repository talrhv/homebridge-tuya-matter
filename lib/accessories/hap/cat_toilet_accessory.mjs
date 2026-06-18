"use strict";

import BaseAccessory from "./base_accessory.mjs";

const SUB_SWITCHES = [
  { code: "auto_clean", label: "Auto Clean" },
  { code: "manual_clean", label: "Manual Clean" },
  { code: "deodorization", label: "Deodorization" },
  { code: "uv", label: "UV Sterilization" },
];

class CatToiletAccessory extends BaseAccessory {
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

    this.states = new Map(); // code -> value

    // מתגי משנה
    this.subSwitches = SUB_SWITCHES.filter((sw) =>
      this.statusArr.some((s) => s.code === sw.code),
    ).map((sw) => ({
      ...sw,
      service:
        this.homebridgeAccessory.getServiceById(Service.Switch, sw.code) ||
        this.homebridgeAccessory.addService(
          Service.Switch,
          `${this._sanitizeName(deviceConfig.name)} ${sw.label}`,
          sw.code,
        ),
    }));

    this.lightService = this.statusArr.some((s) => s.code === "light")
      ? this.homebridgeAccessory.getServiceById(Service.Lightbulb, "cat_light") ||
        this.homebridgeAccessory.addService(
          Service.Lightbulb,
          `${this._sanitizeName(deviceConfig.name)} Mood Light`,
          "cat_light",
        )
      : null;

    this.occupancyService = this.statusArr.some((s) => s.code === "status")
      ? this.homebridgeAccessory.getService(Service.OccupancySensor) ||
        this.homebridgeAccessory.addService(
          Service.OccupancySensor,
          `${this._sanitizeName(deviceConfig.name)} Status`,
          "cat_status",
        )
      : null;

    this.filterService = this.statusArr.some((s) => s.code === "notification")
      ? this.homebridgeAccessory.getService(Service.FilterMaintenance) ||
        this.homebridgeAccessory.addService(
          Service.FilterMaintenance,
          `${this._sanitizeName(deviceConfig.name)} Waste Box`,
          "cat_waste",
        )
      : null;

    this.hasFault = this.statusArr.some((s) => s.code === "fault");

    this._didInitStatus = false;
    this.refreshAccessoryServiceIfNeed(this.statusArr, false);
  }

  initStatus() {
    const { Characteristic } = this.platform.api.hap;

    // מתג ראשי (הפעלה)
    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => Boolean(this.states.get("switch")))
      .onSet(async (value) => {
        await this._send("switch", Boolean(value));
      });

    if (this.hasFault) {
      this.service
        .getCharacteristic(Characteristic.StatusFault)
        .onGet(() =>
          (this.states.get("fault") || 0) > 0
            ? Characteristic.StatusFault.GENERAL_FAULT
            : Characteristic.StatusFault.NO_FAULT,
        );
    }

    for (const sw of this.subSwitches) {
      sw.service
        .getCharacteristic(Characteristic.On)
        .onGet(() => Boolean(this.states.get(sw.code)))
        .onSet(async (value) => {
          await this._send(sw.code, Boolean(value));
        });
    }

    if (this.lightService) {
      this.lightService
        .getCharacteristic(Characteristic.On)
        .onGet(() => Boolean(this.states.get("light")))
        .onSet(async (value) => {
          await this._send("light", Boolean(value));
        });
    }

    if (this.occupancyService) {
      this.occupancyService
        .getCharacteristic(Characteristic.OccupancyDetected)
        .onGet(() => this._occupancy());
    }

    if (this.filterService) {
      this.filterService
        .getCharacteristic(Characteristic.FilterChangeIndication)
        .onGet(() => this._filterChange());
    }
  }

  refreshAccessoryServiceIfNeed(statusArr, isRefresh) {
    const { Characteristic } = this.platform.api.hap;

    for (const statusMap of statusArr) {
      this.states.set(statusMap.code, statusMap.value);

      if (!isRefresh) continue;

      switch (statusMap.code) {
        case "switch":
          this.service
            .getCharacteristic(Characteristic.On)
            .updateValue(Boolean(statusMap.value));
          break;
        case "light":
          this.lightService
            ?.getCharacteristic(Characteristic.On)
            .updateValue(Boolean(statusMap.value));
          break;
        case "status":
          this.occupancyService
            ?.getCharacteristic(Characteristic.OccupancyDetected)
            .updateValue(this._occupancy());
          break;
        case "notification":
          this.filterService
            ?.getCharacteristic(Characteristic.FilterChangeIndication)
            .updateValue(this._filterChange());
          break;
        case "fault":
          if (this.hasFault) {
            this.service
              .getCharacteristic(Characteristic.StatusFault)
              .updateValue(
                (statusMap.value || 0) > 0
                  ? Characteristic.StatusFault.GENERAL_FAULT
                  : Characteristic.StatusFault.NO_FAULT,
              );
          }
          break;
        default: {
          const sw = this.subSwitches.find((s) => s.code === statusMap.code);
          if (sw) {
            sw.service
              .getCharacteristic(Characteristic.On)
              .updateValue(Boolean(statusMap.value));
          }
        }
      }
    }

    if (!this._didInitStatus) {
      this.initStatus();
      this._didInitStatus = true;
    }
  }

  _occupancy() {
    const { OccupancyDetected } = this.platform.api.hap.Characteristic;
    const active = ["cleaning", "uv", "deodorization"];
    return active.includes(this.states.get("status"))
      ? OccupancyDetected.OCCUPANCY_DETECTED
      : OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  _filterChange() {
    const { FilterChangeIndication } = this.platform.api.hap.Characteristic;
    // ביט 0 = תיבת פסולת מלאה.
    return (this.states.get("notification") || 0) & 1
      ? FilterChangeIndication.CHANGE_FILTER
      : FilterChangeIndication.FILTER_OK;
  }

  async _send(code, value) {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    try {
      await this.platform.tuyaOpenApi.sendCommand(this.deviceId, {
        commands: [{ code, value }],
      });
      this.states.set(code, value);
    } catch (error) {
      this.log.error(`[SET][${code}] Failed to send cat toilet command:`, error);
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  updateState(data) {
    this.refreshAccessoryServiceIfNeed(data.status, true);
  }
}

export default CatToiletAccessory;
