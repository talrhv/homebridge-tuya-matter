// Manual smoke script (not part of `npm test`):
//   node test/mq.js
// Logs in with the credentials from ./env.js and starts the MQTT listener.
import TuyaOpenApi from "../lib/tuyaopenapi.mjs";
import TuyaOpenMQ from "../lib/tuyamqttapi.mjs";
import env from "./env.js";

(async () => {
  const api = new TuyaOpenApi(env.endpoint, env.accessId, env.accessKey, console);

  await api.login(env.username, env.password);

  const mq = new TuyaOpenMQ(api, "2.0", console);
  mq.start();
})();
