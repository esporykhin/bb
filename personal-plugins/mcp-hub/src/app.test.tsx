// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { serverInputSchema } from "./contract.js";
import type { ServerInput, ServerSummary } from "./contract.js";

const app = await loadPluginApp(() => import("./app.js"));
const http: ServerInput = {
  id: "analytics",
  name: "Аналитика",
  enabled: true,
  transport: "http",
  url: "https://example.com/mcp",
  bearerToken: "stored-http-token",
};
const stdio: ServerInput = {
  id: "local",
  name: "Локальный сервис",
  enabled: true,
  transport: "stdio",
  command: "/usr/bin/node",
  args: ["server.js"],
  env: { API_TOKEN: "stored-local-token", REGION: "eu" },
};
const kaiten: ServerInput = {
  id: "kaiten",
  name: "Kaiten",
  enabled: true,
  transport: "stdio",
  command: "/opt/homebrew/bin/npx",
  args: ["-y", "@kaiten/mcp"],
  env: {},
};
function summary(server: ServerInput): ServerSummary {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    ...(server.transport === "http"
      ? { url: server.url }
      : { command: server.command, args: server.args }),
    hasToken: !!server.bearerToken,
    envKeys: Object.keys(server.env ?? {}),
  };
}
function setup(initial: ServerInput[]) {
  const saved = new Map(
    initial.map((server) => [server.id, structuredClone(server)]),
  );
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        list: () => ({ servers: [...saved.values()].map(summary) }),
        configuration: (raw: unknown) => {
          const input = raw as { id: string };
          const server = saved.get(input.id);
          if (!server) throw new Error("Missing configuration");
          return { server: structuredClone(server) };
        },
        upsert: (raw: unknown) => {
          const input = serverInputSchema.parse(raw);
          const server = { ...saved.get(input.id), ...input };
          saved.set(input.id, server);
          return { server: summary(server) };
        },
        remove: (raw: unknown) => ({
          removed: saved.delete((raw as { id: string }).id),
        }),
        call: () => ({
          content: [{ type: "text", text: "private-space-payload" }],
          isError: false,
        }),
      },
    },
  );
  return { slot, saved };
}
afterEach(cleanup);

describe("MCP Hub settings", () => {
  it.each([
    { key: "KAITEN_SUBDOMAIN", change: "unchanged" },
    { key: "KAITEN_SUBDOMAIN", change: "token" },
    { key: "KAITEN_DOMAIN", change: "unchanged" },
    { key: "KAITEN_DOMAIN", change: "token" },
  ])(
    "normalizes a legacy URL in $key on $change save and preserves normalized settings on reopening",
    async ({ key, change }) => {
      const original = {
        ...kaiten,
        env: {
          [key]: "https://company.kaiten.ru",
          KAITEN_TOKEN: "stored-token",
          OTHER: "preserve",
        },
      };
      const { slot, saved } = setup([original]);
      await slot.findByRole("heading", { name: "Kaiten" });
      fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
      expect(await slot.findByLabelText("Адрес Kaiten")).toHaveProperty(
        "value",
        "https://company.kaiten.ru",
      );
      if (change === "token")
        fireEvent.change(slot.getByLabelText("API-токен Kaiten"), {
          target: { value: "updated-token" },
        });
      fireEvent.click(
        slot.getByRole("button", { name: "Сохранить настройки" }),
      );
      const normalized = {
        OTHER: "preserve",
        KAITEN_BASE_URL: "https://company.kaiten.ru",
        KAITEN_TOKEN: change === "token" ? "updated-token" : "stored-token",
      };
      await waitFor(() => expect(saved.get("kaiten")?.env).toEqual(normalized));
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "upsert")[0]
          ?.input,
      ).toEqual({
        id: "kaiten",
        name: "Kaiten",
        enabled: true,
        transport: "stdio",
        command: kaiten.command,
        args: kaiten.args,
        env: normalized,
      });
      await waitFor(() =>
        expect(
          slot.getByRole("button", { name: "Закрыть настройки" }),
        ).toHaveProperty("disabled", false),
      );
      fireEvent.click(slot.getByRole("button", { name: "Закрыть настройки" }));
      fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
      expect(await slot.findByLabelText("Адрес Kaiten")).toHaveProperty(
        "value",
        "https://company.kaiten.ru",
      );
      expect(slot.getByLabelText("API-токен Kaiten")).toHaveProperty(
        "value",
        normalized.KAITEN_TOKEN,
      );
      fireEvent.change(slot.getByLabelText("Название"), {
        target: { value: "Мой Kaiten" },
      });
      fireEvent.click(
        slot.getByRole("button", { name: "Сохранить настройки" }),
      );
      await slot.findByRole("heading", { name: "Мой Kaiten" });
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "upsert")[1]
          ?.input,
      ).toEqual({
        id: "kaiten",
        name: "Мой Kaiten",
        enabled: true,
        transport: "stdio",
        command: kaiten.command,
        args: kaiten.args,
      });
      expect(saved.get("kaiten")?.env).toEqual(normalized);
    },
  );

  it("loads and clears a legacy Kaiten address without leaving fallback credentials", async () => {
    const { slot, saved } = setup([
      {
        ...kaiten,
        env: {
          KAITEN_DOMAIN: "legacy",
          KAITEN_BASE_DOMAIN: "example.org",
          KAITEN_TOKEN: "legacy-token",
        },
      },
    ]);
    await slot.findByRole("heading", { name: "Kaiten" });
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    expect(await slot.findByLabelText("Адрес Kaiten")).toHaveProperty(
      "value",
      "legacy",
    );
    fireEvent.change(slot.getByLabelText("Адрес Kaiten"), {
      target: { value: "" },
    });
    fireEvent.change(slot.getByLabelText("API-токен Kaiten"), {
      target: { value: "" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить настройки" }));
    await waitFor(() =>
      expect(saved.get("kaiten")?.env).toEqual({
        KAITEN_BASE_DOMAIN: "example.org",
      }),
    );
  });

  it("reports successful save separately when the configuration read-back fails", async () => {
    let saved = false;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          list: () => ({ servers: [summary(http)] }),
          configuration: () => {
            if (saved) throw new Error("private-read-error");
            return { server: http };
          },
          upsert: () => {
            saved = true;
            return { server: summary(http) };
          },
        },
      },
    );
    await slot.findByRole("heading", { name: "Аналитика" });
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    fireEvent.change(await slot.findByLabelText("Название"), {
      target: { value: "Новое имя" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить настройки" }));
    await slot.findByText(/Настройки сохранены, но не удалось обновить форму/);
    expect(saved).toBe(true);
    expect(slot.queryByRole("alert")).toBeNull();
    expect(slot.container.textContent).not.toContain("private-read-error");
    expect(slot.getByLabelText("Bearer-токен")).toHaveProperty(
      "value",
      "stored-http-token",
    );
  });

  it("creates a disabled server and enables access only after an explicit action", async () => {
    const { slot, saved } = setup([]);
    await slot.findByRole("heading", { name: "Подключите первый сервер" });
    fireEvent.click(slot.getByRole("button", { name: "+ Добавить сервер" }));
    expect(slot.getByLabelText("Доступен агентам")).toHaveProperty(
      "checked",
      false,
    );
    fireEvent.change(slot.getByLabelText("Идентификатор"), {
      target: { value: "analytics" },
    });
    fireEvent.change(slot.getByLabelText("Название"), {
      target: { value: "Аналитика" },
    });
    fireEvent.change(slot.getByLabelText("URL Streamable HTTP"), {
      target: { value: "https://example.com/mcp" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить настройки" }));
    await slot.findByRole("heading", { name: "Аналитика" });
    expect(saved.get("analytics")).toEqual({
      ...http,
      enabled: false,
      bearerToken: "",
    });
    expect(
      slot.getByRole("button", { name: "Показать инструменты" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(slot.getByRole("button", { name: "Включить" }));
    await slot.findByText("Включён");
    expect(
      slot.getByRole("button", { name: "Показать инструменты" }),
    ).toHaveProperty("disabled", false);
    expect(saved.get("analytics")?.enabled).toBe(true);
  });

  it("loads, reveals and clears HTTP credentials while a rename preserves concurrent token changes", async () => {
    const { slot, saved } = setup([http]);
    await slot.findByRole("heading", { name: "Аналитика" });
    expect(
      slot.inspection.rpcCalls.filter(
        (call) => call.method === "configuration",
      ),
    ).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    const token = await slot.findByLabelText("Bearer-токен");
    expect(token).toHaveProperty("value", "stored-http-token");
    expect(token).toHaveProperty("type", "password");
    fireEvent.click(
      slot.getByRole("button", { name: "Показать Bearer-токен" }),
    );
    expect(token).toHaveProperty("type", "text");
    fireEvent.click(slot.getByRole("button", { name: "Скрыть Bearer-токен" }));
    expect(token).toHaveProperty("type", "password");
    saved.set("analytics", { ...http, bearerToken: "concurrent-token" });
    fireEvent.change(slot.getByLabelText("Название"), {
      target: { value: "Новая аналитика" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить настройки" }));
    await slot.findByRole("heading", { name: "Новая аналитика" });
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "upsert")[0],
    ).toEqual({
      method: "upsert",
      input: {
        id: "analytics",
        name: "Новая аналитика",
        enabled: true,
        transport: "http",
        url: "https://example.com/mcp",
      },
    });
    expect(slot.getByLabelText("Bearer-токен")).toHaveProperty(
      "value",
      "concurrent-token",
    );
    fireEvent.change(slot.getByLabelText("Bearer-токен"), {
      target: { value: "" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить настройки" }));
    await waitFor(() => expect(saved.get("analytics")?.bearerToken).toBe(""));
    await waitFor(() =>
      expect(
        slot.getByRole("button", { name: "Закрыть настройки" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(slot.getByRole("button", { name: "Закрыть настройки" }));
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    expect(await slot.findByLabelText("Bearer-токен")).toHaveProperty(
      "value",
      "",
    );
  });

  it("edits stdio variables and argument rows and persists additions, clearing and deletion", async () => {
    const { slot, saved } = setup([stdio]);
    await slot.findByRole("heading", { name: "Локальный сервис" });
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    const token = await slot.findByLabelText("Значение переменной API_TOKEN");
    expect(token).toHaveProperty("value", "stored-local-token");
    expect(slot.container.querySelector("textarea")).toBeNull();
    fireEvent.click(
      slot.getByRole("button", {
        name: "Показать Значение переменной API_TOKEN",
      }),
    );
    expect(token).toHaveProperty("type", "text");
    fireEvent.change(token, { target: { value: "" } });
    fireEvent.click(
      slot.getByRole("button", { name: "Удалить переменную REGION" }),
    );
    fireEvent.click(
      slot.getByRole("button", { name: "+ Добавить переменную" }),
    );
    fireEvent.change(slot.getByLabelText("Имя переменной 2"), {
      target: { value: "WORKSPACE" },
    });
    fireEvent.change(slot.getByLabelText("Значение переменной WORKSPACE"), {
      target: { value: "team" },
    });
    fireEvent.click(slot.getByRole("button", { name: "+ Добавить аргумент" }));
    fireEvent.change(slot.getByLabelText("Аргумент 2"), {
      target: { value: "--compact" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Удалить аргумент 1" }));
    fireEvent.click(slot.getByRole("button", { name: "Сохранить настройки" }));
    await waitFor(() =>
      expect(saved.get("local")).toEqual({
        ...stdio,
        args: ["--compact"],
        env: { API_TOKEN: "", WORKSPACE: "team" },
      }),
    );
    await waitFor(() =>
      expect(
        slot.getByRole("button", { name: "Закрыть настройки" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(slot.getByRole("button", { name: "Закрыть настройки" }));
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    expect(
      await slot.findByLabelText("Значение переменной WORKSPACE"),
    ).toHaveProperty("value", "team");
    expect(slot.getByLabelText("Аргумент 1")).toHaveProperty(
      "value",
      "--compact",
    );
    fireEvent.click(
      slot.getByRole("button", { name: "Удалить переменную API_TOKEN" }),
    );
    fireEvent.click(
      slot.getByRole("button", { name: "Удалить переменную WORKSPACE" }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Сохранить настройки" }));
    await waitFor(() => expect(saved.get("local")?.env).toEqual({}));
  });

  it("offers Kaiten address and token fields, persists them, and checks saved access without showing payloads", async () => {
    const { slot, saved } = setup([kaiten]);
    await slot.findByRole("heading", { name: "Kaiten" });
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    const address = await slot.findByLabelText("Адрес Kaiten");
    expect(slot.getByLabelText("API-токен Kaiten")).toHaveProperty("value", "");
    expect(
      slot.getByText("Дополнительные настройки запуска").closest("details"),
    ).toHaveProperty("open", false);
    fireEvent.change(address, { target: { value: "company.kaiten.ru" } });
    fireEvent.change(slot.getByLabelText("API-токен Kaiten"), {
      target: { value: "kaiten-secret" },
    });
    expect(
      slot.getByRole("button", { name: "Проверить доступ к Kaiten" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(slot.getByRole("button", { name: "Сохранить настройки" }));
    await waitFor(() =>
      expect(saved.get("kaiten")?.env).toEqual({
        KAITEN_BASE_URL: "https://company.kaiten.ru",
        KAITEN_TOKEN: "kaiten-secret",
      }),
    );
    await waitFor(() =>
      expect(
        slot.getByRole("button", { name: "Проверить доступ к Kaiten" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      slot.getByRole("button", { name: "Проверить доступ к Kaiten" }),
    );
    await slot.findByText(
      "Доступ к Kaiten подтверждён: список пространств получен.",
    );
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "call"),
    ).toEqual([
      {
        method: "call",
        input: {
          serverId: "kaiten",
          name: "kaiten_list_spaces",
          arguments: { compact: true },
        },
      },
    ]);
    expect(slot.container.textContent).not.toContain("private-space-payload");
    fireEvent.click(slot.getByRole("button", { name: "Закрыть настройки" }));
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    expect(await slot.findByLabelText("API-токен Kaiten")).toHaveProperty(
      "value",
      "kaiten-secret",
    );
    expect(slot.getByLabelText("Адрес Kaiten")).toHaveProperty(
      "value",
      "https://company.kaiten.ru",
    );
    fireEvent.change(slot.getByLabelText("Адрес Kaiten"), {
      target: { value: "newteam" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить настройки" }));
    await waitFor(() =>
      expect(saved.get("kaiten")?.env).toEqual({
        KAITEN_SUBDOMAIN: "newteam",
        KAITEN_TOKEN: "kaiten-secret",
      }),
    );
  });

  it("does not normalize unchanged Kaiten addresses when editing another parameter", async () => {
    const original = {
      ...kaiten,
      env: {
        KAITEN_BASE_URL: "https://company.kaiten.ru/custom/",
        KAITEN_SUBDOMAIN: "legacy",
        KAITEN_TOKEN: "old-token",
        OTHER: "keep",
      },
    };
    const { slot, saved } = setup([original]);
    await slot.findByRole("heading", { name: "Kaiten" });
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    fireEvent.change(await slot.findByLabelText("API-токен Kaiten"), {
      target: { value: "new-token" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить настройки" }));
    await waitFor(() =>
      expect(saved.get("kaiten")?.env).toEqual({
        ...original.env,
        KAITEN_TOKEN: "new-token",
      }),
    );
  });

  it("keeps unsaved settings when another server or a new connection is selected", async () => {
    const { slot } = setup([http]);
    await slot.findByRole("heading", { name: "Аналитика" });
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    fireEvent.change(await slot.findByLabelText("Bearer-токен"), {
      target: { value: "unsaved-token" },
    });
    fireEvent.click(slot.getByRole("button", { name: "+ Добавить сервер" }));
    expect(slot.getByLabelText("Bearer-токен")).toHaveProperty(
      "value",
      "unsaved-token",
    );
    expect(slot.getByRole("alert").textContent).toContain(
      "Сохраните или отмените",
    );
    fireEvent.click(slot.getByRole("button", { name: "Настроить" }));
    expect(slot.getByLabelText("Bearer-токен")).toHaveProperty(
      "value",
      "unsaved-token",
    );
    fireEvent.click(slot.getByRole("button", { name: "Отменить изменения" }));
    expect(slot.queryByLabelText("Bearer-токен")).toBeNull();
  });

  it("requires inline confirmation before removing and refreshes the empty state", async () => {
    const { slot, saved } = setup([http]);
    await slot.findByRole("heading", { name: "Аналитика" });
    fireEvent.click(slot.getByRole("button", { name: "Удалить" }));
    expect(saved.has("analytics")).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Отмена" }));
    expect(slot.queryByRole("button", { name: "Да, удалить" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Удалить" }));
    fireEvent.click(slot.getByRole("button", { name: "Да, удалить" }));
    await slot.findByRole("heading", { name: "Подключите первый сервер" });
    expect(saved.has("analytics")).toBe(false);
  });

  it("shows schemas without claiming service authentication and hides private transport errors", async () => {
    let fail = false;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          list: () => ({ servers: [summary(http)] }),
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
    fireEvent.click(slot.getByRole("button", { name: "Показать инструменты" }));
    await slot.findByText("list_sales");
    expect(slot.getByRole("status").textContent).toContain(
      "Доступ к данным сервиса этим не проверяется",
    );
    fireEvent.click(slot.getByText("list_sales"));
    expect(slot.getByText("Продажи товара")).toBeTruthy();
    expect(slot.getByText(/"sku":/).textContent).toContain('"required": [');
    fail = true;
    fireEvent.click(slot.getByRole("button", { name: "Показать инструменты" }));
    await slot.findByRole("alert");
    expect(slot.container.textContent).not.toContain(
      "private-token-in-upstream-error",
    );
    expect(slot.queryByText("list_sales")).toBeNull();
  });
});
