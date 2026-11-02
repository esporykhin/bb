import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
const compile=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.test.json'],{stdio:'inherit'});
if(compile.status!==0) process.exit(compile.status??1);
mkdirSync('.test-dist',{recursive:true});writeFileSync('.test-dist/package.json','{"type":"commonjs"}');
const test=spawnSync(process.execPath,['--test',...readdirSync('.test-dist/tests').filter(name=>name.endsWith('.test.js')).map(name=>'.test-dist/tests/'+name)],{stdio:'inherit'});
process.exit(test.status??1);
