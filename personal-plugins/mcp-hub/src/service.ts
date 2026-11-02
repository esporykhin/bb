import { z } from "zod";
import {
  serverInputSchema,
  serverSummarySchema,
  toolSummarySchema,
  searchInputSchema,
  callInputSchema,
  type ServerInput,
  type ServerSummary,
  type SearchInput,
  type CallInput,
  type CallResult,
  type ToolSummary,
} from "./contract.js";
import { openClient, REQUEST_TIMEOUT_MS } from "./transport.js";
import type { Client } from "@modelcontextprotocol/client";

const registrySchema = z.array(serverInputSchema).max(64);
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_CATALOG_BYTES = 500_000;
class HubError extends Error {}
export type RegistrySettings = {
  get(): Promise<{ registry: string }>;
  experimental_set(value: { registry: string }): Promise<unknown>;
};

export class McpHubService {
  private queue: Promise<unknown> = Promise.resolve();
  private operations = new Map<string, Set<AbortController>>();
  private disposed = false;
  private generations = new Map<string, number>();
  private versions = new Map<string, string>();
  private pools = new Map<
    string,
    { controller: AbortController; promise: ReturnType<typeof openClient> }
  >();
  private cleanups = new Map<string, Promise<void>>();
  private completions = new Map<AbortController, Promise<void>>();
  constructor(
    private settings: RegistrySettings,
    private changed: () => void = () => {},
  ) {}
  private async registry() {
    try {
      return registrySchema.parse(
        JSON.parse((await this.settings.get()).registry),
      );
    } catch {
      throw new HubError(
        "MCP registry is invalid. Restore its secret registry setting.",
      );
    }
  }
  private summary(server: ServerInput): ServerSummary {
    return serverSummarySchema.parse({
      id: server.id,
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      ...(server.transport === "http"
        ? { url: server.url }
        : { command: server.command, args: server.args ?? [] }),
      hasToken: Boolean(server.bearerToken),
      envKeys: Object.keys(server.env ?? {}).sort(),
    });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  async list() {
    return {
      servers: (await this.registry()).map((server) => this.summary(server)),
    };
  }
  async upsert(raw: ServerInput) {
    const input = serverInputSchema.parse(raw);
    return this.serial(async () => {
      if (this.disposed) throw new HubError("MCP hub is stopped.");
      const servers = await this.registry();
      const previous = servers.find((server) => server.id === input.id);
      const server = serverInputSchema.parse({
        ...input,
        ...(input.transport === "http"
          ? {
              bearerToken:
                input.bearerToken ??
                (previous?.transport === "http" ? previous.bearerToken : ""),
            }
          : {
              env:
                input.env ??
                (previous?.transport === "stdio" ? previous.env : {}),
            }),
      });
      const next = servers.filter((existing) => existing.id !== server.id);
      next.push(server);
      registrySchema.parse(next);
      const registry = JSON.stringify(next);
      if (Buffer.byteLength(registry) > 1_000_000)
        throw new HubError("MCP registry exceeds 1 MB.");
      await this.settings.experimental_set({ registry });
      await this.configChanged(server.id, JSON.stringify(server));
      this.changed();
      return { server: this.summary(server) };
    });
  }
  async remove(id: string) {
    return this.serial(async () => {
      const servers = await this.registry();
      if (!servers.some((server) => server.id === id))
        throw new HubError("MCP server was not found.");
      await this.settings.experimental_set({
        registry: JSON.stringify(servers.filter((server) => server.id !== id)),
      });
      await this.configChanged(id, "removed");
      this.changed();
      return { removed: true };
    });
  }
  registryChanged(next: string, previous: string) {
    try {
      const after = registrySchema.parse(JSON.parse(next));
      const before = registrySchema.parse(JSON.parse(previous));
      for (const id of new Set([
        ...before.map((server) => server.id),
        ...after.map((server) => server.id),
      ])) {
        const a = after.find((server) => server.id === id);
        const b = before.find((server) => server.id === id);
        if (JSON.stringify(a) !== JSON.stringify(b))
          void this.configChanged(id, a ? JSON.stringify(a) : "removed");
      }
    } catch {
      this.invalidate();
    }
  }
  invalidate() {
    for (const id of new Set([...this.operations.keys(), ...this.pools.keys()]))
      void this.configChanged(
        id,
        `invalid-${Date.now()}-${this.generations.get(id)}`,
      );
  }
  async dispose() {
    this.disposed = true;
    this.invalidate();
    await Promise.all(this.cleanups.values());
    await Promise.all(this.completions.values());
  }
  private configChanged(id: string, version: string) {
    if (this.versions.get(id) === version)
      return this.cleanups.get(id) ?? Promise.resolve();
    this.versions.set(id, version);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const active = this.operations.get(id);
    if (active) for (const controller of active) controller.abort();
    const pool = this.pools.get(id);
    this.pools.delete(id);
    pool?.controller.abort();
    const closed = (async () => {
      if (pool)
        await pool.promise.then(
          (connection) => connection.close(),
          () => {},
        );
      if (active)
        await Promise.all(
          [...active].flatMap((controller) => {
            const done = this.completions.get(controller);
            return done ? [done] : [];
          }),
        );
    })();
    this.cleanups.set(id, closed);
    return closed;
  }
  private connection(server: ServerInput) {
    let pool = this.pools.get(server.id);
    if (!pool) {
      const controller = new AbortController();
      const promise = openClient(
        server,
        AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      );
      pool = { controller, promise };
      this.pools.set(server.id, pool);
      const entry = pool;
      void promise.then(
        (connection) => {
          connection.client.onclose = () => {
            if (this.pools.get(server.id) === entry)
              this.pools.delete(server.id);
          };
        },
        () => {
          if (this.pools.get(server.id) === entry) this.pools.delete(server.id);
        },
      );
    }
    return pool.promise;
  }
  private async use<T>(
    id: string,
    signal: AbortSignal | undefined,
    operation: (client: Client, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.disposed) throw new HubError("MCP hub is stopped.");
    const generation = this.generations.get(id) ?? 0;
    const server = (await this.registry()).find((item) => item.id === id);
    if (this.disposed || generation !== (this.generations.get(id) ?? 0))
      throw new HubError(
        "MCP configuration changed. Discover the tool again before calling it.",
      );
    if (!server) throw new HubError("MCP server was not found.");
    if (!server.enabled) throw new HubError("MCP server is disabled.");
    const controller = new AbortController();
    const active = this.operations.get(id) ?? new Set<AbortController>();
    active.add(controller);
    this.operations.set(id, active);
    let complete: () => void = () => {};
    this.completions.set(
      controller,
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    const combined = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    try {
      const pending = this.connection(server);
      const connection = await new Promise<Awaited<typeof pending>>(
        (resolve, reject) => {
          const abort = () => reject(combined.reason);
          if (combined.aborted) {
            reject(combined.reason);
            return;
          }
          combined.addEventListener("abort", abort, { once: true });
          void pending
            .then(resolve, reject)
            .finally(() => combined.removeEventListener("abort", abort));
        },
      );
      combined.throwIfAborted();
      return await operation(connection.client, combined);
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new HubError(
        combined.aborted
          ? "MCP operation was cancelled or timed out; a tool call may already have taken effect. Do not retry it without checking."
          : "MCP operation failed. Check the server address, credentials and availability.",
      );
    } finally {
      active.delete(controller);
      if (active.size === 0) this.operations.delete(id);
      this.completions.delete(controller);
      complete();
    }
  }
  private async tools(id: string, signal?: AbortSignal) {
    return this.use(id, signal, async (client, operationSignal) => {
      const { tools } = await client.listTools(undefined, {
        signal: operationSignal,
        timeout: REQUEST_TIMEOUT_MS,
      });
      if (tools.length > 2000)
        throw new HubError(
          "MCP server advertises more than 2,000 tools. Narrow its catalog.",
        );
      return tools.map((tool) =>
        toolSummarySchema.parse({
          serverId: id,
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        }),
      );
    });
  }
  async inspect(id: string, signal?: AbortSignal) {
    const tools = await this.tools(id, signal);
    if (Buffer.byteLength(JSON.stringify(tools)) > MAX_CATALOG_BYTES)
      throw new HubError(
        "MCP catalog exceeds 500 KB. Use search to select tools.",
      );
    return { tools };
  }
  async search(raw: SearchInput, signal?: AbortSignal) {
    const input = searchInputSchema.parse(raw);
    const servers = (await this.registry())
      .filter(
        (server) =>
          server.enabled && (!input.serverId || server.id === input.serverId),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    if (input.serverId && servers.length === 0)
      throw new HubError("MCP server was not found or is disabled.");
    const tools: ToolSummary[] = [];
    const errors: { serverId: string; message: string }[] = [];
    let truncated = false;
    let bytes = 0;
    let matched = 0;
    let pageFull = false;
    const words = input.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    for (let start = 0; start < servers.length; start += 4) {
      const batch = await Promise.all(
        servers.slice(start, start + 4).map(async (server) => {
          try {
            return {
              id: server.id,
              tools: await this.tools(server.id, signal),
            };
          } catch (error) {
            return {
              id: server.id,
              error:
                error instanceof HubError
                  ? error.message
                  : "MCP operation failed.",
            };
          }
        }),
      );
      for (const result of batch) {
        if (result.error !== undefined) {
          errors.push({ serverId: result.id, message: result.error });
          continue;
        }
        for (const tool of (result.tools ?? []).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          if (
            !words.every((word) =>
              `${tool.serverId} ${tool.name} ${tool.description}`
                .toLocaleLowerCase()
                .includes(word),
            )
          )
            continue;
          const size = Buffer.byteLength(JSON.stringify(tool));
          if (size > MAX_CATALOG_BYTES) {
            errors.push({
              serverId: tool.serverId,
              message:
                "An MCP tool input schema exceeds 500 KB and was excluded from search.",
            });
            continue;
          }
          if (matched++ < input.offset) continue;
          if (
            pageFull ||
            tools.length >= input.limit ||
            bytes + size > MAX_CATALOG_BYTES
          ) {
            truncated = true;
            pageFull = true;
            continue;
          }
          bytes += size;
          tools.push(tool);
        }
      }
    }
    return { tools, errors, truncated };
  }
  async call(raw: CallInput, signal?: AbortSignal): Promise<CallResult> {
    const input = callInputSchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(input.arguments)) > 200_000)
      throw new HubError("MCP tool arguments exceed 200 KB.");
    return this.use(input.serverId, signal, async (client, operationSignal) => {
      const result = await client.callTool(
        { name: input.name, arguments: input.arguments },
        { signal: operationSignal, timeout: REQUEST_TIMEOUT_MS },
      );
      const content: CallResult["content"] = [];
      let bytes = 0;
      let lossy = false;
      for (const item of result.content) {
        const part =
          item.type === "text"
            ? { type: "text" as const, text: item.text }
            : item.type === "image"
              ? {
                  type: "image" as const,
                  data: item.data,
                  mimeType: item.mimeType,
                }
              : {
                  type: "text" as const,
                  text: `[MCP content type ${item.type} is not supported by the BB tools bridge]`,
                };
        const size = Buffer.byteLength(JSON.stringify(part));
        if (bytes + size > MAX_OUTPUT_BYTES) {
          content.push({
            type: "text",
            text: "[MCP response exceeds 1 MB; remaining content was omitted.]",
          });
          lossy = true;
          break;
        }
        bytes += size;
        content.push(part);
        if (item.type !== "text" && item.type !== "image") lossy = true;
      }
      if (result.structuredContent !== undefined) {
        const text = JSON.stringify(result.structuredContent);
        const size = Buffer.byteLength(text);
        content.push({
          type: "text",
          text:
            bytes + size > MAX_OUTPUT_BYTES
              ? "[Structured MCP response exceeds 1 MB and was omitted.]"
              : text,
        });
        if (bytes + size > MAX_OUTPUT_BYTES) lossy = true;
      }
      return { content, isError: Boolean(result.isError) || lossy };
    });
  }
}
