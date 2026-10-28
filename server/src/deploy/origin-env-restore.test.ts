import {expect,test} from 'bun:test';
import {chmodSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const script=readFileSync(resolve(import.meta.dir,'../../../scripts/deploy/origin-release.sh'),'utf8');
const fn=(name:string)=>{const text=script.match(new RegExp('^'+name+'\\(\\) \\{[\\s\\S]*?^\\}','m'))?.[0];if(!text)throw Error('missing '+name);return text;};
const run=(writable:boolean,deny=false)=>{
 const dir=mkdtempSync(join(tmpdir(),'origin-env-restore-')),parent=join(dir,'etc'),bin=join(dir,'bin');mkdirSync(parent);mkdirSync(bin);
 const file=join(parent,'server.env'),backup=join(dir,'backup'),log=join(dir,'commands');writeFileSync(file,'AI_MODEL=group/work\n');writeFileSync(backup,'AI_MODEL=before\n');chmodSync(backup,0o600);
 writeFileSync(join(bin,'sudo'),`#!/bin/sh\n[ "$1" = -n ] || exit 99\nshift\nprintf '%s\\n' "$1" >> "$COMMAND_LOG"\n${deny?'exit 1':'chmod u+w "$ENV_PARENT"\n"$@"\ns=$?\nchmod u-w "$ENV_PARENT"\nexit "$s"'}\n`,{mode:0o700});
 if(!writable)chmodSync(parent,0o500);
 try{
  const result=Bun.spawnSync(['bash','-c',`set -euo pipefail\nenv_file="$ENV_TARGET"\nenv_backup="$ENV_BACKUP"\n${script.includes('restore_env_command()')?fn('restore_env_command'):''}\n${fn('restore_env')}\nrestore_env\n`],{env:{...process.env,PATH:bin+':'+process.env.PATH,ENV_PARENT:parent,ENV_TARGET:file,ENV_BACKUP:backup,COMMAND_LOG:log},stdout:'pipe',stderr:'pipe'});
  return {exit:result.exitCode,text:readFileSync(file,'utf8'),mode:statSync(file).mode&0o777,calls:existsSync(log)?readFileSync(log,'utf8').trim().split('\n'):[],output:new TextDecoder().decode(result.stdout)+new TextDecoder().decode(result.stderr)};
 }finally{chmodSync(parent,0o700);rmSync(dir,{recursive:true,force:true});}
};
test('writable env directory restores privately without sudo',()=>{const r=run(true);expect(r.exit).toBe(0);expect(r.text).toBe('AI_MODEL=before\n');expect(r.mode).toBe(0o600);expect(r.calls).toEqual([]);});
const protectedTest=process.getuid?.()===0?test.skip:test;
protectedTest('root-owned-style non-writable parent uses noninteractive privilege for atomic restore',()=>{const r=run(false);expect(r.exit).toBe(0);expect(r.text).toBe('AI_MODEL=before\n');expect(r.mode).toBe(0o600);expect(r.calls).toEqual(['cp','chmod','mv']);});
protectedTest('denied privilege preserves live env and never leaks its values',()=>{const r=run(false,true);expect(r.exit).not.toBe(0);expect(r.text).toBe('AI_MODEL=group/work\n');expect(r.output).not.toContain('AI_MODEL=');});
