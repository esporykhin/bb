import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  rpcContract,
  ServerInput,
  ServerSummary,
  ToolSummary,
} from "./contract.js";

const control =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const button =
  "rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${button} border-primary bg-primary text-primary-foreground hover:opacity-90`;

type Draft = {
  id: string;
  name: string;
  enabled: boolean;
  transport: "http" | "stdio";
  url: string;
  bearerToken: string;
  clearToken: boolean;
  command: string;
  args: string;
  env: string;
  clearEnv: boolean;
};

const emptyDraft = (): Draft => ({
  id: "",
  name: "",
  enabled: false,
  transport: "http",
  url: "",
  bearerToken: "",
  clearToken: false,
  command: "",
  args: "[]",
  env: "",
  clearEnv: false,
});

function parseArgs(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      'Аргументы должны быть JSON-массивом строк, например ["--port", "3000"].',
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item): item is string => typeof item === "string")
  ) {
    throw new Error("Аргументы должны быть JSON-массивом строк.");
  }
  return parsed;
}

function parseEnv(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      "Переменные окружения должны быть JSON-объектом со строковыми значениями.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "Переменные окружения должны быть JSON-объектом со строковыми значениями.",
    );
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== "string")
      throw new Error("Значения переменных окружения должны быть строками.");
    result[key] = item;
  }
  return result;
}

function serverInput(draft: Draft): ServerInput {
  const base = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    enabled: draft.enabled,
    transport: draft.transport,
  };
  if (draft.transport === "http") {
    return {
      ...base,
      url: draft.url.trim(),
      ...(draft.clearToken
        ? { bearerToken: "" }
        : draft.bearerToken
          ? { bearerToken: draft.bearerToken }
          : {}),
    };
  }
  return {
    ...base,
    command: draft.command.trim(),
    args: parseArgs(draft.args),
    ...(draft.clearEnv
      ? { env: {} }
      : draft.env.trim()
        ? { env: parseEnv(draft.env) }
        : {}),
  };
}

export function McpHub() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const formId = useId();
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [tools, setTools] = useState<{
    serverId: string;
    items: ToolSummary[];
  } | null>(null);
  const [toolQuery, setToolQuery] = useState("");
  const mounted = useRef(true);
  const busy = useRef(false);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const result = await rpc.call("list");
      if (!mounted.current || current !== sequence.current) return;
      setServers(result.servers);
      setLoaded(true);
      setLoadError(false);
    } catch {
      if (mounted.current && current === sequence.current) setLoadError(true);
    }
  }, [rpc]);

  useEffect(() => {
    mounted.current = true;
    queueMicrotask(() => {
      if (mounted.current) void refresh();
    });
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (connection === "connected") {
      queueMicrotask(() => {
        if (mounted.current) void refresh();
      });
    }
  }, [connection, refresh]);
  useRealtime("servers-changed", () => {
    void refresh();
  });

  async function mutate(
    key: string,
    operation: () => Promise<void>,
    failure: string,
  ) {
    if (busy.current) return;
    busy.current = true;
    setPending(key);
    setActionError("");
    setNotice("");
    try {
      await operation();
    } catch {
      if (mounted.current) setActionError(failure);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  }

  function startNew() {
    setDraft(emptyDraft());
    setEditing(null);
    setFormOpen(true);
    setActionError("");
    setNotice("");
  }

  function startEdit(server: ServerSummary) {
    setDraft({
      ...emptyDraft(),
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      url: server.url ?? "",
      command: server.command ?? "",
      args: JSON.stringify(server.args ?? []),
    });
    setEditing(server.id);
    setFormOpen(true);
    setActionError("");
    setNotice("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let input: ServerInput;
    try {
      input = serverInput(draft);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Проверьте формат полей.",
      );
      return;
    }
    await mutate(
      "save",
      async () => {
        await rpc.call("upsert", input);
        if (!mounted.current) return;
        setFormOpen(false);
        setDraft(emptyDraft());
        setEditing(null);
        setTools(null);
        setNotice(
          "Сервер сохранён. Он доступен через общие инструменты MCP Hub.",
        );
        await refresh();
      },
      "Не удалось сохранить сервер. Проверьте адрес, команду и значения полей, затем повторите.",
    );
  }

  async function toggle(server: ServerSummary) {
    await mutate(
      server.id,
      async () => {
        await rpc.call("upsert", {
          id: server.id,
          name: server.name,
          transport: server.transport,
          enabled: !server.enabled,
          ...(server.transport === "http"
            ? { url: server.url }
            : { command: server.command, args: server.args ?? [] }),
        });
        if (!mounted.current) return;
        setTools(null);
        setNotice(
          server.enabled
            ? "Сервер выключен для агентов."
            : "Сервер включён для агентов.",
        );
        await refresh();
      },
      "Не удалось изменить состояние сервера. Обновите список и повторите.",
    );
  }

  async function remove(server: ServerSummary) {
    await mutate(
      server.id,
      async () => {
        await rpc.call("remove", { id: server.id });
        if (!mounted.current) return;
        setConfirmRemove(null);
        if (tools?.serverId === server.id) setTools(null);
        if (editing === server.id) {
          setFormOpen(false);
          setDraft(emptyDraft());
          setEditing(null);
        }
        setNotice("Сервер удалён из MCP Hub.");
        await refresh();
      },
      "Не удалось удалить сервер. Обновите список и повторите.",
    );
  }

  async function inspect(server: ServerSummary) {
    await mutate(
      server.id,
      async () => {
        setTools(null);
        const result = await rpc.call("inspect", { id: server.id });
        if (!mounted.current) return;
        setTools({ serverId: server.id, items: result.tools });
        setToolQuery("");
        setNotice(
          `Соединение проверено. Инструментов: ${result.tools.length}.`,
        );
      },
      "Не удалось получить инструменты. Проверьте доступность сервера и авторизацию. Для stdio проверьте команду на машине сервера BB.",
    );
  }

  const editedServer = servers.find((server) => server.id === editing);
  const selectedServer = servers.find(
    (server) => server.id === tools?.serverId,
  );
  const filteredTools =
    tools?.items.filter((tool) =>
      `${tool.name} ${tool.description}`
        .toLocaleLowerCase()
        .includes(toolQuery.toLocaleLowerCase()),
    ) ?? [];
  const disabled = pending !== null;

  return (
    <main className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto bg-background p-4 text-foreground md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
        <div className="max-w-2xl space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Единые подключения
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">MCP Hub</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Общие для агентов BB. Новые чаты получают инструменты хаба.
            Локальные команды запускаются на сервере BB.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={button}
            disabled={disabled}
            onClick={() => void refresh()}
          >
            Обновить
          </button>
          <button
            type="button"
            className={primary}
            disabled={disabled || !loaded}
            aria-expanded={formOpen}
            aria-controls={formId}
            onClick={startNew}
          >
            + Добавить сервер
          </button>
        </div>
      </header>

      <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
        Подключите сервер один раз: агенты находят его инструменты через поиск
        MCP Hub и вызывают их с нужными аргументами. Поддерживаются инструменты
        MCP; OAuth, ресурсы и промпты пока недоступны.
      </div>
      {loadError && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive-text"
        >
          Не удалось загрузить серверы. Проверьте соединение с BB и нажмите
          «Обновить».
        </div>
      )}
      {actionError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive-text"
        >
          {actionError}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm"
        >
          {notice}
        </p>
      )}

      {formOpen && (
        <form
          id={formId}
          onSubmit={save}
          className="space-y-4 rounded-xl border border-primary/30 bg-card p-4 md:p-5"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              {editing ? "Настройки сервера" : "Новый MCP-сервер"}
            </h2>
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={() => {
                setFormOpen(false);
                setDraft(emptyDraft());
                setEditing(null);
              }}
            >
              Отмена
            </button>
          </div>
          <fieldset disabled={disabled} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span>Идентификатор</span>
                <input
                  required
                  pattern="[a-z0-9][a-z0-9_-]*"
                  maxLength={64}
                  readOnly={editing !== null}
                  value={draft.id}
                  onChange={(event) =>
                    setDraft({ ...draft, id: event.target.value })
                  }
                  placeholder="mpstats"
                  className={control}
                />
                <span className="block text-xs text-muted-foreground">
                  Строчные латинские буквы, цифры, дефис и подчёркивание.
                </span>
              </label>
              <label className="space-y-1 text-sm">
                <span>Название</span>
                <input
                  required
                  maxLength={120}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                  placeholder="Аналитика MPSTATS"
                  className={control}
                />
              </label>
            </div>
            <label className="block space-y-1 text-sm">
              <span>Подключение</span>
              <select
                value={draft.transport}
                onChange={(event) => {
                  const next = event.target.value;
                  if (next === "http" || next === "stdio")
                    setDraft({
                      ...draft,
                      transport: next,
                      bearerToken: "",
                      clearToken: false,
                      env: "",
                      clearEnv: false,
                    });
                }}
                className={control}
              >
                <option value="http">HTTP — удалённый MCP-сервер</option>
                <option value="stdio">
                  stdio — локальная команда на сервере BB
                </option>
              </select>
            </label>
            {draft.transport === "http" ? (
              <>
                <label className="block space-y-1 text-sm">
                  <span>URL Streamable HTTP</span>
                  <input
                    required
                    type="url"
                    value={draft.url}
                    onChange={(event) =>
                      setDraft({ ...draft, url: event.target.value })
                    }
                    placeholder="https://example.com/mcp"
                    className={control}
                  />
                  <span className="block text-xs text-muted-foreground">
                    Передавайте токен через отдельное поле, без логина и пароля
                    в адресе.
                  </span>
                </label>
                <label className="block space-y-1 text-sm">
                  <span>
                    Bearer-токен{editedServer?.hasToken ? " · сохранён" : ""}
                  </span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    disabled={draft.clearToken}
                    value={draft.bearerToken}
                    onChange={(event) =>
                      setDraft({ ...draft, bearerToken: event.target.value })
                    }
                    placeholder={
                      editedServer?.hasToken
                        ? "Оставьте пустым, чтобы сохранить текущий"
                        : "Необязательно"
                    }
                    className={control}
                  />
                </label>
                {editedServer?.hasToken && (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.clearToken}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          clearToken: event.target.checked,
                          bearerToken: "",
                        })
                      }
                    />
                    Удалить сохранённый токен
                  </label>
                )}
              </>
            ) : (
              <>
                <p className="rounded-lg border border-attention/30 bg-surface-attention p-3 text-sm">
                  Команда запускается на машине сервера BB. Пути и установленные
                  программы удалённой машины агента здесь не используются.
                </p>
                <label className="block space-y-1 text-sm">
                  <span>Исполняемый файл</span>
                  <input
                    required
                    value={draft.command}
                    onChange={(event) =>
                      setDraft({ ...draft, command: event.target.value })
                    }
                    placeholder="/opt/homebrew/bin/npx"
                    className={control}
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Аргументы · JSON-массив строк</span>
                  <textarea
                    rows={2}
                    value={draft.args}
                    onChange={(event) =>
                      setDraft({ ...draft, args: event.target.value })
                    }
                    className={`${control} font-mono`}
                    spellCheck={false}
                    placeholder={'["-y", "@example/mcp-server"]'}
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  <span>Переменные окружения · JSON-объект</span>
                  <textarea
                    rows={3}
                    disabled={draft.clearEnv}
                    value={draft.env}
                    onChange={(event) =>
                      setDraft({ ...draft, env: event.target.value })
                    }
                    className={`${control} font-mono`}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={'{"API_TOKEN": "значение"}'}
                  />
                  <span className="block text-xs text-muted-foreground">
                    Пустое поле сохраняет текущие переменные. Объект заменяет их
                    целиком.
                    {editedServer?.envKeys.length
                      ? ` Сохранены: ${editedServer.envKeys.join(", ")}.`
                      : ""}
                  </span>
                </label>
                {!!editedServer?.envKeys.length && (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.clearEnv}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          clearEnv: event.target.checked,
                          env: "",
                        })
                      }
                    />
                    Удалить сохранённые переменные
                  </label>
                )}
              </>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) =>
                  setDraft({ ...draft, enabled: event.target.checked })
                }
              />
              Доступен агентам
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Разрешить агентам вызовы инструментов этого сервера, включая
              изменение данных.
            </p>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={primary} disabled={disabled}>
              {pending === "save" ? "Сохранение…" : "Сохранить сервер"}
            </button>
            <p className="text-xs text-muted-foreground">
              Токены и переменные хранятся в закрытом хранилище BB и не
              возвращаются в список.
            </p>
          </div>
        </form>
      )}

      {!loaded && !loadError && (
        <p role="status" className="py-6 text-sm text-muted-foreground">
          Загрузка MCP-серверов…
        </p>
      )}
      {loaded && servers.length === 0 && (
        <section className="rounded-xl border border-dashed border-border p-8 text-center">
          <h2 className="text-lg font-semibold">Подключите первый сервер</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Добавьте MPSTATS, память или другой MCP-сервер. Подключение будет
            общим для агентов, работающих через этот BB.
          </p>
          <button
            type="button"
            className={`${primary} mt-5`}
            disabled={disabled}
            onClick={startNew}
          >
            Добавить MCP-сервер
          </button>
        </section>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {servers.map((server) => (
          <article
            key={server.id}
            className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="break-words font-semibold">{server.name}</h2>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  {server.id} ·{" "}
                  {server.transport === "http" ? "HTTP" : "stdio на сервере BB"}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-1 text-xs ${server.enabled ? "bg-success/10 text-success-foreground" : "bg-muted text-muted-foreground"}`}
              >
                {server.enabled ? "Включён" : "Выключен"}
              </span>
            </div>
            <p className="break-all rounded-lg bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
              {server.transport === "http"
                ? server.url
                : [server.command, ...(server.args ?? [])].join(" ")}
            </p>
            {(server.hasToken || server.envKeys.length > 0) && (
              <p className="text-xs text-muted-foreground">
                {server.hasToken
                  ? "Bearer-токен сохранён"
                  : `Переменные: ${server.envKeys.join(", ")}`}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={button}
                disabled={disabled || !server.enabled}
                onClick={() => void inspect(server)}
              >
                {pending === server.id
                  ? "Подождите…"
                  : "Проверить и показать инструменты"}
              </button>
              <button
                type="button"
                className={button}
                disabled={disabled}
                onClick={() => startEdit(server)}
              >
                Настроить
              </button>
              <button
                type="button"
                className={button}
                disabled={disabled}
                onClick={() => void toggle(server)}
              >
                {server.enabled ? "Выключить" : "Включить"}
              </button>
              <button
                type="button"
                className={`${button} text-destructive-text`}
                disabled={disabled}
                onClick={() => setConfirmRemove(server.id)}
              >
                Удалить
              </button>
            </div>
            {confirmRemove === server.id && (
              <div className="space-y-3 rounded-lg border border-destructive/30 p-3">
                <p className="text-sm">
                  Удалить «{server.name}» вместе с сохранёнными настройками?
                  Агенты потеряют доступ к его инструментам.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={`${button} text-destructive-text`}
                    disabled={disabled}
                    onClick={() => void remove(server)}
                  >
                    Да, удалить
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={disabled}
                    onClick={() => setConfirmRemove(null)}
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>

      {tools && selectedServer && (
        <section
          className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-5"
          aria-label="Инструменты MCP-сервера"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                Инструменты · {selectedServer.name}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Всего: {tools.items.length}. Агенты получают эти описания и
                схемы через поиск хаба.
              </p>
            </div>
            <button
              type="button"
              className={button}
              onClick={() => setTools(null)}
            >
              Скрыть
            </button>
          </div>
          {tools.items.length > 0 && (
            <input
              aria-label="Поиск инструментов"
              value={toolQuery}
              onChange={(event) => setToolQuery(event.target.value)}
              placeholder="Название или описание…"
              className={control}
            />
          )}
          {filteredTools.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {tools.items.length === 0
                ? "Сервер не предоставил инструментов."
                : "Инструменты не найдены."}
            </p>
          )}
          <div className="space-y-3">
            {filteredTools.map((tool) => (
              <details
                key={tool.name}
                className="rounded-lg border border-border p-3"
              >
                <summary className="cursor-pointer break-all text-sm font-medium">
                  {tool.name}
                </summary>
                <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {tool.description || "Без описания"}
                </p>
                <p className="mt-3 text-xs font-medium">Схема аргументов</p>
                <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted/40 p-3 text-xs">
                  {JSON.stringify(tool.inputSchema, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "hub",
    title: "MCP Hub",
    icon: "Plug",
    path: "hub",
    component: McpHub,
  });
});
