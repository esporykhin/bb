import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const MAX_FILE_BYTES = 120_000;
export const projectInput = z.object({
  name: z.string().trim().min(1).max(120),
  mode: z.enum(['new', 'existing']),
  repository: z.string().trim().max(1500),
  baseline: z.string().trim().max(12_000),
}).strict().superRefine((value, ctx) => {
  if (value.mode === 'existing' && (!value.repository || !value.baseline)) {
    ctx.addIssue({ code: 'custom', message: 'Для текущего продукта нужны репозиторий и описание исходного состояния.' });
  }
});
export const projectSchema = z.object({
  id: z.string().uuid(), name: z.string(), mode: z.enum(['new', 'existing']),
  repository: z.string(), baseline: z.string(),
  adoption: z.enum(['planned', 'baseline_recorded', 'adopting', 'standard']),
  revision: z.string(), createdAt: z.string(), updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;
export const fileSchema = z.object({ path: z.string(), hash: z.string() });
export const revisionSchema = z.object({
  id: z.string(), parent: z.string().nullable(), createdAt: z.string(),
  source: z.string(), files: z.array(fileSchema),
});
export type Revision = z.infer<typeof revisionSchema>;
export interface KV { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: unknown): Promise<unknown>; delete(key: string): Promise<unknown> }
export type Bundle = { source: string; files: {path: string; hash: string; content: string}[] };
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function validPath(value: string) {
  if (!/^meeseeks-[a-z0-9-]+\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(value) || value.split('/').some(p => p === '..' || p === '.')) throw new Error('Некорректный путь файла.');
  return value;
}
export class FactoryStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private kv: KV, private bundle: Bundle) {}
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async put(key: string, value: unknown) {
    if (Buffer.byteLength(JSON.stringify(value)) > 240_000) throw new Error('Превышен предел локального хранилища.');
    await this.kv.set(key, value);
  }
  async init() {
    return this.mutate(async () => {
      const existing = await this.kv.get<string>('head');
      if (existing) return this.revision(existing);
      if (!this.bundle.files.length || this.bundle.files.length > 500) throw new Error('Некорректный пакет.');
      for (const file of this.bundle.files) {
        validPath(file.path);
        if (hash(file.content) !== file.hash || Buffer.byteLength(file.content) > MAX_FILE_BYTES) throw new Error('Повреждён файл пакета: ' + file.path);
        await this.put('blob:' + file.hash, file.content);
      }
      const files = this.bundle.files.map(({path, hash}) => ({path, hash})).sort((a,b) => a.path.localeCompare(b.path, 'en'));
      const revision: Revision = { id: hash(JSON.stringify(files)), parent: null, createdAt: new Date().toISOString(), source: this.bundle.source, files };
      await this.put('revision:' + revision.id, revision);
      await this.put('revisions', [revision.id]);
      await this.put('head', revision.id);
      return revision;
    });
  }
  async revision(id: string): Promise<Revision> {
    const value = await this.kv.get('revision:' + id);
    if (!value) throw new Error('Ревизия не найдена.');
    return revisionSchema.parse(value);
  }
  async head() {
    const id = await this.kv.get<string>('head');
    if (!id) throw new Error('Пакет ещё не инициализирован.');
    return this.revision(id);
  }
  async revisions() {
    const ids = (await this.kv.get<string[]>('revisions')) ?? [];
    return Promise.all(ids.map(id => this.revision(id)));
  }
  async file(revision: string, path: string) {
    validPath(path);
    const entry = (await this.revision(revision)).files.find(f => f.path === path);
    if (!entry) throw new Error('Файл не найден.');
    const content = await this.kv.get<string>('blob:' + entry.hash);
    if (typeof content !== 'string' || hash(content) !== entry.hash) throw new Error('Содержимое файла повреждено.');
    return { ...entry, content };
  }
  edit(input: {expectedRevision: string; path: string; content: string}) {
    return this.mutate(async () => {
      const current = await this.head();
      if (current.id !== input.expectedRevision) throw new Error('Версия изменилась. Обновите файл перед сохранением.');
      const old = await this.file(current.id, input.path);
      if (Buffer.byteLength(input.content) > MAX_FILE_BYTES) throw new Error('Файл превышает 120 КБ.');
      const nextHash = hash(input.content);
      if (nextHash === old.hash) return current;
      const files = current.files.map(f => f.path === input.path ? {path:f.path, hash:nextHash} : f);
      const revision: Revision = {id: hash(JSON.stringify({parent:current.id, files})), parent:current.id, source:'local-edit', createdAt:new Date().toISOString(), files};
      const ids = (await this.kv.get<string[]>('revisions')) ?? [];
      if (ids.length >= 200) throw new Error('Достигнут предел 200 ревизий прототипа.');
      await this.put('blob:' + nextHash, input.content);
      await this.put('revision:' + revision.id, revision);
      await this.put('revisions', [...ids, revision.id]);
      await this.put('head', revision.id);
      return revision;
    });
  }
  async list(options: {limit?:number; offset?:number} = {}): Promise<Project[]> {
    const {limit,offset}=z.object({limit:z.number().int().min(1).max(20).default(20),offset:z.number().int().min(0).max(500).default(0)}).parse(options);
    const ids = (await this.kv.get<string[]>('projects')) ?? [];
    return Promise.all(ids.slice(offset,offset+limit).map(id => this.get(id)));
  }
  async count() {return ((await this.kv.get<string[]>('projects')) ?? []).length;}
  async get(id: string): Promise<Project> {
    const value = await this.kv.get('project:' + id);
    if (!value) throw new Error('Проект не найден.');
    return projectSchema.parse(value);
  }
  create(input: unknown) {
    return this.mutate(async () => {
      const parsed = projectInput.parse(input);
      const ids = (await this.kv.get<string[]>('projects')) ?? [];
      if (ids.length >= 500) throw new Error('Достигнут предел 500 проектов прототипа.');
      const now = new Date().toISOString();
      const project: Project = {...parsed, id:randomUUID(), adoption:parsed.mode === 'existing' ? 'baseline_recorded' : 'planned', revision:(await this.head()).id, createdAt:now, updatedAt:now};
      await this.put('project:' + project.id, project);
      await this.put('projects', [...ids, project.id]);
      return project;
    });
  }
  update(input: {id: string; expectedUpdatedAt: string; revision: string; adoption: Project['adoption']; name?:string; repository?:string; baseline?:string}) {
    return this.mutate(async () => {
      const project = await this.get(input.id);
      if (input.expectedUpdatedAt !== project.updatedAt) throw new Error('Проект изменён. Обновите страницу.');
      await this.revision(input.revision);
      const fields=projectInput.parse({name:input.name??project.name,mode:project.mode,repository:input.repository??project.repository,baseline:input.baseline??project.baseline});
      const updated = projectSchema.parse({...project, ...fields, revision:input.revision, adoption:input.adoption, updatedAt:new Date(Math.max(Date.now(), Date.parse(project.updatedAt)+1)).toISOString()});
      await this.put('project:' + project.id, updated);
      return updated;
    });
  }
  remove(id: string) {
    return this.mutate(async () => {
      await this.get(id);
      const ids = (await this.kv.get<string[]>('projects')) ?? [];
      await this.put('projects', ids.filter(v => v !== id));
      await this.kv.delete('project:' + id);
      return {removed:true};
    });
  }
}
