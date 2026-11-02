import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
const compile=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.ui-test.json'],{stdio:'inherit'});
if(compile.status!==0)process.exit(compile.status??1);
mkdirSync('.ui-test-dist',{recursive:true});writeFileSync('.ui-test-dist/package.json','{"type":"commonjs"}');
function rewriteAliases(directory){for(const item of readdirSync(directory,{withFileTypes:true})){const file=join(directory,item.name);if(item.isDirectory())rewriteAliases(file);else if(file.endsWith('.js')){const code=readFileSync(file,'utf8').replace(/require\(["']@\/([^"']+)["']\)/g,(_,target)=>{const path=relative(dirname(file),resolve('.ui-test-dist',target)).replaceAll('\\','/');return 'require('+JSON.stringify(path.startsWith('.')?path:'./'+path)+')';});writeFileSync(file,code);}}}
rewriteAliases('.ui-test-dist');
const test=spawnSync(process.execPath,['--import','./scripts/ui-test-env.mjs','--test','.ui-test-dist/tests/native-thread-context.test.js'],{stdio:'inherit'});
process.exit(test.status??1);
