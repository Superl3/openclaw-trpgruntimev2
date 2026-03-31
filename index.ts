import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import plugin from "./src/index.js";
import { registerSessionLifecycleTools } from "./src/runtime-adapter/openclaw/session-lifecycle-tools.js";

const baseRegister = plugin.register.bind(plugin);

plugin.register = (api: OpenClawPluginApi) => {
  const registered = baseRegister(api);
  registerSessionLifecycleTools(api);
  return registered;
};

export default plugin;
