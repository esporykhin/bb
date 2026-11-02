import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjects } from '../discovery';

test('discovery follows symlink root and directories, filters files/hidden/broken, canonical dedup',async t=>{
  const base=await mkdtemp(join(tmpdir(),'factory-discovery-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const actual=join(base,'projects');await mkdir(actual);const root=join(base,'Desktop projects');await symlink(actual,root);
  await mkdir(join(actual,'Alpha'));await mkdir(join(actual,'Alpha','nested'));
  await writeFile(join(actual,'Alpha','.env'),'DO_NOT_READ');
  await mkdir(join(actual,'.hidden'));await writeFile(join(actual,'file.txt'),'A file');
  await symlink(join(actual,'Alpha'),join(actual,'alias-alpha'));
  await symlink(join(actual,'file.txt'),join(actual,'file-link'));
  await symlink(join(base,'missing'),join(actual,'broken'));
  const external=join(base,'external');await mkdir(external);await symlink(external,join(actual,'External project'));
  const catalog=await discoverProjects({},root);
  assert.equal(catalog.error,null);assert.equal(catalog.root,root);assert.equal(catalog.canonicalRoot,await realpath(actual));
  assert.equal(catalog.total,2);
  assert.deepEqual(catalog.entries.map(entry=>entry.name),['Alpha','External project']);
  assert.deepEqual(catalog.entries[0],{name:'Alpha',displayPath:join(root,'Alpha'),canonicalPath:await realpath(join(actual,'Alpha'))});
  assert.equal(catalog.entries[1]!.canonicalPath,await realpath(external));
  assert.equal(catalog.warnings.length,1);assert.match(catalog.warnings[0]!,/broken/);
});

test('discovery paginates all directories and searches all pages case-insensitively',async t=>{
  const root=await mkdtemp(join(tmpdir(),'factory-discovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(let i=0;i<27;i++) await mkdir(join(root,'app-'+i.toString().padStart(2,'0')));
  const first=await discoverProjects({},root);const second=await discoverProjects({offset:20,limit:20},root);
  assert.equal(first.total,27);assert.equal(first.entries.length,20);assert.equal(second.total,27);assert.equal(second.entries.length,7);
  assert.equal(new Set([...first.entries,...second.entries].map(entry=>entry.canonicalPath)).size,27);
  const filtered=await discoverProjects({query:' APP-2 ',limit:3,offset:3},root);
  assert.equal(filtered.total,7);assert.deepEqual(filtered.entries.map(entry=>entry.name),['app-23','app-24','app-25']);
  const noMatch=await discoverProjects({query:'no-match'},root);assert.equal(noMatch.total,0);assert.deepEqual(noMatch.entries,[]);
  const beyond=await discoverProjects({offset:100},root);assert.deepEqual(beyond.entries,[]);assert.equal(beyond.total,27);
});

test('unavailable root and root file return separate bounded diagnostic, invalid options rejected',async t=>{
  const base=await mkdtemp(join(tmpdir(),'factory-discovery-'));t.after(()=>rm(base,{recursive:true,force:true}));
  for(const root of [join(base,'missing'),join(base,'file')]) {
    if(root.endsWith('file'))await writeFile(root,'Not a directory');
    const result=await discoverProjects({},root);assert.match(result.error!,/Не удалось прочитать каталог/);assert.equal(result.total,0);assert.deepEqual(result.entries,[]);
  }
  await assert.rejects(discoverProjects({limit:21},base));await assert.rejects(discoverProjects({offset:-1},base));await assert.rejects(discoverProjects({query:'x'.repeat(201)},base));
});

test('many broken links produce bounded warnings',async t=>{
  const root=await mkdtemp(join(tmpdir(),'factory-discovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(let i=0;i<54;i++)await symlink(join(root,'missing'),join(root,'broken-'+i));
  const result=await discoverProjects({},root);
  assert.equal(result.error,null);assert.equal(result.total,0);assert.equal(result.warnings.length,51);assert.equal(result.warnings[50],'Ещё недоступных каталогов: 4');
});
