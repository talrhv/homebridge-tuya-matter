"use strict";

import TuyaOpenAPI from "../lib/tuyaopenapi.mjs";
import TuyaSHOpenAPI from "../lib/tuyashopenapi.mjs";
import TuyaOpenMQ from "../lib/tuyamqttapi.mjs";
import TuyaMatterBridge from "../lib/matter_support.mjs";
import MqttPublisher, { buildPayload } from "../lib/mqtt_publisher.mjs";

// HAP Accessories
import OutletAccessory from "../lib/accessories/hap/outlet_accessory.mjs";
import LightAccessory from "../lib/accessories/hap/light_accessory.mjs";
import SwitchAccessory from "../lib/accessories/hap/switch_accessory.mjs";
import SmokeSensorAccessory from "../lib/accessories/hap/smokesensor_accessory.mjs";
import Fanv2Accessory from "../lib/accessories/hap/fanv2_accessory.mjs";
import HeaterAccessory from "../lib/accessories/hap/heater_accessory.mjs";
import GarageDoorAccessory from "../lib/accessories/hap/garagedoor_accessory.mjs";
import AirPurifierAccessory from "../lib/accessories/hap/air_purifier_accessory.mjs";
import WindowCoveringAccessory from "../lib/accessories/hap/window_covering_accessory.mjs";
import ContactSensorAccessory from "../lib/accessories/hap/contactsensor_accessory.mjs";
import LeakSensorAccessory from "../lib/accessories/hap/leak_sensor_accessory.mjs";
import PushAccessory from "../lib/accessories/hap/push_accessory.mjs";
import MotionSensorAccessory from "../lib/accessories/hap/motionsensor_accessory.mjs";
import ValveAccessory from "../lib/accessories/hap/valve_accessory.mjs";

import LogUtil from "../util/logutil.mjs";
import DataUtil from "../util/datautil.mjs";
import settings from "./settings.mjs";

const DEFAULT_PROJECT_TYPE = "1";

class TuyaPlatform {
  constructor(log, config, api) {
    this.api = api;
    this.config = config ?? {};

    this.PLUGIN_NAME = settings.PLUGIN_NAME;
    this.PLATFORM_NAME = settings.PLATFORM_NAME;

    this.log = new LogUtil(log, Boolean(this.config?.options?.debug));
    this.dataUtil = new DataUtil();
    this.matterReady = false;
    this.tutaInitialized = false;
    this.matterApiLoadPromise = null;
    this.devices = [];
    this.onMQTTMessage = this.onMQTTMessage.bind(this);

    if (!this.config?.options) {
      this.log.warn(
        "The config.json configuration is incorrect, disabling plugin.",
      );
      this.disabled = true;
      return;
    }

    this.disabled = false;

    // HAP caches
    this.accessories = new Map();
    this.deviceAccessories = new Map();

    // Matter cache + logic
    this.matterBridge = new TuyaMatterBridge(this);

    api.on("didFinishLaunching", async () => {
      await this.handleDidFinishLaunching();
    });

    api.on("shutdown", () => {
      this.cleanup();
    });
  }

  async handleDidFinishLaunching() {
    if (this.disabled) {
      return;
    }

    this.log.info("Initializing TuyaPlatform...");

    // Load the Matter API and re-register cached accessories from cache FIRST,
    // before the (slow) Tuya cloud login. Homebridge does not auto-recreate Matter
    // endpoints for cached accessories — only the plugin can. Doing it up front
    // keeps the bridge populated the instant Apple Home reconnects after a restart,
    // preventing accessories from being moved to the Default Room or dropped during
    // the otherwise-empty startup window.
    try {
      await this.loadMatterApi();
      this.matterReady = true;
      await this.matterBridge.registerCachedAccessories();
    } catch (error) {
      this.matterReady = false;
      this.log.warn(
        "[Matter] Failed to load the Matter API. Continuing without Matter support.",
      );
      this.log.debug(error?.stack || String(error));
    }

    // Tuya cloud login + device discovery + HAP setup + realtime MQTT updates.
    await this.initTuyaSDK(this.config);

    // Reconcile Matter accessories with live device data and register any devices
    // that could not be restored early (e.g. no persisted snapshot yet).
    if (this.matterReady) {
      await this.registerMatterDevices(this.devices);
    }
  }

  async loadMatterApi() {
    if (this.matterApiLoadPromise) {
      return this.matterApiLoadPromise;
    }

    if (typeof this.api?.loadMatterAPI !== "function") {
      throw new Error("Homebridge Matter API is unavailable in this runtime.");
    }

    this.matterApiLoadPromise = this.api.loadMatterAPI();

    try {
      await this.matterApiLoadPromise;
    } catch (error) {
      this.matterApiLoadPromise = null;
      throw error;
    }
  }

  cleanup() {
    this.tuyaOpenMQ?.stop();
    this.mqttPublisher?.stop();
    this.matterBridge.cleanup();
  }

  /**
   * Homebridge calls this to restore HAP accessories from cache.
   */
  configureAccessory(accessory) {
    if (this.disabled) {
      return;
    }

    this.log.debug(`Restoring accessory from cache: ${accessory.displayName}`);

    accessory.on("identify", () =>
      this.log.info(`${accessory.displayName} identify requested`),
    );

    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Homebridge calls this to restore Matter accessories from cache.
   * Cached Matter accessories are re-registered automatically after this callback.
   */
  async configureMatterAccessory(accessory) {

    if (this.disabled) {
      return;
    }

    this.log.debug(
      `[Matter] Restoring accessory from cache: ${accessory.displayName}`,
    );

    this.matterBridge.restoreAccessory(accessory, accessory.context?.device);
  }

  async initTuyaSDK(config) {
    if (this.disabled) {
      return;
    }

    const options = config.options ?? {};
    const projectType = String(options.projectType ?? DEFAULT_PROJECT_TYPE);

    try {
      this.tuyaOpenApi = await this.createTuyaClient(options, projectType);
    } catch (error) {
      this.log.error("Failed to initialize Tuya API. Check config.json.");
      this.log.error(error);
      return;
    }

    try {
      this.devices = await this.getDevices(projectType);
    } catch (error) {
      this.log.error("Failed to fetch Tuya devices.");
      this.log.error(error);
      return;
    }

    for (const device of this.devices) {
      this.addAccessory(device);
    }

    await this.startRealtimeUpdates(projectType);
  }

  async createTuyaClient(options, projectType) {
    if (projectType === "1") {
      const api = new TuyaOpenAPI(
        options.endPoint,
        options.accessId,
        options.accessKey,
        this.log,
      );

      await api.login(options.username, options.password);
      return api;
    }

    return new TuyaSHOpenAPI(
      options.accessId,
      options.accessKey,
      options.username,
      options.password,
      options.countryCode,
      options.appSchema,
      this.log,
      options.lang ?? "en",
      options.endPointOverride || null,
    );
  }

  async getDevices(projectType) {
    return projectType === "1"
      ? this.tuyaOpenApi.getDeviceList()
      : this.tuyaOpenApi.getDevices();
  }

  async registerMatterDevices(devices) {
    if (!this.matterReady) {
      return;
    }

    try {
      await this.matterBridge.registerDevices(devices);
    } catch (error) {
      this.log.error("Failed to register Matter accessories.");
      this.log.error(error);
    }
  }

  async startRealtimeUpdates(projectType) {
    try {
      const msgEncryptedVersion = projectType === "1" ? "2.0" : "1.0";
      const mq = new TuyaOpenMQ(
        this.tuyaOpenApi,
        msgEncryptedVersion,
        this.log,
      );

      this.tuyaOpenMQ = mq;
      mq.start();
      mq.addMessageListener(this.onMQTTMessage);

      this.mqttPublisher = new MqttPublisher({
        ...(this.config?.options?.mqttPublish ?? {}),
        log: this.log,
      });
      this.mqttPublisher.start();

      this.log.debug(
        "[Matter] Using MQTT events for device -> Home app state synchronization.",
      );
    } catch (error) {
      this.log.error("Failed to start Tuya MQTT.");
      this.log.error(error);
    }
  }

  isDeviceIgnored(deviceId, protocol) {
    const ignoreDevices = this.config?.options?.ignoreDevices ?? [];
    if (!Array.isArray(ignoreDevices) || !deviceId) return false;

    for (const entry of ignoreDevices) {
      if (typeof entry === "string") {
        if (entry === deviceId) return true;
        continue;
      }
      if (entry?.deviceId !== deviceId) continue;
      const ignoreFor = entry?.ignoreFor ?? "both";
      if (ignoreFor === "both" || ignoreFor === protocol) return true;
    }

    return false;
  }

  addAccessory(device) {
    if (this.disabled) {
      return;
    }

    const deviceType = device.category;
    const deviceId = device.id;
    const deviceName = device.name || "unnamed";

    const uuid = this.api.hap.uuid.generate(deviceId);
    if (this.deviceAccessories.has(uuid)) {
      this.log.debug(
        `Accessory already initialized and active: ${deviceName} (${deviceId})`,
      );
      return;
    }

    if (this.isDeviceIgnored(deviceId, "hap")) {
      this.log.debug(`Ignoring device for HAP as per config: ${deviceName}`);
      const cachedAccessory = this.accessories.get(uuid);
      if (cachedAccessory) {
        this.removeAccessory(cachedAccessory);
      }
      return;
    }

    const homebridgeAccessory = this.accessories.get(uuid);

    this.log.info(
      `Initializing accessory: ${deviceName} (${deviceType} / ${deviceId})`,
    );

    let deviceAccessory;

    switch (deviceType) {
      case "kj":
        deviceAccessory = new AirPurifierAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;
      case "dj":
      case "dd":
      case "fwd":
      case "tgq":
      case "xdd":
      case "dc":
      case "tgkg":
        deviceAccessory = new LightAccessory(this, homebridgeAccessory, device);
        break;
      case "cz":
      case "pc":
        deviceAccessory = new OutletAccessory(
          this,
          homebridgeAccessory,
          device,
          this.dataUtil.getSubService(device.status),
        );
        break;
      case "tdq":
      case "dlq":
        deviceAccessory = new SwitchAccessory(
          this,
          homebridgeAccessory,
          device,
          this.dataUtil.getSubService(device.status),
        );
        break;
      case "fs":
      case "fskg":
        deviceAccessory = new Fanv2Accessory(this, homebridgeAccessory, device);
        break;
      case "ywbj":
        deviceAccessory = new SmokeSensorAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;
      case "qn":
        deviceAccessory = new HeaterAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;
      case "ckmkzq":
        deviceAccessory = new GarageDoorAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;
      case "cl":
      case "clkg":
        deviceAccessory = new WindowCoveringAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;
      case "mcs":
        deviceAccessory = new ContactSensorAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;
      case "rqbj":
      case "jwbj":
        deviceAccessory = new LeakSensorAccessory(
          this,
          homebridgeAccessory,
          device,
        );
        break;
      case "szjqr":
        deviceAccessory = new PushAccessory(
          this,
          homebridgeAccessory,
          device,
          this.dataUtil.getSubService(device.status),
        );
        break;
      case "pir":
      case "hps":
      case "ms":
      case "gg": {
        const pirConfig = (this.config?.options?.motion || []).find(
          (entry) => !entry?.deviceId || entry?.deviceId === deviceId,
        ) ?? { overrideTuya: 0 };
        deviceAccessory = new MotionSensorAccessory(
          this,
          homebridgeAccessory,
          device,
          pirConfig.overrideTuya,
        );
        break;
      }
      case "kg": {
        // Some kg-category devices are actually presence sensors (radar/mmWave)
        if (device.status?.some((s) => s.code === "presence_state")) {
          const pirConfig = (this.config?.options?.motion || []).find(
            (entry) => !entry?.deviceId || entry?.deviceId === deviceId,
          ) ?? { overrideTuya: 0 };
          deviceAccessory = new MotionSensorAccessory(
            this,
            homebridgeAccessory,
            device,
            pirConfig.overrideTuya,
          );
          break;
        }
        const deviceData = this.dataUtil.getSubService(device.status);
        const valveConfig = (this.config?.options?.valve || []).find(
          (entry) => entry?.deviceId === deviceId,
        );
        const valveProtocol = valveConfig?.protocol ?? "hap";
        const useValveForHap = valveProtocol === "hap" || valveProtocol === "both";
        deviceAccessory = useValveForHap
          ? new ValveAccessory(this, homebridgeAccessory, device, deviceData)
          : new SwitchAccessory(this, homebridgeAccessory, device, deviceData);
        break;
      }
      default:
        this.log.debug(`Unsupported device type: ${deviceType}`);
        return;
    }

    if (deviceAccessory?.homebridgeAccessory) {
      this.accessories.set(uuid, deviceAccessory.homebridgeAccessory);
      this.deviceAccessories.set(uuid, deviceAccessory);
    }
  }

  async onMQTTMessage(message) {
    const deviceId = message?.devId;
    if (this.disabled || !deviceId) {
      return;
    }

    if (this.mqttPublisher?.shouldPublish(deviceId)) {
      try {
        const device = this.devices.find((d) => d.id === deviceId);
        this.mqttPublisher.publish(deviceId, buildPayload(message, device));
      } catch (error) {
        this.log.error(`Failed to republish MQTT for ${deviceId}.`);
        this.log.error(error);
      }
    }

    if (message.bizCode === "delete") {
      const uuid = this.api.hap.uuid.generate(deviceId);
      this.removeAccessory(this.accessories.get(uuid));

      if (!this.matterReady) {
        return;
      }

      try {
        await this.matterBridge.removeDevice(deviceId);
      } catch (error) {
        this.log.error(`Failed to remove Matter accessory for ${deviceId}.`);
        this.log.error(error);
      }
      return;
    }

    const uuid = this.api.hap.uuid.generate(deviceId);
    const deviceAccessory = this.deviceAccessories.get(uuid);
    if (deviceAccessory && Array.isArray(message.status)) {
      try {
        deviceAccessory.updateState(message);
      } catch (error) {
        this.log.error(`Failed to sync HAP state for ${deviceId}.`);
        this.log.error(error);
      }
    }

    if (!this.matterReady) {
      return;
    }

    try {
      await this.matterBridge.syncMessage(message);
    } catch (error) {
      this.log.error(`Failed to sync Matter state for ${deviceId}.`);
      this.log.error(error);
    }
  }

  removeAccessory(accessory) {
    if (!accessory) {
      return;
    }

    this.log.info(`Removing accessory: ${accessory.displayName}`);
    this.api.unregisterPlatformAccessories(
      this.PLUGIN_NAME,
      this.PLATFORM_NAME,
      [accessory],
    );
    this.accessories.delete(accessory.UUID);
    this.deviceAccessories.delete(accessory.UUID);
  }
}

export default TuyaPlatform;
