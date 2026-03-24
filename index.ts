import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import plugin from "./src/index.js";
import { registerCheckpoint0LifecycleTools } from "./src/runtime-adapter/openclaw/checkpoint0-lifecycle.js";

const baseRegister = plugin.register.bind(plugin);

plugin.register = (api: OpenClawPluginApi) => {
  const registered = baseRegister(api);
  registerCheckpoint0LifecycleTools(api);
  return registered;
};

export default plugin;
