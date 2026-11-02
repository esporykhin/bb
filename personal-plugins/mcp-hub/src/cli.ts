import { cliCommand, defineCli, PluginCliError } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { McpHubService } from "./service.js";
import { serverInputSchema } from "./contract.js";

const jsonOption = { type: "boolean" as const, description: "Print JSON" };
const idPositionals = [
  { name: "id", description: "MCP server id", required: true },
] as const;
const output = (value: unknown) => ({
  exitCode: 0,
  stdout: JSON.stringify(value, null, 2),
});
function jsonValue(value: string | undefined, label: string): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new PluginCliError(`Invalid JSON in ${label}`, {
      code: "invalid_json",
    });
  }
}
export function createHubCli(service: McpHubService) {
  return defineCli({
    name: "mcp-hub",
    summary: "Manage the shared MCP hub for all BB agent providers",
    commands: {
      list: cliCommand({
        summary: "List configured MCP servers without secrets",
        options: { json: jsonOption },
        async run() {
          return output(await service.list());
        },
      }),
      add: cliCommand({
        summary:
          "Add or update an MCP server. Stdio runs on the BB server machine.",
        positionals: idPositionals,
        options: {
          name: {
            type: "string",
            description: "Display name (defaults to id)",
          },
          transport: {
            type: "enum",
            values: ["http", "stdio"],
            default: "http",
            description: "Connection transport",
          },
          url: {
            type: "string",
            description: "HTTP(S) MCP URL without credentials",
          },
          token: {
            type: "string",
            stdin: true,
            description:
              "Bearer token; prefer --token-stdin. Omit to preserve the saved token.",
          },
          command: {
            type: "string",
            description: "Stdio executable on the BB server machine",
          },
          args: {
            type: "string",
            description: "JSON array of stdio command arguments",
          },
          env: {
            type: "string",
            stdin: true,
            description:
              "JSON object of stdio environment values; prefer --env-stdin. Omit to preserve.",
          },
          enabled: {
            type: "boolean",
            description: "Enable connection and tool execution",
          },
          disabled: {
            type: "boolean",
            description: "Disable connection and tool execution",
          },
          json: jsonOption,
        },
        constraints: [
          { kind: "at-most-one", options: ["enabled", "disabled"] },
        ],
        async run(input) {
          const previous = (await service.list()).servers.find(
            (server) => server.id === input.positionals.id,
          );
          const enabled = input.options.enabled
            ? true
            : input.options.disabled
              ? false
              : (previous?.enabled ?? false);
          const parsed = serverInputSchema.safeParse({
            id: input.positionals.id,
            name: input.options.name ?? input.positionals.id,
            enabled,
            transport: input.options.transport,
            ...(input.options.url === undefined
              ? {}
              : { url: input.options.url }),
            ...(input.options.token === undefined
              ? {}
              : { bearerToken: input.options.token }),
            ...(input.options.command === undefined
              ? {}
              : { command: input.options.command }),
            ...(input.options.args === undefined
              ? {}
              : { args: jsonValue(input.options.args, "args") }),
            ...(input.options.env === undefined
              ? {}
              : { env: jsonValue(input.options.env, "env") }),
          });
          if (!parsed.success)
            throw new PluginCliError(
              "Invalid MCP server configuration. Check transport, required URL/command and JSON values.",
              { code: "invalid_configuration" },
            );
          return output(await service.upsert(parsed.data));
        },
      }),
      remove: cliCommand({
        summary: "Remove a server and cancel its running operations",
        positionals: idPositionals,
        options: { json: jsonOption },
        async run(input) {
          return output(await service.remove(input.positionals.id));
        },
      }),
      inspect: cliCommand({
        summary: "Connect and list this server's tools and input schemas",
        positionals: idPositionals,
        options: { json: jsonOption },
        async run(input, context) {
          return output(
            await service.inspect(input.positionals.id, context.signal),
          );
        },
      }),
      search: cliCommand({
        summary: "Find MCP tools and their argument schemas",
        positionals: [
          {
            name: "query",
            description: "Search terms; empty string lists tools",
            required: true,
          },
        ],
        options: {
          server: { type: "string", description: "Filter by MCP server id" },
          limit: {
            type: "integer",
            min: 1,
            max: 50,
            default: 10,
            description: "Maximum tool definitions",
          },
          offset: {
            type: "integer",
            min: 0,
            max: 128000,
            default: 0,
            description: "Number of matching tools to skip",
          },
          json: jsonOption,
        },
        async run(input, context) {
          return output(
            await service.search(
              {
                query: input.positionals.query,
                serverId: input.options.server,
                limit: input.options.limit,
                offset: input.options.offset,
              },
              context.signal,
            ),
          );
        },
      }),
      call: cliCommand({
        summary:
          "Call an upstream tool. It may change data; calls are never automatically retried.",
        positionals: [
          { name: "server", description: "MCP server id", required: true },
          { name: "tool", description: "Upstream tool name", required: true },
        ],
        options: {
          arguments: {
            type: "string",
            stdin: true,
            description:
              "JSON object of tool arguments; accepts --arguments-stdin",
            default: "{}",
          },
          json: jsonOption,
        },
        async run(input, context) {
          const argumentsValue = z
            .record(z.string(), z.unknown())
            .safeParse(jsonValue(input.options.arguments, "arguments"));
          if (!argumentsValue.success)
            throw new PluginCliError("Tool arguments must be a JSON object.", {
              code: "invalid_arguments",
            });
          const result = await service.call(
            {
              serverId: input.positionals.server,
              name: input.positionals.tool,
              arguments: argumentsValue.data,
            },
            context.signal,
          );
          return { ...output(result), exitCode: result.isError ? 1 : 0 };
        },
      }),
    },
  });
}
