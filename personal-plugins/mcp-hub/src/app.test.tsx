// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { serverInputSchema } from "./contract.js";
import type { ServerSummary } from "./contract.js";

const app = await loadPluginApp(() => import("./app.js"));
const server: ServerSummary = {
  id: "analytics",
  name: "Аналитика",
  enabled: true,
  transport: "http",
  url: "https://example.com/mcp",
  hasToken: true,
  envKeys: [],
};

afterEach(cleanup);

describe("MCP Hub management", () => {
  it("creates a disabled server and enables access only after an explicit action", async () => {
    let servers: ServerSummary[] = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          list: () => ({ servers }),
          upsert: (input: unknown) => {
            const parsed = serverInputSchema.parse(input);
            const saved = { ...server, ...parsed, hasToken: false };
            servers = [saved];
            return { server: saved };
          },
        },
      },
    );
    await slot.findByRole("heading", { name: "Подключите первый сервер" });
    fireEvent.click(slot.getByRole("button", { name: "+ Добавить сервер" }));
    expect(slot.getByLabelText("Доступен агентам")).toHaveProperty(
      "checked",
      false,
    );
    fireEvent.change(slot.getByLabelText(/^Идентификатор/), {
      target: { value: "analytics" },
    });
    fireEvent.change(slot.getByLabelText("Название"), {
      target: { value: "Аналитика" },
    });
    fireEvent.change(slot.getByLabelText(/^URL Streamable HTTP/), {
      target: { value: "https://example.com/mcp" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить сервер" }));
    await slot.findByRole("heading", { name: "Аналитика" });
    expect(
      slot.getByRole("button", { name: "Проверить и показать инструменты" }),
    ).toHaveProperty("disabled", true);
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "upsert")[0],
    ).toEqual({
      method: "upsert",
      input: {
        id: "analytics",
        name: "Аналитика",
        enabled: false,
        transport: "http",
        url: "https://example.com/mcp",
      },
    });
    fireEvent.click(slot.getByRole("button", { name: "Включить" }));
    await slot.findByText("Включён");
    expect(
      slot.getByRole("button", { name: "Проверить и показать инструменты" }),
    ).toHaveProperty("disabled", false);
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "upsert")[1],
    ).toEqual({
      method: "upsert",
      input: {
        id: "analytics",
        name: "Аналитика",
        enabled: true,
        transport: "http",
        url: "https://example.com/mcp",
      },
    });
  });

  it("edits without exposing or replacing a stored token, then explicitly clears it", async () => {
    let current = server;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          list: () => ({ servers: [current] }),
          upsert: (input: unknown) => {
            const parsed = serverInputSchema.parse(input);
            current = {
              ...current,
              name: parsed.name,
              hasToken: parsed.bearerToken === "" ? false : current.hasToken,
            };
            return { server: current };
          },
        },
      },
    );
    await slot.findByRole("heading", { name: "Аналитика" });
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    expect(slot.getByLabelText(/Bearer-токен/)).toHaveProperty("value", "");
    fireEvent.change(slot.getByLabelText("Название"), {
      target: { value: "Новая аналитика" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить сервер" }));
    await slot.findByRole("heading", { name: "Новая аналитика" });
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "upsert"),
    ).toEqual([
      {
        method: "upsert",
        input: {
          id: "analytics",
          name: "Новая аналитика",
          enabled: true,
          transport: "http",
          url: "https://example.com/mcp",
        },
      },
    ]);
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    fireEvent.click(slot.getByLabelText("Удалить сохранённый токен"));
    fireEvent.click(slot.getByRole("button", { name: "Сохранить сервер" }));
    await waitFor(() =>
      expect(slot.queryByText("Bearer-токен сохранён")).toBeNull(),
    );
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "upsert")[1],
    ).toEqual({
      method: "upsert",
      input: {
        id: "analytics",
        name: "Новая аналитика",
        enabled: true,
        transport: "http",
        url: "https://example.com/mcp",
        bearerToken: "",
      },
    });
  });

  it("requires inline confirmation before removing and refreshes the empty state", async () => {
    let servers = [server];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          list: () => ({ servers }),
          remove: () => {
            servers = [];
            return { removed: true };
          },
        },
      },
    );
    await slot.findByRole("heading", { name: "Аналитика" });
    fireEvent.click(slot.getByRole("button", { name: "Удалить" }));
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "remove"),
    ).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Отмена" }));
    expect(slot.queryByRole("button", { name: "Да, удалить" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Удалить" }));
    fireEvent.click(slot.getByRole("button", { name: "Да, удалить" }));
    await slot.findByRole("heading", { name: "Подключите первый сервер" });
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "remove"),
    ).toEqual([{ method: "remove", input: { id: "analytics" } }]);
    expect(slot.queryByRole("heading", { name: "Аналитика" })).toBeNull();
  });

  it("shows upstream schemas and hides private transport errors", async () => {
    let fail = false;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          list: () => ({ servers: [server] }),
          inspect: () => {
            if (fail)
              throw new Error(
                "Authorization: Bearer private-token-in-upstream-error",
              );
            return {
              tools: [
                {
                  serverId: "analytics",
                  name: "list_sales",
                  description: "Продажи товара",
                  inputSchema: {
                    type: "object",
                    properties: { sku: { type: "number" } },
                    required: ["sku"],
                  },
                },
              ],
            };
          },
        },
      },
    );
    await slot.findByRole("heading", { name: "Аналитика" });
    fireEvent.click(
      slot.getByRole("button", { name: "Проверить и показать инструменты" }),
    );
    await slot.findByText("list_sales");
    fireEvent.click(slot.getByText("list_sales"));
    expect(slot.getByText("Продажи товара")).toBeTruthy();
    expect(slot.getByText(/"sku":/).textContent).toContain('"required": [');
    fail = true;
    fireEvent.click(
      slot.getByRole("button", { name: "Проверить и показать инструменты" }),
    );
    await slot.findByRole("alert");
    expect(slot.getByRole("alert").textContent).toContain(
      "Проверьте доступность сервера и авторизацию",
    );
    expect(slot.container.textContent).not.toContain(
      "private-token-in-upstream-error",
    );
    expect(slot.queryByText("list_sales")).toBeNull();
  });
});
