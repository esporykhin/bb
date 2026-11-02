import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
export default defineWorkspaceTestConfig({
  resolve: { tsconfigPaths: true },
  test: {
    testTimeout: 15000,
    server: { deps: { inline: [/eventsource/, /@modelcontextprotocol/] } },
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "bb-plugin-mcp-hub",
      include: ["src/**/*.test.{ts,tsx}"],
    }),
  },
});
