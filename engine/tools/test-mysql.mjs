import {spawn} from 'node:child_process';
// The flag is explicit: the default unit suite never creates database fixtures.
const child=spawn(process.execPath,['--env-file-if-exists=.env','--test','test/persistence.test.mjs','test/round-store.test.mjs','test/weapon-persistence.test.mjs','test/integration.test.mjs'],{
  stdio:'inherit',env:{...process.env,MYSQL_TEST:'1'}
});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
