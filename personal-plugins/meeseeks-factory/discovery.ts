import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const catalogInput = z.object({
  limit: z.number().int().min(1).max(20).default(20),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  query: z.string().trim().max(200).default(''),
}).strict();
export const catalogEntrySchema = z.object({name:z.string(),displayPath:z.string(),canonicalPath:z.string()});
export const catalogSchema = z.object({
  root:z.string(), canonicalRoot:z.string().nullable(), entries:z.array(catalogEntrySchema),
  total:z.number(), offset:z.number(), limit:z.number(), warnings:z.array(z.string()), error:z.string().nullable(),
});
export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export const defaultProjectsRoot = () => join(homedir(), 'Desktop', 'Проекты разработка');

export async function discoverProjects(input: unknown, root = defaultProjectsRoot()): Promise<Catalog> {
  const {limit,offset,query}=catalogInput.parse(input);
  const result:Catalog={root,canonicalRoot:null,entries:[],total:0,offset,limit,warnings:[],error:null};
  try {
    result.canonicalRoot=await realpath(root);
    const dirs=await readdir(root,{withFileTypes:true});
    const entries:CatalogEntry[]=[];
    const seen=new Set<string>();
    let warningCount=0;
    dirs.sort((a,b)=>Number(a.isSymbolicLink())-Number(b.isSymbolicLink())||a.name.localeCompare(b.name,'en'));
    for(const entry of dirs) {
      if(entry.name.startsWith('.')||(!entry.isDirectory()&&!entry.isSymbolicLink())) continue;
      const displayPath=join(root,entry.name);
      try {
        if(!(await stat(displayPath)).isDirectory()) continue;
        const canonicalPath=await realpath(displayPath);
        if(seen.has(canonicalPath)) continue;
        seen.add(canonicalPath);
        entries.push({name:entry.name,displayPath,canonicalPath});
      } catch {
        warningCount++;
        if(result.warnings.length<50) result.warnings.push('Каталог недоступен или ссылка повреждена: '+entry.name);
      }
    }
    if(warningCount>50) result.warnings.push('Ещё недоступных каталогов: '+(warningCount-50));
    const needle=query.toLocaleLowerCase('ru');
    const filtered=entries.filter(entry=>[entry.name,entry.displayPath,entry.canonicalPath].some(value=>value.toLocaleLowerCase('ru').includes(needle)))
      .sort((a,b)=>a.name.localeCompare(b.name,'en'));
    result.total=filtered.length;
    result.entries=filtered.slice(offset,offset+limit);
  } catch {
    result.error='Не удалось прочитать каталог проектов. Проверьте путь и доступ: '+root;
  }
  return result;
}
