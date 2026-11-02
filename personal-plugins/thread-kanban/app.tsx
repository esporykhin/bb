import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { definePluginApp, experimental_useSidebarThreads, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';

const columns = [['backlog', 'Бэклог'], ['in_progress', 'В работе'], ['review', 'На проверке'], ['blocked', 'Заблокировано'], ['done', 'Завершено']] as const;
type Column = typeof columns[number][0];
type Profile = { id: string; name: string };
const control = 'rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-50';
const action = 'inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
const columnTone: Record<Column, { panel: string; dot: string; badge: string }> = {
  backlog: { panel: 'border-t-primary', dot: 'bg-primary', badge: 'bg-muted text-foreground' },
  in_progress: { panel: 'border-t-attention', dot: 'bg-attention', badge: 'bg-surface-attention text-warning-text' },
  review: { panel: 'border-t-primary/60', dot: 'bg-primary/60', badge: 'bg-muted text-foreground' },
  blocked: { panel: 'border-t-destructive', dot: 'bg-destructive', badge: 'bg-destructive/10 text-destructive-text' },
  done: { panel: 'border-t-success', dot: 'bg-success', badge: 'bg-success/10 text-success-foreground' },
};

function Board() {
  const rpc = useRpc<typeof rpcContract>();
  const formId = useId();
  const { threads, projects } = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const [cards, setCards] = useState<Record<string, Column>>({});
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [project, setProject] = useState('');
  const [agent, setAgent] = useState('');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState({ projectId: '', assignee: '', title: '', description: '' });
  const [created, setCreated] = useState<{ threadId: string; title: string } | null>(null);
  const request = useRef(0);
  const busy = useRef(false);
  const createRequestId = useRef<string | null>(null);
  function updateDraft(next: typeof draft) {
    createRequestId.current = null;
    setDraft(next);
  }
  const refresh = useCallback(() => {
    const id = ++request.current;
    Promise.all([rpc.call('board'), rpc.call('profiles_list')]).then(([board, catalog]) => {
      if (id !== request.current) return;
      setCards(Object.fromEntries(board.cards.map(c => [c.threadId, c.column])));
      setAssignments(Object.fromEntries(board.assignments.map(item => [item.threadId, item.assignee])));
      setProfiles(catalog.profiles);
      setLoaded(true);
      setLoadError('');
    }, error => { if (id === request.current) setLoadError(String(error)); });
  }, [rpc]);
  useEffect(() => {
    if (connection === 'connected') refresh();
    return () => { request.current++; };
  }, [connection, refresh]);
  useEffect(() => { refresh(); }, [refresh]);
  useRealtime('board-changed', refresh);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  async function mutate(threadId: string, operation: () => Promise<unknown>) {
    if (busy.current) return;
    busy.current = true;
    setPending(threadId);
    setActionError('');
    try { await operation(); refresh(); }
    catch (error) { setActionError(String(error)); }
    finally { busy.current = false; setPending(null); }
  }
  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !draft.projectId || !draft.assignee || !draft.title.trim() || !draft.description.trim()) return;
    await mutate('create', async () => {
      createRequestId.current ??= crypto.randomUUID();
      const result = await rpc.call('createTask', { ...draft, requestId: createRequestId.current, title: draft.title.trim(), description: draft.description.trim() });
      createRequestId.current = null;
      setCreated({ threadId: result.threadId, title: draft.title.trim() });
      setProject(draft.projectId);
      setAgent('');
      setQuery('');
      setDraft(previous => ({ ...previous, title: '', description: '' }));
      setFormOpen(false);
    });
  }
  function toggleForm() {
    if (!formOpen) {
      setDraft(previous => ({ ...previous, projectId: previous.projectId || project || projects[0]?.id || '', assignee: previous.assignee || profiles[0]?.id || '' }));
      setCreated(null);
      setActionError('');
    }
    setFormOpen(!formOpen);
  }
  const roleName = (id: string) => profiles.find(profile => profile.id === id)?.name ?? id;
  const roleIds = Array.from(new Set([...profiles.map(profile => profile.id), ...Object.values(assignments)])).sort((a, b) => roleName(a).localeCompare(roleName(b)));
  const visible = threads.filter(thread => !thread.isArchived && !thread.isHidden && (!project || thread.projectId === project) && (!agent || (agent === '__unassigned' ? !assignments[thread.id] : assignments[thread.id] === agent)) && thread.displayTitle.toLowerCase().includes(query.toLowerCase()));

  const inFlightCount = visible.filter(thread => ['active', 'starting'].includes(thread.status)).length;
  const completedCount = visible.filter(thread => cards[thread.id] === 'done').length;
  return <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto bg-background p-4 md:p-5">
    <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Рабочее пространство</p>
        <h1 className="text-xl font-semibold tracking-tight">Задачи команды</h1>
        <p className="text-sm text-muted-foreground">Задачи по тредам и их текущий ход</p>
      </div>
      <div className="flex gap-2 pb-0.5 text-xs">
        <span className="rounded-full border border-border bg-card px-2.5 py-1.5 text-muted-foreground"><span className="font-semibold text-foreground">{inFlightCount}</span> в работе</span>
        <span className="rounded-full border border-border bg-card px-2.5 py-1.5 text-muted-foreground"><span className="font-semibold text-foreground">{completedCount}</span> завершено</span>
      </div>
    </header>
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2 shadow-sm">
      <button type="button" className={`${action} mr-1`} aria-expanded={formOpen} aria-controls={formId} onClick={toggleForm} disabled={!loaded || pending !== null}>{formOpen ? 'Скрыть форму' : '+ Новая задача'}</button>
      <input aria-label="Поиск тредов" placeholder="Найти задачу…" value={query} onChange={event => setQuery(event.target.value)} className={`${control} min-w-44 flex-1 sm:flex-none`} />
      <select aria-label="Проект" value={project} onChange={event => setProject(event.target.value)} className={`${control} min-w-36`}><option value="">Все проекты</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select aria-label="Фильтр по агенту" value={agent} onChange={event => setAgent(event.target.value)} className={`${control} min-w-36`}><option value="">Все агенты</option><option value="__unassigned">Без ответственного</option>{roleIds.map(id => <option key={id} value={id}>{roleName(id)}</option>)}</select>
      <button type="button" onClick={refresh} className="rounded-md px-2 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground">Обновить</button>
      <span className="ml-auto whitespace-nowrap rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground">{visible.length} задач</span>
    </div>
    {loaded && profiles.length === 0 && <p role="status" className="flex items-start gap-3 rounded-xl border border-attention/30 bg-surface-attention p-4 text-sm text-foreground">Профили агентов ещё не загружены. Можно просматривать существующие задачи и менять их статусы.</p>}
    {formOpen && <form id={formId} onSubmit={createTask} className="space-y-4 rounded-xl border border-primary/20 border-l-4 border-l-primary bg-card p-4 shadow-sm sm:p-5">
      <div><h2 className="font-semibold tracking-tight">Поставить задачу агенту</h2><p className="mt-1 text-xs text-muted-foreground">Запустим новый тред с инструкциями выбранного профиля.</p></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">Проект<select required disabled={pending !== null} value={draft.projectId} onChange={event => updateDraft({ ...draft, projectId: event.target.value })} className={control}><option value="">Выбрать проект</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="flex flex-col gap-1 text-sm">Агент<select required disabled={pending !== null || profiles.length === 0} value={draft.assignee} onChange={event => updateDraft({ ...draft, assignee: event.target.value })} className={control}><option value="">Выбрать агента</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      </div>
      <label className="flex flex-col gap-1 text-sm">Название<input required maxLength={200} disabled={pending !== null} value={draft.title} onChange={event => updateDraft({ ...draft, title: event.target.value })} placeholder="Что нужно сделать" className={control} /></label>
      <label className="flex flex-col gap-1 text-sm">Описание<textarea required maxLength={20000} rows={4} disabled={pending !== null} value={draft.description} onChange={event => updateDraft({ ...draft, description: event.target.value })} placeholder="Ожидаемый результат, контекст и ограничения" className={control} /></label>
      <div className="flex flex-wrap items-center gap-3"><button type="submit" className={action} disabled={pending !== null || !draft.projectId || !draft.assignee || !draft.title.trim() || !draft.description.trim()}>{pending === 'create' ? 'Запуск…' : 'Создать и запустить'}</button><p className="max-w-xl text-xs leading-relaxed text-muted-foreground">Применяются инструкции профиля. Провайдер и модель берутся из настроек проекта.</p></div>
    </form>}
    <p className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Ответственный показывает, кому поручена карточка. Смена метки не меняет текущую сессию; для другой роли создайте новую задачу.</p>
    {created && <p role="status" className="flex items-center justify-between gap-3 rounded-xl border border-success/30 bg-success/10 p-3 text-sm">Задача «{created.title}» создана. <button type="button" className="font-medium underline" onClick={() => navigate.toThread(created.threadId)}>Открыть тред</button></p>}
    {(loadError || actionError) && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-text">{actionError || loadError}</p>}
    {!loaded && !loadError ? <p role="status">Загрузка доски…</p> : loaded ? <div className="flex min-h-64 flex-1 gap-3 overflow-x-auto pb-3">
      {columns.map(([id, label]) => {
        const items = visible.filter(thread => (cards[thread.id] ?? (thread.status === 'active' ? 'in_progress' : thread.status === 'error' ? 'blocked' : 'backlog')) === id);
        return <section key={id} aria-label={label} className={`flex w-72 min-w-64 flex-1 flex-col overflow-hidden rounded-xl border border-t-2 border-border bg-muted/20 shadow-sm ${columnTone[id].panel}`} onDragOver={event => event.preventDefault()} onDrop={event => {
          event.preventDefault();
          const threadId = event.dataTransfer.getData('text/x-bb-thread');
          if (visible.some(thread => thread.id === threadId)) void mutate(threadId, () => rpc.call('move', { threadId, column: id }));
        }}>
          <h2 className="flex items-center justify-between border-b border-border bg-card/70 px-3 py-3 text-sm font-semibold"><span className="flex items-center gap-2"><span aria-hidden="true" className={`size-2 rounded-full ${columnTone[id].dot}`} />{label}</span><span className={`min-w-6 rounded-full px-2 py-0.5 text-center text-xs font-semibold ${columnTone[id].badge}`}>{items.length}</span></h2>
          <div className="flex-1 space-y-3 overflow-y-auto p-2.5">{items.length === 0 && <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">Нет задач</p>}{items.map(thread => <article key={thread.id} draggable={pending === null} onDragStart={event => event.dataTransfer.setData('text/x-bb-thread', thread.id)} className="group space-y-2.5 rounded-xl border border-border/80 bg-card p-3.5 shadow-sm transition duration-150 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
            <button type="button" className="w-full text-left text-sm font-semibold leading-snug tracking-tight hover:text-primary" onClick={() => navigate.toThread(thread.id)}>{thread.displayTitle || 'Без названия'}</button>
            <p className="truncate text-xs text-muted-foreground">{projects.find(item => item.id === thread.projectId)?.name ?? 'Личный проект'}</p>
            <div className="flex flex-wrap items-center gap-1.5"><span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{thread.status}</span><span className="max-w-full truncate rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-foreground">{assignments[thread.id] ? roleName(assignments[thread.id]) : 'Без ответственного'}</span></div>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Ответственный<select title="Меняет ответственного на доске. Для выполнения другой ролью создайте новую задачу." aria-label={`Ответственный: ${thread.displayTitle}`} disabled={pending !== null || profiles.length === 0} value={assignments[thread.id] ?? ''} onChange={event => void mutate(thread.id, () => rpc.call('assign', { threadId: thread.id, assignee: event.target.value }))} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="" disabled>Не назначен</option>{assignments[thread.id] && !profiles.some(profile => profile.id === assignments[thread.id]) && <option value={assignments[thread.id]}>{roleName(assignments[thread.id])}</option>}{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Статус<select aria-label={`Статус: ${thread.displayTitle}`} disabled={pending !== null} value={id} onChange={event => {
              const next = event.target.value;
              const selected = columns.find(([value]) => value === next);
              if (selected) void mutate(thread.id, () => rpc.call('move', { threadId: thread.id, column: selected[0] }));
            }} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{columns.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
          </article>)}</div>
        </section>;
      })}
    </div> : null}
  </div>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: 'board', title: 'Thread Kanban', icon: 'thread-kanban/board', path: 'board', component: Board });
  app.slots.experimental_tab({ id: 'kanban', title: 'Kanban', icon: 'thread-kanban/board', context: { kind: 'thread' }, availability: 'fixed', component: Board });
});
