"use strict";

import { connect } from "mqtt";

/**
 * Republishes Tuya cloud MQTT messages to a local MQTT broker so that other
 * apps on the network can listen. Acts purely as a publisher client — it does
 * NOT host a broker. Point it at an external broker (e.g. homebridge-aedes or
 * Mosquitto) via config.
 *
 * Only the device IDs in the allowlist are published. If the allowlist is empty
 * (or the feature is disabled), the service never connects.
 */
class MqttPublisher {
  constructor({
    enabled = false,
    url,
    username,
    password,
    devices = [],
    topicPrefix = "tuya",
    retain = true,
    datapointTopics = true,
    log,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.url = url;
    this.username = username;
    this.password = password;
    this.topicPrefix = topicPrefix || "tuya";
    this.retain = Boolean(retain);
    this.datapointTopics = Boolean(datapointTopics);
    this.log = log;

    // Allowlist of device IDs to republish, normalized for O(1) lookup.
    this.allowed = new Set(
      (Array.isArray(devices) ? devices : [])
        .map((d) => (typeof d === "string" ? d.trim() : String(d ?? "")))
        .filter(Boolean),
    );

    this.client = null;
    this.connected = false;
  }

  start() {
    if (this.client) {
      return; // guard double-start
    }

    if (!this.enabled || this.allowed.size === 0) {
      this.log?.debug?.(
        "[MQTT publish] Disabled or no device IDs configured — not starting.",
      );
      return;
    }

    if (!this.url) {
      this.log?.warn?.(
        "[MQTT publish] Enabled but no broker URL configured — not starting.",
      );
      return;
    }

    try {
      this.client = connect(this.url, {
        username: this.username || undefined,
        password: this.password || undefined,
        reconnectPeriod: 5000,
      });

      this.client.on("connect", () => {
        this.connected = true;
        this.log?.info?.(
          `[MQTT publish] Connected to ${this.url} (publishing ${this.allowed.size} device(s)).`,
        );
      });
      this.client.on("reconnect", () =>
        this.log?.debug?.("[MQTT publish] Reconnecting..."),
      );
      this.client.on("close", () => {
        this.connected = false;
        this.log?.debug?.("[MQTT publish] Connection closed.");
      });
      this.client.on("error", (err) =>
        this.log?.error?.("[MQTT publish] Connection error.", err),
      );
    } catch (error) {
      this.log?.error?.("[MQTT publish] Failed to start.", error);
    }
  }

  shouldPublish(devId) {
    return this.enabled && devId != null && this.allowed.has(String(devId));
  }

  publish(devId, payload) {
    if (!this.shouldPublish(devId) || !this.connected) {
      return;
    }

    try {
      const topic = `${this.topicPrefix}/${devId}/status`;
      this.client.publish(topic, JSON.stringify(payload), {
        qos: 0,
        retain: this.retain,
      });

      // Also publish each datapoint to its own topic with the bare scaled value,
      // so single-value consumers (e.g. the Broadlink RM plugin) can read it directly.
      if (this.datapointTopics && Array.isArray(payload?.status)) {
        for (const item of payload.status) {
          if (!item?.code) {
            continue;
          }
          const value = item.scaled !== undefined ? item.scaled : item.value;
          this.client.publish(
            `${this.topicPrefix}/${devId}/${item.code}`,
            String(value),
            { qos: 0, retain: this.retain },
          );
        }
      }
    } catch (error) {
      this.log?.error?.(
        `[MQTT publish] Failed to publish for ${devId}.`,
        error,
      );
    }
  }

  stop() {
    try {
      this.client?.end(true);
    } catch {
      // ignore
    }
    this.client = null;
    this.connected = false;
  }
}

/**
 * Builds an enriched copy of a Tuya MQTT message for publishing. Each status
 * entry keeps its raw `value` and gains a `scaled` value derived from the Tuya
 * datapoint spec (`scale` = implied decimal places, so real = raw / 10**scale),
 * plus the `unit` when the spec provides one.
 */
function buildPayload(message, device) {
  const specByCode = new Map();
  const functions = device?.functions;
  if (Array.isArray(functions)) {
    for (const fn of functions) {
      if (!fn?.code) {
        continue;
      }
      try {
        specByCode.set(fn.code, JSON.parse(fn.values));
      } catch {
        // spec not parseable — leave it out, value passes through raw
      }
    }
  }

  const status = Array.isArray(message?.status)
    ? message.status.map((item) => {
        const out = { code: item.code, value: item.value };
        const spec = specByCode.get(item.code);
        const scale = Number(spec?.scale);

        if (spec && Number.isFinite(scale) && scale > 0 && typeof item.value === "number") {
          out.scaled = item.value / 10 ** scale;
          out.scale = scale;
        } else {
          out.scaled = item.value;
        }

        if (spec?.unit) {
          out.unit = spec.unit;
        }

        return out;
      })
    : [];

  const payload = {
    devId: message?.devId,
    t: message?.t,
    status,
  };

  if (message?.bizCode != null) {
    payload.bizCode = message.bizCode;
  }

  return payload;
}

export default MqttPublisher;
export { buildPayload };
