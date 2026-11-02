import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import plugin from "./server.js";
import { rpcContract, type ServerInput } from "./contract.js";
async function rpc<Name extends keyof typeof rpcContract>(
  harness: FakePluginHost["harness"],
  name: Name,
  input: unknown,
): Promise<z.output<(typeof rpcContract)[Name]["output"]>> {
  return rpcContract[name].output.parse(
    await harness.behavior.callRpc(name, input),
  ) as z.output<(typeof rpcContract)[Name]["output"]>;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function host() {
  const result = createFakePluginHost({ pluginId: "bb-plugin-mcp-hub" });
  await plugin(result.bb);
  cleanups.push(() => result.harness.lifecycle.dispose());
  return result;
}
async function fixture(mode: "normal" | "oversized" | "large" = "normal") {
  const calls: {
    name: string;
    value: unknown;
    authorization: string | null;
  }[] = [];
  let startWait: () => void = () => {};
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    startWait = resolve;
  });
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "hub-fixture", version: "1.0.0" });
      if (mode === "oversized")
        server.registerTool(
          "a_huge",
          {
            description: "Oversized schema",
            inputSchema: z.object({
              value: z.string().describe("x".repeat(510_000)),
            }),
          },
          async () => ({ content: [] }),
        );
      if (mode === "large")
        for (const [name, size] of [
          ["a_large", 300_000],
          ["b_large", 300_000],
          ["c_large", 10],
        ] as const)
          server.registerTool(
            name,
            {
              description: "Large schema fixture",
              inputSchema: z.object({
                value: z.string().describe("x".repeat(size)),
              }),
            },
            async () => ({ content: [] }),
          );
      server.registerTool(
        "sum",
        {
          description: "Add two numbers",
          inputSchema: z.object({ a: z.number(), b: z.number() }),
        },
        async ({ a, b }) => {
          calls.push({ name: "sum", value: { a, b }, authorization: null });
          return { content: [{ type: "text", text: String(a + b) }] };
        },
      );
      server.registerTool(
        "fail",
        { description: "Upstream error", inputSchema: z.object({}) },
        async () => ({
          content: [{ type: "text", text: "upstream refused" }],
          isError: true,
        }),
      );
      server.registerTool(
        "wait",
        { description: "Wait until cancelled", inputSchema: z.object({}) },
        async (_input, context) => {
          startWait();
          await Promise.race([
            released,
            new Promise<void>((resolve) => {
              context.mcpReq.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            }),
          ]);
          return { content: [{ type: "text", text: "completed" }] };
        },
      );
      server.registerTool(
        "structured",
        {
          description: "Structured falsey result",
          inputSchema: z.object({
            value: z.union([z.boolean(), z.number(), z.null()]),
          }),
        },
        async ({ value }) => ({
          content: [{ type: "text", text: "human-readable" }],
          structuredContent: { result: value },
        }),
      );
      return server;
    },
    { legacy: "stateless", onerror: () => {} },
  );
  const http = createServer(async (request, response) => {
    try {
      const buffers: Buffer[] = [];
      for await (const chunk of request) buffers.push(Buffer.from(chunk));
      const body = Buffer.concat(buffers);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(key, value);
      }
      calls.push({
        name: "http",
        value: body.length ? JSON.parse(body.toString()) : null,
        authorization: headers.get("authorization"),
      });
      const incoming = new Request(`http://127.0.0.1${request.url}`, {
        method: request.method,
        headers,
        ...(body.length ? { body: new Uint8Array(body) } : {}),
      });
      const outgoing = await handler.fetch(incoming);
      response.writeHead(outgoing.status, Object.fromEntries(outgoing.headers));
      response.end(Buffer.from(await outgoing.arrayBuffer()));
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  cleanups.push(async () => {
    await handler.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    waiting,
    release,
  };
}
const httpInput = (url: string) => ({
  id: "fixture",
  name: "Fixture",
  enabled: true,
  transport: "http",
  url,
  bearerToken: "private-bearer-value",
});

describe("MCP hub shared registry and tool execution", () => {
  it.each(["http", "stdio"] as const)(
    "returns saved %s configuration only on explicit disclosure and persists edits across reload",
    async (transport) => {
      const initial: ServerInput =
        transport === "http"
          ? {
              id: "settings",
              name: "Settings",
              transport,
              enabled: false,
              url: "https://example.invalid/mcp",
              bearerToken: "saved-http-secret",
            }
          : {
              id: "settings",
              name: "Settings",
              transport,
              enabled: false,
              command: "node",
              args: ["server.mjs", "--read-only"],
              env: {
                KAITEN_SUBDOMAIN: "workspace",
                KAITEN_TOKEN: "saved-stdio-secret",
              },
            };
      const original = await host();
      await rpc(original.harness, "upsert", initial);
      const before = await rpc(original.harness, "configuration", {
        id: initial.id,
      });
      expect(before).toEqual({ server: initial });
      const hidden = await original.harness.behavior.runCli([
        "show",
        initial.id,
        "--json",
      ]);
      expect(hidden.exitCode).toBe(0);
      const summary = (await rpc(original.harness, "list", null)).servers[0];
      expect(JSON.parse(hidden.stdout!)).toEqual({ server: summary });
      expect(hidden.stdout).not.toContain("saved-http-secret");
      expect(hidden.stdout).not.toContain("saved-stdio-secret");
      expect(hidden.stdout).not.toContain("workspace");
      const revealed = await original.harness.behavior.runCli([
        "show",
        initial.id,
        "--show-secrets",
        "--json",
      ]);
      expect(revealed.exitCode).toBe(0);
      expect(JSON.parse(revealed.stdout!)).toEqual({ server: initial });
      before.server.name = "Unsaved";
      if (before.server.env) before.server.env.KAITEN_TOKEN = "unsaved";
      if (before.server.args) before.server.args.push("--unsaved");
      expect(
        await rpc(original.harness, "configuration", { id: initial.id }),
      ).toEqual({ server: initial });
      const metadata =
        transport === "http"
          ? {
              id: initial.id,
              name: "Renamed",
              enabled: false,
              transport,
              url: initial.url,
            }
          : {
              id: initial.id,
              name: "Renamed",
              enabled: false,
              transport,
              command: initial.command,
              args: initial.args,
            };
      await rpc(original.harness, "upsert", metadata);
      expect(
        await rpc(original.harness, "configuration", { id: initial.id }),
      ).toEqual({ server: { ...initial, name: "Renamed" } });
      const reloaded = await original.harness.lifecycle.reload(plugin);
      cleanups.push(() => reloaded.harness.lifecycle.dispose());
      expect(
        await rpc(reloaded.harness, "configuration", { id: initial.id }),
      ).toEqual({ server: { ...initial, name: "Renamed" } });
      const edited =
        transport === "http"
          ? { ...initial, name: "Edited", bearerToken: "updated-http-secret" }
          : {
              ...initial,
              name: "Edited",
              env: {
                KAITEN_SUBDOMAIN: "another-workspace",
                KAITEN_TOKEN: "updated-stdio-secret",
                OPTIONAL: "",
              },
            };
      await rpc(reloaded.harness, "upsert", edited);
      expect(
        await rpc(reloaded.harness, "configuration", { id: initial.id }),
      ).toEqual({ server: edited });
      const cleared =
        transport === "http"
          ? { ...edited, bearerToken: "" }
          : { ...edited, env: {} };
      await rpc(reloaded.harness, "upsert", cleared);
      expect(
        await rpc(reloaded.harness, "configuration", { id: initial.id }),
      ).toEqual({ server: cleared });
      const afterClear = (await rpc(reloaded.harness, "list", null)).servers[0];
      expect(afterClear.hasToken).toBe(false);
      expect(afterClear.envKeys).toEqual([]);
      await rpc(reloaded.harness, "remove", { id: initial.id });
      expect(await rpc(reloaded.harness, "list", null)).toEqual({
        servers: [],
      });
      await expect(
        rpc(reloaded.harness, "configuration", { id: initial.id }),
      ).rejects.toThrow("not found");
      const missing = await reloaded.harness.behavior.runCli([
        "show",
        initial.id,
        "--show-secrets",
      ]);
      expect(missing.exitCode).toBe(1);
      await expect(
        rpc(reloaded.harness, "configuration", { id: "invalid/id" }),
      ).rejects.toThrow();
    },
  );
  it("persists create/read/update/delete through RPC and CLI without exposing credentials", async () => {
    const upstream = await fixture();
    const { harness } = await host();
    const created = await rpc(harness, "upsert", httpInput(upstream.url));
    expect(created).toEqual({
      server: {
        id: "fixture",
        name: "Fixture",
        enabled: true,
        transport: "http",
        url: upstream.url,
        hasToken: true,
        envKeys: [],
      },
    });
    expect(await rpc(harness, "list", null)).toEqual({
      servers: [created.server],
    });
    const updated = await rpc(harness, "upsert", {
      ...httpInput(upstream.url),
      name: "Renamed",
      bearerToken: undefined,
      enabled: false,
    });
    expect(updated.server).toMatchObject({
      name: "Renamed",
      enabled: false,
      hasToken: true,
    });
    const listed = await harness.behavior.runCli(["list", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout!)).toEqual({ servers: [updated.server] });
    expect(listed.stdout).not.toContain("private-bearer-value");
    await expect(rpc(harness, "inspect", { id: "fixture" })).rejects.toThrow(
      "disabled",
    );
    expect(await rpc(harness, "remove", { id: "fixture" })).toEqual({
      removed: true,
    });
    expect(await rpc(harness, "list", null)).toEqual({ servers: [] });
    await expect(rpc(harness, "inspect", { id: "fixture" })).rejects.toThrow(
      "not found",
    );
    await expect(rpc(harness, "remove", { id: "fixture" })).rejects.toThrow(
      "not found",
    );
  });
  it("searches real HTTP tool schemas and forwards one mutating call and bearer authentication", async () => {
    const upstream = await fixture();
    const { harness } = await host();
    await rpc(harness, "upsert", httpInput(upstream.url));
    const found = await rpc(harness, "search", { query: "sum" });
    expect(found).toMatchObject({
      tools: [
        {
          serverId: "fixture",
          name: "sum",
          description: "Add two numbers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
      ],
      errors: [],
      truncated: false,
    });
    const result = await harness.behavior.callAgentTool("mcp_hub_call", {
      serverId: "fixture",
      name: "sum",
      arguments: { a: 4, b: 7 },
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "11" }],
      isError: false,
    });
    expect(upstream.calls.filter((call) => call.name === "sum")).toEqual([
      { name: "sum", value: { a: 4, b: 7 }, authorization: null },
    ]);
    expect(
      upstream.calls
        .filter((call) => call.name === "http")
        .every((call) => call.authorization === "Bearer private-bearer-value"),
    ).toBe(true);
    expect(
      await rpc(harness, "call", {
        serverId: "fixture",
        name: "fail",
        arguments: {},
      }),
    ).toEqual({
      content: [{ type: "text", text: "upstream refused" }],
      isError: true,
    });
    const limited = await rpc(harness, "search", { query: "", limit: 1 });
    expect(limited.tools.map((tool) => tool.name)).toEqual(["fail"]);
    expect(limited.truncated).toBe(true);
    const next = await rpc(harness, "search", {
      query: "",
      limit: 1,
      offset: 1,
    });
    expect(next.tools.map((tool) => tool.name)).toEqual(["structured"]);
  });
  it("excludes a single oversized schema without preventing catalog pagination", async () => {
    const upstream = await fixture("oversized");
    const { harness } = await host();
    await rpc(harness, "upsert", httpInput(upstream.url));
    const page = await rpc(harness, "search", { query: "", limit: 2 });
    expect(page.tools.map((tool) => tool.name)).toEqual(["fail", "structured"]);
    expect(page.errors).toEqual([
      {
        serverId: "fixture",
        message:
          "An MCP tool input schema exceeds 500 KB and was excluded from search.",
      },
    ]);
    const next = await rpc(harness, "search", {
      query: "",
      limit: 2,
      offset: 2,
    });
    expect(next.tools.map((tool) => tool.name)).toEqual(["sum", "wait"]);
    expect(next.truncated).toBe(false);
  });
  it("returns a contiguous page when schemas reach the byte budget", async () => {
    const upstream = await fixture("large");
    const { harness } = await host();
    await rpc(harness, "upsert", httpInput(upstream.url));
    const page = await rpc(harness, "search", { query: "large", limit: 10 });
    expect(page.tools.map((tool) => tool.name)).toEqual(["a_large"]);
    expect(page.truncated).toBe(true);
    const next = await rpc(harness, "search", {
      query: "large",
      limit: 10,
      offset: 1,
    });
    expect(next.tools.map((tool) => tool.name)).toEqual(["b_large", "c_large"]);
    expect(next.truncated).toBe(false);
  });
  it.each([false, 0, null])(
    "preserves structuredContent with falsey field %s alongside text",
    async (value) => {
      const upstream = await fixture();
      const { harness } = await host();
      await rpc(harness, "upsert", httpInput(upstream.url));
      expect(
        await rpc(harness, "call", {
          serverId: "fixture",
          name: "structured",
          arguments: { value },
        }),
      ).toEqual({
        content: [
          { type: "text", text: "human-readable" },
          { type: "text", text: JSON.stringify({ result: value }) },
        ],
        isError: false,
      });
    },
  );
  it("keeps an unrelated active call alive when another server is changed", async () => {
    const upstream = await fixture();
    const { harness } = await host();
    await rpc(harness, "upsert", httpInput(upstream.url));
    const pending = rpc(harness, "call", {
      serverId: "fixture",
      name: "wait",
      arguments: {},
    });
    await upstream.waiting;
    await rpc(harness, "upsert", {
      id: "other",
      name: "Other",
      enabled: false,
      transport: "http",
      url: "https://example.invalid/mcp",
    });
    upstream.release();
    expect(await pending).toEqual({
      content: [{ type: "text", text: "completed" }],
      isError: false,
    });
  });
  it("runs stdio on the BB server and preserves environment secrets on metadata updates", async () => {
    const { harness } = await host();
    const command = process.execPath;
    const args = [
      fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url)),
    ];
    await rpc(harness, "upsert", {
      id: "stdio",
      name: "Local",
      enabled: true,
      transport: "stdio",
      command,
      args,
      env: { HUB_TEST_KEY: "stdio-private-value" },
    });
    await rpc(harness, "upsert", {
      id: "stdio",
      name: "Renamed local",
      enabled: true,
      transport: "stdio",
      command,
      args,
    });
    const listed = await rpc(harness, "list", null);
    expect(listed).toEqual({
      servers: [
        {
          id: "stdio",
          name: "Renamed local",
          enabled: true,
          transport: "stdio",
          command,
          args,
          hasToken: false,
          envKeys: ["HUB_TEST_KEY"],
        },
      ],
    });
    const inspected = await rpc(harness, "inspect", { id: "stdio" });
    expect(inspected.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "stdio_echo",
    ]);
    const result = await rpc(harness, "call", {
      serverId: "stdio",
      name: "stdio_echo",
      arguments: { value: "hello" },
    });
    expect(result.isError).toBe(false);
    const text = z
      .object({ type: z.literal("text"), text: z.string() })
      .parse(result.content[0]);
    expect(JSON.parse(text.text)).toMatchObject({
      value: "hello",
      configured: true,
      count: 1,
    });
    const pid = z.object({ pid: z.number() }).parse(JSON.parse(text.text)).pid;
    expect(
      (await rpc(harness, "search", { query: "stdio" })).tools,
    ).toHaveLength(1);
    const second = await rpc(harness, "call", {
      serverId: "stdio",
      name: "stdio_echo",
      arguments: { value: "again" },
    });
    const secondText = z
      .object({ type: z.literal("text"), text: z.string() })
      .parse(second.content[0]);
    expect(JSON.parse(secondText.text)).toEqual({
      value: "again",
      count: 2,
      configured: true,
      pid,
    });
    const cleared = await rpc(harness, "upsert", {
      id: "stdio",
      name: "Local",
      enabled: true,
      transport: "stdio",
      command,
      args,
      env: {},
    });
    expect(cleared.server.envKeys).toEqual([]);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await rpc(harness, "remove", { id: "stdio" })).toEqual({
      removed: true,
    });
  });
  it("serializes concurrent registry updates instead of losing one server", async () => {
    const { harness } = await host();
    await Promise.all(
      ["one", "two"].map((id) =>
        rpc(harness, "upsert", {
          id,
          name: id,
          enabled: false,
          transport: "http",
          url: "https://example.invalid/mcp",
        }),
      ),
    );
    expect(
      (await rpc(harness, "list", null)).servers
        .map((server: { id: string }) => server.id)
        .sort(),
    ).toEqual(["one", "two"]);
  });
  it("returns safe per-server discovery errors while preserving reachable tools", async () => {
    const upstream = await fixture();
    const { harness } = await host();
    await rpc(harness, "upsert", httpInput(upstream.url));
    await rpc(harness, "upsert", {
      id: "bad",
      name: "Bad",
      enabled: true,
      transport: "stdio",
      command: "/does-not-exist/private-token",
      env: { KEY: "env-private-value" },
    });
    const result = await rpc(harness, "search", { query: "sum" });
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "sum",
    ]);
    expect(result.errors).toEqual([
      {
        serverId: "bad",
        message:
          "MCP operation failed. Check the server address, credentials and availability.",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("env-private-value");
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
  it.each(["disable", "remove", "dispose"] as const)(
    "cancels an active upstream operation on %s",
    async (action) => {
      const upstream = await fixture();
      const { harness } = await host();
      await rpc(harness, "upsert", httpInput(upstream.url));
      const pending = rpc(harness, "call", {
        serverId: "fixture",
        name: "wait",
        arguments: {},
      });
      const cancelled = expect(pending).rejects.toThrow(
        "cancelled or timed out",
      );
      await upstream.waiting;
      if (action === "disable")
        await rpc(harness, "upsert", {
          ...httpInput(upstream.url),
          enabled: false,
        });
      else if (action === "remove")
        await rpc(harness, "remove", { id: "fixture" });
      else await harness.lifecycle.dispose();
      await cancelled;
      if (action !== "dispose")
        await expect(
          rpc(harness, "call", {
            serverId: "fixture",
            name: "sum",
            arguments: { a: 1, b: 2 },
          }),
        ).rejects.toThrow(action === "disable" ? "disabled" : "not found");
    },
  );
  it("rejects credential-bearing URLs and supports safe CLI configuration", async () => {
    const { harness } = await host();
    for (const url of [
      "https://user:password@example.com/mcp",
      "https://example.com/mcp?api_key=secret",
      "file:///tmp/mcp",
    ])
      await expect(rpc(harness, "upsert", httpInput(url))).rejects.toThrow();
    const added = await harness.behavior.runCli([
      "add",
      "cli",
      "--url",
      "https://example.invalid/mcp",
      "--json",
    ]);
    expect(added.exitCode, added.stderr).toBe(0);
    expect(JSON.parse(added.stdout!)).toEqual({
      server: {
        id: "cli",
        name: "cli",
        enabled: false,
        transport: "http",
        url: "https://example.invalid/mcp",
        hasToken: false,
        envKeys: [],
      },
    });
    const enabled = await harness.behavior.runCli([
      "add",
      "cli",
      "--url",
      "https://example.invalid/mcp",
      "--enabled",
      "--json",
    ]);
    expect(JSON.parse(enabled.stdout!).server.enabled).toBe(true);
    const preserved = await harness.behavior.runCli([
      "add",
      "cli",
      "--url",
      "https://example.invalid/mcp",
      "--json",
    ]);
    expect(JSON.parse(preserved.stdout!).server.enabled).toBe(true);
    const conflict = await harness.behavior.runCli([
      "add",
      "cli",
      "--url",
      "https://example.invalid/mcp",
      "--enabled",
      "--disabled",
    ]);
    expect(conflict.exitCode).toBe(1);
    const removed = await harness.behavior.runCli(["remove", "cli", "--json"]);
    expect(JSON.parse(removed.stdout!)).toEqual({ removed: true });
  });
});
