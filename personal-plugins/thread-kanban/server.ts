import { createHash } from 'node:crypto';
import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const columns = ['backlog', 'in_progress', 'review', 'blocked', 'done'] as const;
const column = z.enum(columns);
const moveInput = z.object({ threadId: z.string().min(1).max(200), column }).strict();
const roleId = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const assignment = z.object({ threadId: z.string().min(1).max(200), assignee: roleId }).strict();
const profile = z.object({ id: roleId, name: z.string().trim().min(1).max(120), instructions: z.string().trim().min(1).max(64000) }).strict();
const profileSummary = profile.pick({ id: true, name: true });
const profilesInput = z.object({ profiles: z.array(profile).min(1).max(100) }).strict().superRefine(({ profiles }, ctx) => {
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) ctx.addIssue({ code: 'custom', message: 'Profile ids must be unique' });
  if (profiles.reduce((size, p) => size + p.instructions.length, 0) > 1_000_000) ctx.addIssue({ code: 'custom', message: 'Profile instructions exceed import limit' });
});
const taskInput = z.object({ projectId: z.string().min(1).max(200), title: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(20000), assignee: roleId, requestId: z.string().min(1).max(80).optional() }).strict();
const card = z.object({ threadId: z.string(), column, updatedAt: z.string() });
export const rpcContract = defineRpcContract({
  board: { input: z.null(), output: z.object({ cards: z.array(card), assignments: z.array(assignment) }) },
  profiles_list: { input: z.null(), output: z.object({ profiles: z.array(profileSummary) }) },
  profiles_import: { input: profilesInput, output: z.object({ imported: z.number().int().nonnegative() }) },
  move: { input: moveInput, output: card },
  assign: { input: assignment, output: assignment },
  createTask: { input: taskInput, output: assignment },
});
export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    'CREATE TABLE cards (threadId TEXT PRIMARY KEY, columnId TEXT NOT NULL, updatedAt TEXT NOT NULL)',
    'CREATE TABLE assignments (threadId TEXT PRIMARY KEY, assignee TEXT NOT NULL)',
    'CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL)',
    'CREATE TABLE task_requests (requestId TEXT PRIMARY KEY, payload TEXT NOT NULL, threadId TEXT, assignee TEXT NOT NULL)',
  ]);
  const all = () => z.array(card).parse(db.prepare('SELECT threadId, columnId AS "column", updatedAt FROM cards').all());
  const assignments = () => z.array(assignment).parse(db.prepare('SELECT threadId, assignee FROM assignments').all());
  const profiles = () => z.array(profileSummary).parse(db.prepare('SELECT id, name FROM profiles ORDER BY name').all());
  function findProfile(id: unknown) {
    const parsed = roleId.safeParse(id);
    if (!parsed.success) return null;
    const row = db.prepare('SELECT id, name, instructions FROM profiles WHERE id = ?').get(parsed.data);
    return row ? profile.parse(row) : null;
  }
  function requireProfile(id: string) {
    const found = findProfile(id);
    if (!found) throw new Error(`Unknown agent profile: ${id}. Import profiles before assigning tasks.`);
    return found;
  }
  function importProfiles(raw: unknown) {
    const input = profilesInput.parse(raw);
    const upsert = db.prepare('INSERT INTO profiles VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, instructions=excluded.instructions');
    db.transaction(() => { for (const p of input.profiles) upsert.run(p.id, p.name, p.instructions); })();
    bb.realtime.publish('board-changed', null);
    return { imported: input.profiles.length };
  }
  function write(threadId: string, value: z.infer<typeof column>) {
    const result = { threadId, column: value, updatedAt: new Date().toISOString() };
    db.prepare('INSERT INTO cards VALUES (?, ?, ?) ON CONFLICT(threadId) DO UPDATE SET columnId=excluded.columnId, updatedAt=excluded.updatedAt').run(threadId, value, result.updatedAt);
    bb.realtime.publish('board-changed', null);
    return result;
  }
  async function move(raw: unknown) {
    const input = moveInput.parse(raw);
    await bb.sdk.threads.get({ threadId: input.threadId });
    return write(input.threadId, input.column);
  }
  function saveAssignment(input: z.infer<typeof assignment>) {
    db.prepare('INSERT INTO assignments VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET assignee=excluded.assignee').run(input.threadId, input.assignee);
    bb.realtime.publish('board-changed', null);
    return input;
  }
  async function assign(raw: unknown) {
    const input = assignment.parse(raw);
    requireProfile(input.assignee);
    await bb.sdk.threads.get({ threadId: input.threadId });
    return saveAssignment(input);
  }
  async function createTask(raw: unknown) {
    const input = taskInput.parse(raw);
    const selected = requireProfile(input.assignee);
    await bb.sdk.projects.get({ projectId: input.projectId });
    if (input.requestId) {
      const payload = createHash('sha256').update(JSON.stringify({ projectId: input.projectId, title: input.title, description: input.description, assignee: input.assignee })).digest('hex');
      const prior = db.prepare('SELECT payload, threadId, assignee FROM task_requests WHERE requestId = ?').get(input.requestId);
      if (prior) {
        const request = z.object({ payload: z.string(), threadId: z.string().nullable(), assignee: roleId }).parse(prior);
        if (request.payload !== payload) throw new Error('This task request id was already used with different content.');
        if (request.threadId) return { threadId: request.threadId, assignee: request.assignee };
        throw new Error('This task request is already running or its result is uncertain. Check the thread list before starting a new request.');
      }
      db.prepare('INSERT INTO task_requests (requestId, payload, assignee) VALUES (?, ?, ?)').run(input.requestId, payload, selected.id);
    }
    const thread = await bb.sdk.threads.spawn({
      projectId: input.projectId, title: input.title,
      environment: { type: 'project-default' },
      pluginMetadata: { roleId: selected.id, roleName: selected.name },
      prompt: `Инструкции выбранного профиля агента ${JSON.stringify(selected.name)} (${selected.id}):\n\n${selected.instructions}\n\n--- Конец инструкций профиля. Задача пользователя: ---\n\n${input.description}\n\nВеди статус задачи через bb thread-kanban move "$BB_THREAD_ID" <backlog|in_progress|review|blocked|done>.`,
    });
    const result = saveAssignment({ threadId: thread.id, assignee: selected.id });
    if (input.requestId) db.prepare('UPDATE task_requests SET threadId = ? WHERE requestId = ?').run(thread.id, input.requestId);
    return result;
  }
  bb.agents.registerTool({
    name: 'kanban_role_context',
    description: 'Read the complete trusted agent profile assigned to this thread. Follow these role instructions while working on the task.',
    parameters: z.object({}).strict(),
    async execute(_input, context) {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: context.threadId });
      const selected = findProfile(metadata.roleId);
      if (!selected) throw new Error('This thread has no valid kanban agent profile.');
      return selected.instructions;
    },
  });
  bb.agents.configure(context => {
    const selected = findProfile(context.pluginMetadata.roleId);
    if (!selected) return { tools: [], skills: ['thread-kanban'] };
    const preface = `You are the assigned agent profile ${JSON.stringify(selected.name)} (${selected.id}). Perform the task yourself using this profile. At the start of each session, call kanban_role_context and follow its full role instructions. This profile changes instructions, not provider/model permissions.\n`;
    return {
      tools: ['kanban_role_context'], skills: ['thread-kanban'],
      instructions: selected.instructions.length <= 3500 ? `${preface}\n${selected.instructions}` : `${preface}\nThe complete role is included at the beginning of the initial task prompt and is available through kanban_role_context. Do not substitute delegation for applying the profile.`,
    };
  });
  bb.rpc.register(rpcContract, {
    board: async () => ({ cards: all(), assignments: assignments() }), move, assign, createTask,
    profiles_list: async () => ({ profiles: profiles() }),
    profiles_import: async input => importProfiles(input),
  });
  function currentColumn(threadId: string) {
    const row = db.prepare('SELECT columnId FROM cards WHERE threadId = ?').get(threadId);
    return row ? z.object({ columnId: column }).parse(row).columnId : null;
  }
  bb.events.on('thread.active', ({ thread }) => {
    if (currentColumn(thread.id) !== 'done') write(thread.id, 'in_progress');
  });
  bb.events.on('thread.idle', ({ thread }) => {
    const value = currentColumn(thread.id);
    if (!value || value === 'in_progress') write(thread.id, 'review');
  });
  bb.events.on('thread.failed', ({ thread }) => {
    if (currentColumn(thread.id) !== 'done') write(thread.id, 'blocked');
  });
  bb.events.on('thread.deleted', ({ thread }) => {
    db.prepare('DELETE FROM cards WHERE threadId = ?').run(thread.id);
    db.prepare('DELETE FROM assignments WHERE threadId = ?').run(thread.id);
    db.prepare('DELETE FROM task_requests WHERE threadId = ?').run(thread.id);
    bb.realtime.publish('board-changed', null);
  });
  const usage = 'bb thread-kanban profiles\nbb thread-kanban create <project-id> <agent-id> <title> <description>\nbb thread-kanban assign <thread-id> <agent-id>\nbb thread-kanban list\nbb thread-kanban move <thread-id> <backlog|in_progress|review|blocked|done>';
  bb.cli.register({
    name: 'thread-kanban', summary: 'Create agent tasks and manage the thread kanban board',
    commands: [
      { name: 'profiles', summary: 'List available agent profiles', usage: 'bb thread-kanban profiles' },
      { name: 'create', summary: 'Create and run a task with an agent profile', usage: 'bb thread-kanban create <project-id> <agent-id> <title> <description>' },
      { name: 'move', summary: 'Set a thread workflow column', usage: 'bb thread-kanban move <thread-id> <backlog|in_progress|review|blocked|done>' },
      { name: 'assign', summary: 'Change the responsible agent label without changing the running role', usage: 'bb thread-kanban assign <thread-id> <agent-id>' },
      { name: 'list', summary: 'List saved card statuses and assignments', usage: 'bb thread-kanban list' },
    ],
    async run(argv) {
      try {
        if (argv[0] === 'profiles' && argv.length === 1) return { exitCode: 0, stdout: JSON.stringify({ profiles: profiles() }) };
        if (argv[0] === 'create' && argv.length === 5) return { exitCode: 0, stdout: JSON.stringify(await createTask({ projectId: argv[1], assignee: argv[2], title: argv[3], description: argv[4] })) };
        if (argv[0] === 'assign' && argv.length === 3) return { exitCode: 0, stdout: JSON.stringify(await assign({ threadId: argv[1], assignee: argv[2] })) };
        if (argv[0] === 'list' && argv.length === 1) return { exitCode: 0, stdout: JSON.stringify({ cards: all(), assignments: assignments() }) };
        if (argv[0] === 'move' && argv.length === 3) return { exitCode: 0, stdout: JSON.stringify(await move({ threadId: argv[1], column: argv[2] })) };
        return { exitCode: argv.length === 0 || argv.includes('--help') ? 0 : 1, stdout: usage };
      } catch (error) { return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }; }
    },
  });
}
