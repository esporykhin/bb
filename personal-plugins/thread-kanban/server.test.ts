import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';

const importer = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'import-codex-profiles.py');

function createHost(options: { beforeSpawn?: () => Promise<void>; getProject?: (id: string) => Promise<unknown> } = {}) {
  const spawnCalls: any[] = [];
  const metadataCalls: any[] = [];
  const metadata = new Map<string, Record<string, unknown>>();
  const host = createFakePluginHost({
    pluginId: 'thread-kanban',
    agentSkillIds: ['thread-kanban'],
    sdk: { projects: { get: async ({ projectId }) => options.getProject ? await options.getProject(projectId) : { id: projectId } }, threads: { spawn: async (input) => {
      spawnCalls.push(input);
      await options.beforeSpawn?.();
      if (input.title === 'Fail') throw new Error('spawn failed');
      metadata.set('thr_created', input.pluginMetadata ?? {});
      return makeThreadResponse({ id: 'thr_created' });
    }, updatePluginMetadata: async (input) => {
      if (input.threadId === 'missing') throw new Error('Thread not found');
      metadataCalls.push(input);
      metadata.set(input.threadId, { ...metadata.get(input.threadId), ...input.set });
      return { threadId: input.threadId, pluginId: 'thread-kanban', metadata: input.set ?? {} };
    }, getPluginMetadata: async ({ threadId }) => {
      return metadata.get(threadId) ?? {};
    }, get: async ({ threadId }) => {
      if (threadId === 'missing') throw new Error('Thread not found');
      return makeThreadResponse({ id: threadId });
    } } },
  });
  plugin(host.bb);
  return Object.assign(host, { spawnCalls, metadataCalls });
}
const profiles = [
  { id: 'tester', name: 'Tester', instructions: 'Test user flows and report failures.' },
  { id: 'reviewer', name: 'Reviewer', instructions: 'Review code and highlight defects.' },
  { id: 'debugger', name: 'Debugger', instructions: 'Investigate the root cause.' },
];
const importProfiles = async (host: ReturnType<typeof createHost>) => {
  assert.deepEqual(await host.harness.behavior.callRpc('profiles_import', { profiles }), { imported: profiles.length });
};
const thread = makeThreadResponse({ id: 'thr_test' });
const read = async (host: ReturnType<typeof createHost>) => await host.harness.behavior.callRpc('board', null) as { cards: Array<{ threadId: string; column: string; updatedAt: string }>; assignments: Array<{ threadId: string; assignee: string }> };
const shape = (value: unknown, threadId: string, column: string) => {
  assert.ok(value && typeof value === 'object');
  const item = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(item).sort(), ['column', 'threadId', 'updatedAt']);
  assert.equal(item.threadId, threadId);
  assert.equal(item.column, column);
  assert.equal(typeof item.updatedAt, 'string');
  assert.ok(Number.isFinite(Date.parse(item.updatedAt as string)));
};

test('RPC move persists exact card shape through update, reload, and thread deletion', async () => {
  let host = createHost();
  try {
    assert.deepEqual(await read(host), { cards: [], assignments: [] });
    const first = await host.harness.behavior.callRpc('move', { threadId: thread.id, column: 'backlog' });
    shape(first, thread.id, 'backlog');
    assert.deepEqual(await read(host), { cards: [first], assignments: [] });
    const second = await host.harness.behavior.callRpc('move', { threadId: thread.id, column: 'done' });
    shape(second, thread.id, 'done');
    assert.deepEqual(await read(host), { cards: [second], assignments: [] });
    host = await host.harness.lifecycle.reload(plugin);
    assert.deepEqual(await read(host), { cards: [second], assignments: [] });
    assert.deepEqual(await host.harness.behavior.emitThreadEvent('thread.deleted', { thread }), { errors: [] });
    assert.deepEqual(await read(host), { cards: [], assignments: [] });
    assert.ok(host.harness.inspection.realtimeSignals.some(s => s.channel === 'board-changed'));
  } finally { await host.harness.lifecycle.dispose(); }
});

test('RPC rejects invalid column, wrong field names and missing threads without changes', async () => {
  const host = createHost();
  try {
    await assert.rejects(host.harness.behavior.callRpc('move', { threadId: thread.id, column: 'invalid' }));
    await assert.rejects(host.harness.behavior.callRpc('move', { thread_id: thread.id, column: 'done' }));
    await assert.rejects(host.harness.behavior.callRpc('move', { threadId: 'missing', column: 'done' }), /Thread not found/);
    assert.deepEqual(await read(host), { cards: [], assignments: [] });
  } finally { await host.harness.lifecycle.dispose(); }
});

test('lifecycle events move active to review on idle and failures to blocked', async () => {
  const host = createHost();
  try {
    assert.deepEqual(await host.harness.behavior.emitThreadEvent('thread.active', { thread }), { errors: [] });
    shape((await read(host)).cards[0], thread.id, 'in_progress');
    assert.deepEqual(await host.harness.behavior.emitThreadEvent('thread.idle', { thread, lastAssistantText: 'ready' }), { errors: [] });
    shape((await read(host)).cards[0], thread.id, 'review');
    assert.deepEqual(await host.harness.behavior.emitThreadEvent('thread.failed', { thread, error: 'failed' }), { errors: [] });
    shape((await read(host)).cards[0], thread.id, 'blocked');
    await host.harness.behavior.callRpc('move', { threadId: thread.id, column: 'done' });
    assert.deepEqual(await host.harness.behavior.emitThreadEvent('thread.active', { thread }), { errors: [] });
    shape((await read(host)).cards[0], thread.id, 'done');
  } finally { await host.harness.lifecycle.dispose(); }
});


test('assignment is validated, survives reload and is removed when its thread is deleted', async () => {
  let host = createHost();
  try {
    await importProfiles(host);
    assert.deepEqual(await host.harness.behavior.callRpc('assign', { threadId: thread.id, assignee: '  tester  ' }), { threadId: thread.id, assignee: 'tester' });
    assert.deepEqual((await read(host)).assignments, [{ threadId: thread.id, assignee: 'tester' }]);
    assert.deepEqual(await host.harness.behavior.callRpc('assign', { threadId: thread.id, assignee: 'reviewer' }), { threadId: thread.id, assignee: 'reviewer' });
    assert.deepEqual(host.metadataCalls, []);
    host = await host.harness.lifecycle.reload(plugin) as typeof host;
    assert.deepEqual((await read(host)).assignments, [{ threadId: thread.id, assignee: 'reviewer' }]);
    assert.deepEqual(await host.harness.behavior.emitThreadEvent('thread.deleted', { thread }), { errors: [] });
    assert.deepEqual((await read(host)).assignments, []);
    await assert.rejects(host.harness.behavior.callRpc('assign', { threadId: 'missing', assignee: 'tester' }));
    await assert.rejects(host.harness.behavior.callRpc('assign', { threadId: thread.id, assignee: 'x'.repeat(81) }));
    assert.deepEqual((await read(host)).assignments, []);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('createTask spawns thread with task context and saves assignment for returned id; spawn errors leave no assignment', async () => {
  const host = createHost();
  try {
    await importProfiles(host);
    const result = await host.harness.behavior.callRpc('createTask', { projectId: 'proj_test', title: 'Investigate bug', description: 'Fix checkout', assignee: 'debugger' });
    assert.deepEqual(result, { threadId: 'thr_created', assignee: 'debugger' });
    assert.equal(host.spawnCalls.length, 1);
    const call = host.spawnCalls[0];
    assert.equal(call.projectId, 'proj_test');
    assert.equal(call.title, 'Investigate bug');
    const payload = JSON.stringify(call);
    assert.match(payload, /Fix checkout/);
    assert.match(payload, /debugger/);
    assert.match(payload, /Investigate the root cause/);
    assert.equal(call.pluginMetadata.roleId, 'debugger');
    assert.notEqual(call.prompt.includes('Поручи выполнение задачи агенту'), true);
    assert.deepEqual((await read(host)).assignments, [{ threadId: 'thr_created', assignee: 'debugger' }]);
    await assert.rejects(host.harness.behavior.callRpc('createTask', { projectId: 'proj_test', title: 'Fail', description: 'failed task', assignee: 'tester' }), /spawn failed/);
    assert.deepEqual((await read(host)).assignments, [{ threadId: 'thr_created', assignee: 'debugger' }]);
    await assert.rejects(host.harness.behavior.callRpc('createTask', { projectId: '', title: '', description: 'x', assignee: 'tester' }));
    assert.equal(host.spawnCalls.length, 2);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('profile catalog exposes only identifiers and names, persists on reload, and rejects malformed imports', async () => {
  let host = createHost();
  try {
    assert.deepEqual(await host.harness.behavior.callRpc('profiles_list', null), { profiles: [] });
    await importProfiles(host);
    assert.deepEqual(await host.harness.behavior.callRpc('profiles_list', null), {
      profiles: [...profiles].sort((a, b) => a.name.localeCompare(b.name)).map(({ id, name }) => ({ id, name })),
    });
    const cli = await host.harness.behavior.runCli(['profiles']);
    assert.equal(cli.exitCode, 0);
    for (const profile of profiles) assert.match(cli.stdout ?? '', new RegExp(profile.id));
    assert.doesNotMatch(cli.stdout ?? '', /Test user flows/);
    await assert.rejects(host.harness.behavior.callRpc('profiles_import', { profiles: [{ id: '', name: 'Invalid', instructions: 'x' }] }));
    assert.deepEqual(await host.harness.behavior.callRpc('profiles_list', null), {
      profiles: [...profiles].sort((a, b) => a.name.localeCompare(b.name)).map(({ id, name }) => ({ id, name })),
    });
    host = await host.harness.lifecycle.reload(plugin) as typeof host;
    assert.deepEqual(await host.harness.behavior.callRpc('profiles_list', null), {
      profiles: [...profiles].sort((a, b) => a.name.localeCompare(b.name)).map(({ id, name }) => ({ id, name })),
    });
  } finally { await host.harness.lifecycle.dispose(); }
});

test('creation rejects unknown profile without spawning a thread or recording an assignment', async () => {
  const host = createHost();
  try {
    await importProfiles(host);
    await assert.rejects(host.harness.behavior.callRpc('createTask', {
      projectId: 'proj_test', title: 'Test', description: 'Description', assignee: 'unknown',
    }));
    assert.equal(host.spawnCalls.length, 0);
    assert.deepEqual(await read(host), { cards: [], assignments: [] });
    await assert.rejects(host.harness.behavior.callRpc('assign', { threadId: thread.id, assignee: 'unknown' }));
    assert.deepEqual(await read(host), { cards: [], assignments: [] });
  } finally { await host.harness.lifecycle.dispose(); }
});

test('long role instructions are passed in full to new tasks and configuration is scoped to that role', async () => {
  const host = createHost();
  try {
    const instructions = `${'Detailed role instruction. '.repeat(220)}END OF ROLE`;
    assert.deepEqual(await host.harness.behavior.callRpc('profiles_import', { profiles: [{ id: 'long-role', name: 'Long Role', instructions }] }), { imported: 1 });
    assert.deepEqual(await host.harness.behavior.callRpc('createTask', {
      projectId: 'proj_test', title: 'Long role task', description: 'Do actual work', assignee: 'long-role',
    }), { threadId: 'thr_created', assignee: 'long-role' });
    const call = host.spawnCalls[0];
    assert.equal(call.projectId, 'proj_test');
    assert.equal(call.title, 'Long role task');
    assert.equal(call.pluginMetadata.roleId, 'long-role');
    assert.ok(call.prompt.includes(instructions), 'must not truncate long profiles');
    assert.ok(call.prompt.includes('Do actual work'));
    const own = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: call.pluginMetadata }));
    assert.ok(own.instructions && own.instructions.length <= 4096);
    assert.deepEqual(own.tools.map(tool => tool.name), ['kanban_role_context']);
    assert.deepEqual(own.skills, ['thread-kanban']);
    assert.equal(await host.harness.behavior.callAgentTool('kanban_role_context', {}, { threadId: 'thr_created' }), instructions);
    await assert.rejects(host.harness.behavior.callAgentTool('kanban_role_context', {}, { threadId: 'other' }), /no valid kanban agent profile/);
    const unrelated = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: {} }));
    assert.equal(unrelated.instructions, null);
    assert.deepEqual(unrelated.tools, []);
    assert.deepEqual(unrelated.skills, ['thread-kanban']);
    const unknown = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { roleId: 'nonexistent' } }));
    assert.equal(unknown.instructions, null);
    assert.deepEqual(unknown.tools, []);
    assert.deepEqual(unknown.skills, ['thread-kanban']);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('CLI creates a real thread with the selected profile and list reflects its assignment', async () => {
  const host = createHost();
  try {
    await importProfiles(host);
    const cli = await host.harness.behavior.runCli(['create', 'proj_test', 'tester', 'Checkout regression', 'Exercise the lifecycle']);
    assert.equal(cli.exitCode, 0);
    assert.deepEqual(JSON.parse(cli.stdout ?? ''), { threadId: 'thr_created', assignee: 'tester' });
    assert.equal(host.spawnCalls.length, 1);
    assert.equal(host.spawnCalls[0].projectId, 'proj_test');
    assert.equal(host.spawnCalls[0].title, 'Checkout regression');
    assert.equal(host.spawnCalls[0].pluginMetadata.roleId, 'tester');
    assert.match(host.spawnCalls[0].prompt, /Exercise the lifecycle/);
    assert.deepEqual((await read(host)).assignments, [{ threadId: 'thr_created', assignee: 'tester' }]);
    const invalid = await host.harness.behavior.runCli(['create', 'proj_test', 'unknown', 'Title', 'Work']);
    assert.equal(invalid.exitCode, 1);
    assert.equal(host.spawnCalls.length, 1);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('profile update changes subsequently resolved instructions without affecting other profiles', async () => {
  const host = createHost();
  try {
    await importProfiles(host);
    const updated = { id: 'tester', name: 'Tester Updated', instructions: 'Updated exact role instructions.' };
    assert.deepEqual(await host.harness.behavior.callRpc('profiles_import', { profiles: [updated] }), { imported: 1 });
    const list = await host.harness.behavior.callRpc('profiles_list', null) as { profiles: Array<{id:string;name:string}> };
    assert.deepEqual(list.profiles, [
      { id: 'debugger', name: 'Debugger' },
      { id: 'reviewer', name: 'Reviewer' },
      { id: 'tester', name: 'Tester Updated' },
    ]);
    const updatedConfig = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { roleId: 'tester' } }));
    assert.ok(updatedConfig.instructions?.includes(updated.instructions));
    const reviewer = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { roleId: 'reviewer' } }));
    assert.ok(reviewer.instructions?.includes(profiles[1].instructions));
    assert.equal(reviewer.instructions?.includes(updated.instructions), false);
    const unrelated = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: {} }));
    assert.equal(unrelated.instructions, null);
    assert.deepEqual(unrelated.tools, []);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('idempotency key prevents duplicate task creation across concurrent calls and reloads', async () => {
  let started!: () => void;
  let release!: () => void;
  const spawnStarted = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let host = createHost({ beforeSpawn: async () => { started(); await gate; } });
  try {
    await importProfiles(host);
    const input = { projectId: 'proj_test', title: 'Safe task', description: 'Work once', assignee: 'tester', requestId: 'unique-request-1' };
    const first = host.harness.behavior.callRpc('createTask', input);
    await spawnStarted;
    await assert.rejects(host.harness.behavior.callRpc('createTask', input), /already running|uncertain/);
    await assert.rejects(host.harness.behavior.callRpc('createTask', { ...input, title: 'Different' }), /different content/);
    assert.equal(host.spawnCalls.length, 1);
    release();
    assert.deepEqual(await first, { threadId: 'thr_created', assignee: 'tester' });
    assert.deepEqual(await host.harness.behavior.callRpc('createTask', input), { threadId: 'thr_created', assignee: 'tester' });
    assert.equal(host.spawnCalls.length, 1);
    host = await host.harness.lifecycle.reload(plugin) as typeof host;
    assert.deepEqual(await host.harness.behavior.callRpc('createTask', input), { threadId: 'thr_created', assignee: 'tester' });
    assert.deepEqual((await read(host)).assignments, [{ threadId: 'thr_created', assignee: 'tester' }]);
  } finally { release(); await host.harness.lifecycle.dispose(); }
});

test('a failed create remains uncertain on retry and does not start another task', async () => {
  const host = createHost();
  try {
    await importProfiles(host);
    const input = { projectId: 'proj_test', title: 'Fail', description: 'Work once', assignee: 'tester', requestId: 'ambiguous-request-1' };
    await assert.rejects(host.harness.behavior.callRpc('createTask', input), /spawn failed/);
    await assert.rejects(host.harness.behavior.callRpc('createTask', input), /already running|uncertain/);
    assert.equal(host.spawnCalls.length, 1);
    assert.deepEqual(await read(host), { cards: [], assignments: [] });
  } finally { await host.harness.lifecycle.dispose(); }
});

test('changing a card assignee keeps the role instructions of the existing running thread', async () => {
  const host = createHost();
  try {
    await importProfiles(host);
    const result = await host.harness.behavior.callRpc('createTask', { projectId: 'proj_test', title: 'Task', description: 'Work', assignee: 'tester' });
    assert.deepEqual(result, { threadId: 'thr_created', assignee: 'tester' });
    assert.deepEqual(await host.harness.behavior.callRpc('assign', { threadId: 'thr_created', assignee: 'reviewer' }), { threadId: 'thr_created', assignee: 'reviewer' });
    assert.deepEqual((await read(host)).assignments, [{ threadId: 'thr_created', assignee: 'reviewer' }]);
    assert.deepEqual(host.metadataCalls, []);
    assert.equal(await host.harness.behavior.callAgentTool('kanban_role_context', {}, { threadId: 'thr_created' }), profiles[0].instructions);
    const original = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: host.spawnCalls[0].pluginMetadata }));
    assert.ok(original.instructions?.includes(profiles[0].instructions));
    assert.equal(original.instructions?.includes(profiles[1].instructions), false);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('project preflight failure never reserves the request key, allowing safe retry', async () => {
  let available = false;
  const host = createHost({ getProject: async (id) => {
    if (!available) throw new Error('Project unavailable');
    return { id };
  } });
  try {
    await importProfiles(host);
    const input = { projectId: 'proj_test', title: 'Preflight task', description: 'Task', assignee: 'tester', requestId: 'preflight-retry-1' };
    await assert.rejects(host.harness.behavior.callRpc('createTask', input), /Project unavailable/);
    assert.equal(host.spawnCalls.length, 0);
    assert.deepEqual(await read(host), { cards: [], assignments: [] });
    available = true;
    assert.deepEqual(await host.harness.behavior.callRpc('createTask', input), { threadId: 'thr_created', assignee: 'tester' });
    assert.equal(host.spawnCalls.length, 1);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('idempotency records do not retain task text and are removed when the thread is deleted', async () => {
  const host = createHost();
  try {
    await importProfiles(host);
    const secretTask = 'Private test task contents 567891';
    const input = { projectId: 'proj_test', title: 'Privacy task', description: secretTask, assignee: 'tester', requestId: 'privacy-task-1' };
    await host.harness.behavior.callRpc('createTask', input);
    const db = host.bb.storage.database();
    const row = db.prepare('SELECT payload FROM task_requests WHERE requestId = ?').get(input.requestId) as { payload: string };
    assert.ok(row && typeof row.payload === 'string');
    assert.equal(row.payload.includes(secretTask), false);
    await host.harness.behavior.emitThreadEvent('thread.deleted', { thread: makeThreadResponse({ id: 'thr_created' }) });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_requests WHERE requestId = ?').get(input.requestId).n, 0);
    assert.deepEqual(await read(host), { cards: [], assignments: [] });
  } finally { await host.harness.lifecycle.dispose(); }
});

test('Codex importer merges explicit and discovered roles without exposing skipped file contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'kanban-profile-import-'));
  try {
    const agents = join(root, 'agents');
    mkdirSync(agents);
    const config = join(root, 'config.toml');
    const output = join(root, 'profiles.json');
    writeFileSync(config, '[agents.tester]\nconfig_file = "agents/migrated-tester.toml"\n');
    writeFileSync(join(agents, 'migrated-tester.toml'), 'developer_instructions = "Explicit instructions"\n');
    writeFileSync(join(agents, 'old-tester.toml'), 'name = "tester"\ndeveloper_instructions = "Stale instructions"\n');
    writeFileSync(join(agents, 'unique.toml'), 'name = "analyst"\ndeveloper_instructions = "Analyze accurately"\n');
    writeFileSync(join(agents, 'nameless.toml'), 'developer_instructions = "Must not create a profile"\n');
    writeFileSync(join(agents, 'invalid.toml'), 'name = "SECRET_TEXT_FOR_TEST\n');
    const result = spawnSync('python3', [importer, '--config', config, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid\.toml/);
    assert.doesNotMatch(result.stderr, /SECRET_TEXT_FOR_TEST/);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { profiles: [
      { id: 'tester', name: 'tester', instructions: 'Explicit instructions' },
      { id: 'analyst', name: 'analyst', instructions: 'Analyze accurately' },
    ] });
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const original = readFileSync(output, 'utf8');
    const repeat = spawnSync('python3', [importer, '--config', config, '--output', output], { encoding: 'utf8' });
    assert.notEqual(repeat.status, 0);
    assert.equal(readFileSync(output, 'utf8'), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex importer fails when an explicitly configured role file is invalid', () => {
  const root = mkdtempSync(join(tmpdir(), 'kanban-profile-invalid-'));
  try {
    const config = join(root, 'config.toml');
    const output = join(root, 'profiles.json');
    mkdirSync(join(root, 'agents'));
    writeFileSync(config, '[agents.tester]\nconfig_file = "agents/invalid.toml"\n');
    writeFileSync(join(root, 'agents', 'invalid.toml'), 'developer_instructions = "broken\n');
    const result = spawnSync('python3', [importer, '--config', config, '--output', output], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.throws(() => statSync(output), { code: 'ENOENT' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
