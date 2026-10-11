import {readFile,writeFile,mkdir,copyFile,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const source=path.resolve(process.argv[2]||'D:/Resources/MVDLC/City Exterior Tileset/sample MZ/sample project_jp');
const selection=[['ArrowSpecial','MZ · 投掷穿刺',35],['ShootNormal','MZ · 火器射击',60],['FireOne1','MZ · 火焰法杖',60],['HitPhysical','MZ · 重棒冲击',50]];
const database=JSON.parse(await readFile(path.join(project,'data/Animations.json'),'utf8'));
const sourceAnimations=JSON.parse(await readFile(path.join(source,'data/Animations.json'),'utf8'));
const manifest={source:'Local resource library: MVDLC/City Exterior Tileset/sample MZ/sample project_jp',runtime:'Effekseer for WebGL v1.52n (MIT)',effects:[]};
async function files(directory){const out=[];for(const entry of await readdir(directory,{withFileTypes:true})){const p=path.join(directory,entry.name);if(entry.isDirectory())out.push(...await files(p));else out.push(p);}return out;}
const assets=await files(path.join(source,'effects'));
await mkdir(path.join(project,'engine/client/vendor/effekseer'),{recursive:true});
for(const name of ['effekseer.min.js','effekseer.wasm'])await copyFile(path.join(source,'js/libs',name),path.join(project,'engine/client/vendor/effekseer',name));
async function copy(relative){const from=path.join(source,relative),to=path.join(project,relative);await mkdir(path.dirname(to),{recursive:true});try{await stat(to);}catch(error){if(error.code!=='ENOENT')throw error;await copyFile(from,to);}}
for(const [effectName,name,scale]of selection){
 const buffer=await readFile(path.join(source,'effects',effectName+'.efkefc'));
 const dependencies=assets.filter(file=>{const relative=path.relative(path.join(source,'effects'),file).replaceAll('\\','/');return buffer.includes(Buffer.from(relative,'utf16le'))||buffer.includes(Buffer.from(relative.replaceAll('/','\\'),'utf16le'));});
 await copy(`effects/${effectName}.efkefc`);
 for(const file of dependencies)await copy(path.relative(source,file));
 let animation=database.find(a=>a?.effectName===effectName);
 if(!animation){const original=sourceAnimations.find(a=>a?.effectName===effectName);if(!original)throw new Error(`Missing source animation ${effectName}`);animation={...original,id:database.length,name};database.push(animation);}
 if(animation.name===name){
  animation.scale=scale;
  // This is an MV authoring project: its old runtime still reads frames.length.
  // New engine dispatches by effectName first. Remove these placeholders when
  // moving a record into native MZ, whose isMVAnimation tests !!animation.frames.
  for(const [key,value]of Object.entries({animation1Name:'',animation1Hue:0,animation2Name:'',animation2Hue:0,frames:[],timings:[],position:1}))animation[key]??=value;
 }
 for(const timing of animation.soundTimings||[]){for(const ext of ['ogg','m4a'])try{await copy(`audio/se/${timing.se.name}.${ext}`);}catch(error){if(error.code!=='ENOENT')throw error;}}
 manifest.effects.push({animationId:animation.id,effectName,dependencies:dependencies.map(file=>path.relative(path.join(source,'effects'),file).replaceAll('\\','/'))});
}
await writeFile(path.join(project,'data/Animations.json'),JSON.stringify(database)+'\n');
await writeFile(path.join(project,'engine/client/vendor/effekseer/SOURCE.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest,null,2));
