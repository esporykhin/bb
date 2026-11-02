import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const serverIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const serverInputSchema = z
  .object({
    id: serverIdSchema,
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean(),
    transport: z.enum(["http", "stdio"]),
    url: z.string().max(4000).optional(),
    bearerToken: z.string().max(16000).optional(),
    command: z.string().trim().min(1).max(4000).optional(),
    args: z.array(z.string().max(4000)).max(100).optional(),
    env: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().max(16000),
      )
      .optional(),
  })
  .strict()
  .superRefine((server, context) => {
    if (server.transport === "http") {
      if (!server.url)
        context.addIssue({
          code: "custom",
          message: "HTTP server requires a URL",
          path: ["url"],
        });
      if (
        server.command !== undefined ||
        server.args !== undefined ||
        server.env !== undefined
      )
        context.addIssue({
          code: "custom",
          message: "HTTP servers do not accept command, args or env",
        });
      if (server.url) {
        try {
          const url = new URL(server.url);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.hash
          )
            throw new Error();
          for (const key of url.searchParams.keys())
            if (key !== "tools") throw new Error();
        } catch {
          context.addIssue({
            code: "custom",
            message:
              "Use an HTTP(S) URL without credentials, fragment or secret query parameters",
            path: ["url"],
          });
        }
      }
    } else {
      if (!server.command)
        context.addIssue({
          code: "custom",
          message: "Stdio server requires a command",
          path: ["command"],
        });
      if (server.url !== undefined || server.bearerToken !== undefined)
        context.addIssue({
          code: "custom",
          message: "Stdio servers do not accept URL or bearer token",
        });
    }
  });
export const serverSummarySchema = z
  .object({
    id: serverIdSchema,
    name: z.string(),
    enabled: z.boolean(),
    transport: z.enum(["http", "stdio"]),
    url: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    hasToken: z.boolean(),
    envKeys: z.array(z.string()),
  })
  .strict();
export const toolSummarySchema = z
  .object({
    serverId: serverIdSchema,
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
export const searchInputSchema = z
  .object({
    query: z.string().max(500),
    serverId: serverIdSchema.optional(),
    limit: z.number().int().min(1).max(50).default(10),
    offset: z.number().int().min(0).max(128000).default(0),
  })
  .strict();
export const searchResultSchema = z
  .object({
    tools: z.array(toolSummarySchema),
    errors: z.array(
      z.object({ serverId: serverIdSchema, message: z.string() }),
    ),
    truncated: z.boolean(),
  })
  .strict();
export const callInputSchema = z
  .object({
    serverId: serverIdSchema,
    name: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
export const contentSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("image"),
      data: z.string(),
      mimeType: z.string(),
    })
    .strict(),
]);
export const callResultSchema = z
  .object({ content: z.array(contentSchema), isError: z.boolean() })
  .strict();
const idInput = z.object({ id: serverIdSchema }).strict();
export const rpcContract = defineRpcContract({
  list: {
    input: z.null(),
    output: z.object({ servers: z.array(serverSummarySchema) }),
  },
  upsert: {
    input: serverInputSchema,
    output: z.object({ server: serverSummarySchema }),
  },
  remove: { input: idInput, output: z.object({ removed: z.boolean() }) },
  inspect: {
    input: idInput,
    output: z.object({ tools: z.array(toolSummarySchema) }),
  },
  search: { input: searchInputSchema, output: searchResultSchema },
  call: { input: callInputSchema, output: callResultSchema },
});
export type ServerInput = z.infer<typeof serverInputSchema>;
export type ServerSummary = z.infer<typeof serverSummarySchema>;
export type ToolSummary = z.infer<typeof toolSummarySchema>;
export type SearchInput = z.input<typeof searchInputSchema>;
export type CallInput = z.infer<typeof callInputSchema>;
export type CallResult = z.infer<typeof callResultSchema>;
