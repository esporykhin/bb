import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildPluginApp,
  buildPluginServer,
  resolvePluginBuildToolchain,
} from "../../packages/plugin-build/src/index.ts";
const root = import.meta.dirname;
const { version } = JSON.parse(
  await readFile(resolve(root, "../../packages/bb-app/package.json"), "utf8"),
);
const toolchain = await resolvePluginBuildToolchain(
  resolve(root, "node_modules/.bb-toolchain"),
);
await buildPluginServer(root, version, toolchain);
await buildPluginApp(root, version, toolchain);
console.log("MCP Hub: server and app bundles built");
