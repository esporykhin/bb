import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type WorkspaceSummary = {
  id: string;
  name: string;
  description: string;
  projectIds: string[];
};

type Workspace = WorkspaceSummary & { instructions: string };
type ProjectRef = { id: string; name: string };

const field =
  "w-full rounded-md border border-border bg-transparent px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const muted = "text-sm text-muted-foreground";

function WorkspacesPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();

  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [full, setFull] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createId, setCreateId] = useState("");
  const [createName, setCreateName] = useState("");

  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftInstructions, setDraftInstructions] = useState("");

  const report = useCallback(
    (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    [],
  );

  const refetch = useCallback(() => {
    Promise.all([rpc.call("list"), rpc.call("projects")]).then(
      ([listResult, projectsResult]) => {
        setWorkspaces(listResult.workspaces);
        setProjects(projectsResult.projects);
        setError(null);
      },
      report,
    );
  }, [rpc, report]);

  useEffect(() => {
    if (connection === "connected") refetch();
  }, [connection, refetch]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("workspaces-changed", refetch);

  useEffect(() => {
    if (selectedId === null) {
      setFull(null);
      return;
    }
    let cancelled = false;
    rpc.call("get", { id: selectedId }).then(
      (workspace) => {
        if (cancelled) return;
        setFull(workspace);
        if (workspace !== null) {
          setDraftName(workspace.name);
          setDraftDescription(workspace.description);
          setDraftInstructions(workspace.instructions);
        }
      },
      (cause) => {
        if (!cancelled) report(cause);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedId, rpc, report]);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = createId.trim();
    const name = createName.trim();
    if (busy || id === "" || name === "") return;
    setBusy(true);
    setError(null);
    try {
      const workspace = await rpc.call("create", { id, name });
      setCreateId("");
      setCreateName("");
      setCreateOpen(false);
      setSelectedId(workspace.id);
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || full === null) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("update", {
        id: full.id,
        name: draftName.trim(),
        description: draftDescription,
        instructions: draftInstructions,
      });
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }

  async function removeWorkspace(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("remove", { id });
      if (selectedId === id) setSelectedId(null);
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }

  async function toggleProject(projectId: string, checked: boolean) {
    if (busy || full === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = checked
        ? [...full.projectIds, projectId]
        : full.projectIds.filter((id) => id !== projectId);
      await rpc.call("setProjects", { id: full.id, projectIds: next });
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Рабочие области</h1>
          <p className={muted}>Группы проектов с общим контекстом (серверы, доступы, договорённости)</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setCreateOpen((open) => !open)} disabled={busy}>
          {createOpen ? "Скрыть" : "+ Новая область"}
        </Button>
      </header>

      {createOpen && (
        <form onSubmit={createWorkspace} className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div>
            <h2 className="font-semibold">Новая область</h2>
            <p className={muted}>id — для CLI (латиница, цифры, дефисы), например mpstats</p>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            id
            <input
              required
              value={createId}
              onChange={(event) => setCreateId(event.target.value)}
              className={field}
              placeholder="mpstats"
              pattern="[a-z0-9][a-z0-9-]*"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Название
            <input
              required
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              className={field}
              placeholder="MPSTATS (работа)"
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || createId.trim() === "" || createName.trim() === ""}>
              Создать
            </Button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-text">
          {error}
        </p>
      )}

      {workspaces === null && !error ? <p className={muted}>Загрузка…</p> : null}
      {workspaces !== null && workspaces.length === 0 && (
        <p className={muted}>Областей пока нет. Создайте первую и добавьте в неё проекты.</p>
      )}

      <div className="flex flex-col gap-3">
        {workspaces?.map((workspace) => (
          <Card key={workspace.id} className={selectedId === workspace.id ? "ring-1 ring-ring" : ""}>
            <CardHeader className="p-4">
              <div className="flex items-start justify-between gap-3">
                <button type="button" className="text-left" onClick={() => setSelectedId(workspace.id)}>
                  <CardTitle>{workspace.name}</CardTitle>
                  <CardDescription className="mt-1">
                    {workspace.id} · {workspace.projectIds.length} проект(ов)
                  </CardDescription>
                </button>
                <Button type="button" variant="ghost" size="sm" onClick={() => removeWorkspace(workspace.id)} disabled={busy}>
                  Удалить
                </Button>
              </div>
            </CardHeader>
            {selectedId === workspace.id && full !== null && (
              <CardContent className="space-y-4 p-4 pt-0">
                <form onSubmit={saveWorkspace} className="space-y-3">
                  <label className="flex flex-col gap-1 text-sm">
                    Название
                    <input value={draftName} onChange={(event) => setDraftName(event.target.value)} className={field} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    Описание (одна строка)
                    <input
                      value={draftDescription}
                      onChange={(event) => setDraftDescription(event.target.value)}
                      className={field}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    Общий контекст (серверы, доступы, договорённости) — вшивается только в проекты этой области
                    <textarea
                      value={draftInstructions}
                      onChange={(event) => setDraftInstructions(event.target.value)}
                      rows={6}
                      className={`${field} py-2`}
                    />
                  </label>
                  <Button type="submit" disabled={busy || draftName.trim() === ""}>
                    Сохранить
                  </Button>
                </form>

                <div>
                  <h3 className="text-sm font-semibold">Проекты области</h3>
                  <p className={muted}>Отметьте проекты — их агенты получат контекст этой области.</p>
                  <ul className="mt-2 flex flex-col gap-1">
                    {projects.map((project) => (
                      <li key={project.id}>
                        <label className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted">
                          <input
                            type="checkbox"
                            checked={full.projectIds.includes(project.id)}
                            disabled={busy}
                            onChange={(event) => toggleProject(project.id, event.target.checked)}
                          />
                          <span className="truncate">{project.name}</span>
                          <span className="truncate text-xs text-muted-foreground">{project.id}</span>
                        </label>
                      </li>
                    ))}
                    {projects.length === 0 && <li className={muted}>Проекты не найдены.</li>}
                  </ul>
                </div>
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "workspaces",
    title: "Workspaces",
    icon: "Layers",
    path: "workspaces",
    component: WorkspacesPanel,
  });
});
