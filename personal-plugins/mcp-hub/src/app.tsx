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
type Variable = { id: string; key: string; value: string };
type Argument = { id: string; value: string };
type Draft = {
  id: string;
  name: string;
  enabled: boolean;
  transport: "http" | "stdio";
  url: string;
  bearerToken: string;
  command: string;
  args: Argument[];
  env: Variable[];
  kaitenAddress: string;
  kaitenToken: string;
  originalKaitenAddress: string;
  kaitenAddressEnv: Record<string, string>;
};
const kaitenKeys = new Set([
  "KAITEN_SUBDOMAIN",
  "KAITEN_BASE_URL",
  "KAITEN_DOMAIN",
  "KAITEN_TOKEN",
]);
const variable = (key = "", value = ""): Variable => ({
  id: crypto.randomUUID(),
  key,
  value,
});
const argument = (value = ""): Argument => ({ id: crypto.randomUUID(), value });
const emptyDraft = (): Draft => ({
  id: "",
  name: "",
  enabled: false,
  transport: "http",
  url: "",
  bearerToken: "",
  command: "",
  args: [],
  env: [],
  kaitenAddress: "",
  kaitenToken: "",
  originalKaitenAddress: "",
  kaitenAddressEnv: {},
});
const isKaiten = (draft: Draft) =>
  draft.id.trim() === "kaiten" && draft.transport === "stdio";

function fromConfiguration(server: ServerInput): Draft {
  const kaiten = server.id === "kaiten" && server.transport === "stdio";
  const env = server.env ?? {};
  return {
    ...emptyDraft(),
    ...server,
    url: server.url ?? "",
    bearerToken: server.bearerToken ?? "",
    command: server.command ?? "",
    args: (server.args ?? []).map(argument),
    env: Object.entries(env)
      .filter(([key]) => !kaiten || !kaitenKeys.has(key))
      .map(([key, value]) => variable(key, value)),
    kaitenAddress: kaiten
      ? env.KAITEN_BASE_URL || env.KAITEN_SUBDOMAIN || env.KAITEN_DOMAIN || ""
      : "",
    kaitenToken: kaiten ? (env.KAITEN_TOKEN ?? "") : "",
    originalKaitenAddress: kaiten
      ? env.KAITEN_BASE_URL || env.KAITEN_SUBDOMAIN || env.KAITEN_DOMAIN || ""
      : "",
    kaitenAddressEnv: kaiten
      ? Object.fromEntries(
          Object.entries(env).filter(
            ([key]) =>
              key === "KAITEN_BASE_URL" ||
              key === "KAITEN_SUBDOMAIN" ||
              key === "KAITEN_DOMAIN",
          ),
        )
      : {},
  };
}

function serverInput(draft: Draft): ServerInput {
  const base = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    enabled: draft.enabled,
    transport: draft.transport,
  };
  if (draft.transport === "http")
    return { ...base, url: draft.url.trim(), bearerToken: draft.bearerToken };
  const env: Record<string, string> = {};
  for (const row of draft.env) {
    const key = row.key.trim();
    if (!key && !row.value) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error(
        "Укажите имя каждой переменной: латинские буквы, цифры и подчёркивание.",
      );
    if (Object.hasOwn(env, key))
      throw new Error("Имена переменных не должны повторяться.");
    if (isKaiten(draft) && kaitenKeys.has(key))
      throw new Error(
        "Адрес и API-токен Kaiten задаются в отдельных полях выше.",
      );
    env[key] = row.value;
  }
  if (isKaiten(draft)) {
    const address = draft.kaitenAddress.trim();
    const validOriginalSubdomain = ["KAITEN_SUBDOMAIN", "KAITEN_DOMAIN"].every(
      (key) => {
        const value = draft.kaitenAddressEnv[key];
        return !value || /^[A-Za-z0-9_-]+$/.test(value);
      },
    );
    if (
      draft.kaitenAddress === draft.originalKaitenAddress &&
      validOriginalSubdomain
    )
      Object.assign(env, draft.kaitenAddressEnv);
    else if (address) {
      if (/^[A-Za-z0-9_-]+$/.test(address)) env.KAITEN_SUBDOMAIN = address;
      else {
        let url: URL;
        try {
          url = new URL(
            address.includes("://") ? address : `https://${address}`,
          );
        } catch {
          throw new Error("Укажите адрес Kaiten, например company.kaiten.ru.");
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error(
            "Адрес Kaiten должен быть HTTP(S)-адресом без логина, пароля и параметров.",
          );
        env.KAITEN_BASE_URL = url.href.replace(/\/$/, "");
      }
    }
    if (draft.kaitenToken) env.KAITEN_TOKEN = draft.kaitenToken;
  }
  return {
    ...base,
    command: draft.command.trim(),
    args: draft.args.map((row) => row.value),
    env,
  };
}

function SecretField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const fieldId = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={fieldId} className="text-sm">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={fieldId}
          type={visible ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={control}
        />
        <button
          type="button"
          className={button}
          disabled={disabled}
          aria-label={`${visible ? "Скрыть" : "Показать"} ${label}`}
          onClick={() => setVisible(!visible)}
        >
          {visible ? "Скрыть" : "Показать"}
        </button>
      </div>
    </div>
  );
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
  const [dirty, setDirty] = useState(false);
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
  const originalConfiguration = useRef<ServerInput | null>(null);

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
    if (connection === "connected")
      queueMicrotask(() => {
        if (mounted.current) void refresh();
      });
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
  function update(next: Draft) {
    setDraft(next);
    setDirty(true);
  }
  function closeForm() {
    originalConfiguration.current = null;
    setFormOpen(false);
    setDraft(emptyDraft());
    setEditing(null);
    setDirty(false);
  }
  function startNew() {
    if (dirty) {
      setActionError(
        "Сохраните или отмените изменения текущего сервера перед переключением.",
      );
      return;
    }
    originalConfiguration.current = null;
    setDraft(emptyDraft());
    setEditing(null);
    setFormOpen(true);
    setDirty(false);
    setActionError("");
    setNotice("");
  }
  async function startEdit(server: ServerSummary) {
    if (dirty) {
      setActionError(
        "Сохраните или отмените изменения текущего сервера перед переключением.",
      );
      return;
    }
    await mutate(
      server.id,
      async () => {
        closeForm();
        const result = await rpc.call("configuration", { id: server.id });
        if (!mounted.current) return;
        const nextDraft = fromConfiguration(result.server);
        originalConfiguration.current = result.server;
        setDraft(nextDraft);
        setEditing(server.id);
        setFormOpen(true);
        setDirty(false);
      },
      "Не удалось загрузить настройки. Обновите список и повторите.",
    );
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let input: ServerInput;
    try {
      input = serverInput(draft);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Проверьте поля подключения.",
      );
      return;
    }
    await mutate(
      "save",
      async () => {
        const patch = { ...input };
        const previous = originalConfiguration.current;
        if (previous && previous.transport === input.transport) {
          if (input.bearerToken === previous.bearerToken)
            delete patch.bearerToken;
          const nextEnv = input.env ?? {};
          const previousEnv = previous.env ?? {};
          if (
            Object.keys(nextEnv).length === Object.keys(previousEnv).length &&
            Object.entries(nextEnv).every(
              ([key, value]) => previousEnv[key] === value,
            )
          )
            delete patch.env;
        }
        await rpc.call("upsert", patch);
        let persisted = input;
        let readBackFailed = false;
        try {
          persisted = (await rpc.call("configuration", { id: input.id }))
            .server;
        } catch {
          readBackFailed = true;
        }
        if (!mounted.current) return;
        const nextDraft = fromConfiguration(persisted);
        originalConfiguration.current = persisted;
        setDraft(nextDraft);
        setEditing(input.id);
        setDirty(false);
        setTools(null);
        setNotice(
          readBackFailed
            ? "Настройки сохранены, но не удалось обновить форму. Закройте и откройте настройки, чтобы перечитать сохранённые значения."
            : "Настройки сохранены. Вы можете проверить доступ или продолжить редактирование.",
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
        if (editing === server.id)
          setDraft((previous) => ({ ...previous, enabled: !server.enabled }));
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
        if (editing === server.id) closeForm();
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
          `Каталог загружен. Инструментов: ${result.tools.length}. Доступ к данным сервиса этим не проверяется.`,
        );
      },
      "Не удалось получить инструменты. Проверьте доступность MCP-сервера. Для stdio проверьте команду на машине сервера BB.",
    );
  }
  async function checkKaiten(server: ServerSummary) {
    await mutate(
      server.id,
      async () => {
        const result = await rpc.call("call", {
          serverId: server.id,
          name: "kaiten_list_spaces",
          arguments: { compact: true },
        });
        if (result.isError) throw new Error("Access check failed");
        if (mounted.current)
          setNotice("Доступ к Kaiten подтверждён: список пространств получен.");
      },
      "Доступ к Kaiten не подтверждён. Проверьте сохранённые адрес и API-токен, затем повторите.",
    );
  }
  const disabled = pending !== null;
  const selectedServer = servers.find(
    (server) => server.id === tools?.serverId,
  );
  const editedServer = servers.find((server) => server.id === editing);
  const filteredTools =
    tools?.items.filter((tool) =>
      `${tool.name} ${tool.description}`
        .toLocaleLowerCase()
        .includes(toolQuery.toLocaleLowerCase()),
    ) ?? [];
  const kaiten = isKaiten(draft);
  const launchFields = (
    <div className="space-y-4">
      <label className="block space-y-1 text-sm">
        <span>Исполняемый файл</span>
        <input
          aria-label="Исполняемый файл"
          required
          value={draft.command}
          onChange={(event) =>
            update({ ...draft, command: event.target.value })
          }
          placeholder="/opt/homebrew/bin/npx"
          className={control}
        />
      </label>
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Аргументы запуска</h3>
        {draft.args.map((row, index) => (
          <div key={row.id} className="flex items-center gap-2">
            <input
              aria-label={`Аргумент ${index + 1}`}
              value={row.value}
              onChange={(event) =>
                update({
                  ...draft,
                  args: draft.args.map((item) =>
                    item.id === row.id
                      ? { ...item, value: event.target.value }
                      : item,
                  ),
                })
              }
              className={control}
            />
            <button
              type="button"
              className={button}
              aria-label={`Удалить аргумент ${index + 1}`}
              onClick={() =>
                update({
                  ...draft,
                  args: draft.args.filter((item) => item.id !== row.id),
                })
              }
            >
              Удалить
            </button>
          </div>
        ))}
        <button
          type="button"
          className={button}
          onClick={() =>
            update({ ...draft, args: [...draft.args, argument()] })
          }
        >
          + Добавить аргумент
        </button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Команда запускается на машине сервера BB. Здесь используются её
        программы и пути.
      </p>
    </div>
  );

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
      <p className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
        Подключите сервис один раз и управляйте его настройками здесь.
        Поддерживаются инструменты MCP; OAuth, ресурсы и промпты пока
        недоступны.
      </p>
      {loadError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive-text"
        >
          Не удалось загрузить серверы. Проверьте соединение с BB и нажмите
          «Обновить».
        </p>
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
              {editing ? `Настройки · ${draft.name}` : "Новый MCP-сервер"}
            </h2>
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={closeForm}
            >
              {dirty ? "Отменить изменения" : "Закрыть настройки"}
            </button>
          </div>
          <fieldset disabled={disabled} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span>Идентификатор</span>
                <input
                  aria-label="Идентификатор"
                  required
                  pattern="[a-z0-9][a-z0-9_-]*"
                  maxLength={64}
                  readOnly={editing !== null}
                  value={draft.id}
                  onChange={(event) =>
                    update({ ...draft, id: event.target.value })
                  }
                  placeholder="mpstats"
                  className={control}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span>Название</span>
                <input
                  required
                  maxLength={120}
                  value={draft.name}
                  onChange={(event) =>
                    update({ ...draft, name: event.target.value })
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
                    update({ ...draft, transport: next });
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
                    aria-label="URL Streamable HTTP"
                    required
                    type="url"
                    value={draft.url}
                    onChange={(event) =>
                      update({ ...draft, url: event.target.value })
                    }
                    placeholder="https://example.com/mcp"
                    className={control}
                  />
                </label>
                <SecretField
                  key={`bearer-${editing ?? "new"}`}
                  label="Bearer-токен"
                  value={draft.bearerToken}
                  onChange={(value) => update({ ...draft, bearerToken: value })}
                />
                <p className="text-xs text-muted-foreground">
                  Чтобы удалить токен, очистите поле и сохраните настройки.
                </p>
              </>
            ) : (
              <>
                {kaiten && (
                  <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
                    <h3 className="font-medium">Подключение к Kaiten</h3>
                    <label className="block space-y-1 text-sm">
                      <span>Адрес Kaiten</span>
                      <input
                        aria-label="Адрес Kaiten"
                        value={draft.kaitenAddress}
                        onChange={(event) =>
                          update({
                            ...draft,
                            kaitenAddress: event.target.value,
                          })
                        }
                        placeholder="company.kaiten.ru"
                        className={control}
                      />
                      <span className="block text-xs text-muted-foreground">
                        Можно ввести company, company.kaiten.ru или полный адрес
                        https://company.kaiten.ru.
                      </span>
                    </label>
                    <SecretField
                      key={`kaiten-${editing ?? "new"}`}
                      label="API-токен Kaiten"
                      value={draft.kaitenToken}
                      onChange={(value) =>
                        update({ ...draft, kaitenToken: value })
                      }
                    />
                  </div>
                )}
                {editing && kaiten ? (
                  <details className="rounded-lg border border-border p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Дополнительные настройки запуска
                    </summary>
                    <div className="mt-4">{launchFields}</div>
                  </details>
                ) : (
                  launchFields
                )}
                <section
                  className="space-y-3"
                  aria-label="Дополнительные переменные"
                >
                  <div>
                    <h3 className="text-sm font-medium">
                      {kaiten
                        ? "Дополнительные параметры"
                        : "Переменные окружения"}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Добавьте имя и значение. Удаление строки удалит
                      сохранённую переменную после сохранения.
                    </p>
                  </div>
                  {draft.env.map((row, index) => (
                    <div
                      key={row.id}
                      className="grid items-end gap-2 rounded-lg border border-border p-3 sm:grid-cols-2"
                    >
                      <label className="space-y-1 text-sm">
                        <span>Имя переменной</span>
                        <input
                          aria-label={`Имя переменной ${index + 1}`}
                          value={row.key}
                          onChange={(event) =>
                            update({
                              ...draft,
                              env: draft.env.map((item) =>
                                item.id === row.id
                                  ? { ...item, key: event.target.value }
                                  : item,
                              ),
                            })
                          }
                          placeholder="API_URL"
                          className={control}
                        />
                      </label>
                      {/TOKEN|SECRET|PASSWORD|API.?KEY|AUTHORIZATION/i.test(
                        row.key,
                      ) ? (
                        <SecretField
                          label={`Значение переменной ${row.key || index + 1}`}
                          value={row.value}
                          onChange={(value) =>
                            update({
                              ...draft,
                              env: draft.env.map((item) =>
                                item.id === row.id ? { ...item, value } : item,
                              ),
                            })
                          }
                        />
                      ) : (
                        <label className="space-y-1 text-sm">
                          <span>Значение</span>
                          <input
                            aria-label={`Значение переменной ${row.key || index + 1}`}
                            value={row.value}
                            onChange={(event) =>
                              update({
                                ...draft,
                                env: draft.env.map((item) =>
                                  item.id === row.id
                                    ? { ...item, value: event.target.value }
                                    : item,
                                ),
                              })
                            }
                            className={control}
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        className={`${button} justify-self-start text-destructive-text sm:col-span-2`}
                        aria-label={`Удалить переменную ${row.key || index + 1}`}
                        onClick={() =>
                          update({
                            ...draft,
                            env: draft.env.filter((item) => item.id !== row.id),
                          })
                        }
                      >
                        Удалить переменную
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className={button}
                    onClick={() =>
                      update({ ...draft, env: [...draft.env, variable()] })
                    }
                  >
                    + Добавить переменную
                  </button>
                </section>
              </>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) =>
                  update({ ...draft, enabled: event.target.checked })
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
              {pending === "save" ? "Сохранение…" : "Сохранить настройки"}
            </button>
            {kaiten && editedServer && (
              <button
                type="button"
                className={button}
                disabled={disabled || dirty || !editedServer.enabled}
                onClick={() => void checkKaiten(editedServer)}
              >
                Проверить доступ к Kaiten
              </button>
            )}
            <p className="text-xs text-muted-foreground">
              {dirty
                ? "Есть несохранённые изменения. Сохраните их перед проверкой доступа."
                : "Настройки сохранены на сервере BB. Секреты можно показать кнопкой рядом с полем."}
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
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
            Добавьте MPSTATS, память или другой MCP-сервер. Подключение будет
            общим для агентов этого BB.
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
              {server.transport === "http" ? server.url : server.command}
            </p>
            {(server.hasToken || server.envKeys.length > 0) && (
              <p className="text-xs text-muted-foreground">
                {server.hasToken
                  ? "Bearer-токен сохранён"
                  : `Параметров подключения: ${server.envKeys.length}`}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={button}
                disabled={disabled}
                onClick={() => void startEdit(server)}
              >
                Настроить
              </button>
              <button
                type="button"
                className={button}
                disabled={
                  disabled ||
                  !server.enabled ||
                  (editing === server.id && dirty)
                }
                onClick={() => void inspect(server)}
              >
                Показать инструменты
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
                </p>
                <div className="flex gap-2">
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
                Всего: {tools.items.length}. Описания и схемы доступны агентам
                через поиск хаба.
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
