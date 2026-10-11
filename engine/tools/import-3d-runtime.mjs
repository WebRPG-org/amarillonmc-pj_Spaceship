import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Explicitly imports the user's purchased plugin archives, not the older project plugin.
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const downloads=process.env.MV3D_DOWNLOADS||'C:/Users/mapodoufu/Downloads';
const resources=process.env.MV3D_RESOURCES||'D:/Resources';
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const records=[];
for(const kind of ['mv','mz']){
  const plugin=kind+'3d',archive=path.join(downloads,`${plugin}-plugin 0.9.2.8.zip`);
  const sample=path.join(resources,`${plugin}-project 0.9.2.8`);
  const destination=path.join(project,'engine/client/vendor/3d',kind);
  await mkdir(destination,{recursive:true});
  const libs=kind==='mv'?['pixi.js','pixi-tilemap.js','pixi-picture.js','lz-string.js']:['pixi.js','pako.min.js','localforage.min.js','effekseer.min.js','effekseer.wasm'];
  const prefix=kind==='mv'?'rpg':'rmmz';
  for(const file of [...libs.map(n=>'libs/'+n),...['core','managers','objects','scenes','sprites','windows'].map(n=>`${prefix}_${n}.js`)]){
    const source=path.join(sample,'js',file),target=path.join(destination,file);
    await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);
    records.push({file:path.relative(project,target).replaceAll('\\','/'),source,sha256:createHash('sha256').update(await readFile(target)).digest('hex')});
  }
  const command=`Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive3d=[IO.Compression.ZipFile]::OpenRead(${quote(archive)}); try { foreach($entry3d in $archive3d.Entries) { if ($entry3d.FullName -eq ${quote('js/plugins/'+plugin+'.js')}) { $target3d=${quote(path.join(destination,plugin+'.js'))} } elseif($entry3d.FullName -match '^img/(MV3D|MZ3D)/[^/]+[.]png$') { $target3d=Join-Path ${quote(project)} $entry3d.FullName } else { continue }; [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target3d)) | Out-Null; [IO.Compression.ZipFileExtensions]::ExtractToFile($entry3d,$target3d,$true) } } finally { $archive3d.Dispose() }`;
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{stdio:'inherit',windowsHide:true});
  const pluginFile=path.join(destination,plugin+'.js'),source=await readFile(pluginFile,'utf8');
  if(!source.slice(0,1000).includes('0.9.2.8'))throw Error('Unexpected '+plugin+' version');
  const header=source.slice(source.indexOf('/*:')+3,source.indexOf('*/'));
  const defaults={};
  for(const block of header.split(/\r?\n@param /).slice(1)){
    const name=block.split(/\s/)[0],match=block.match(/(?:^|\n)@default[^\S\r\n]*(.*)/);
    if(match){
      const lines=block.slice(match.index+match[0].indexOf('@default')+8).trimStart().split(/\r?\n/),value=[];
      for(const line of lines){if(line.startsWith('@'))break;value.push(line);}
      defaults[name]=value.join('\n').trim();
    }
  }
  await writeFile(path.join(destination,'defaults.json'),JSON.stringify(defaults,null,2)+'\n');
  records.push({file:path.relative(project,pluginFile).replaceAll('\\','/'),source:archive+'::js/plugins/'+plugin+'.js',sha256:createHash('sha256').update(source).digest('hex')});
  for(const asset of ['bushAlpha.png','errorTexture.png','shadow.png'])records.push({file:`img/${plugin.toUpperCase()}/${asset}`,source:archive+`::img/${plugin.toUpperCase()}/${asset}`,sha256:createHash('sha256').update(await readFile(path.join(project,'img',plugin.toUpperCase(),asset))).digest('hex')});
}
await writeFile(path.join(project,'engine/client/vendor/3d/SOURCE.json'),JSON.stringify({version:'0.9.2.8',author:'Cutievirus',source:'User-provided purchased full-version archives and their matching RPG Maker sample projects.',credit:'MV3D / MZ3D by Cutievirus; Babylon.js and RPG Maker MV/MZ runtime retain their upstream notices.',licenseNotice:'The supplied plugin header requires a Patreon or purchased perpetual license. This repository does not relicense these commercial files. RPG Maker runtime files are from the corresponding user-supplied licensed sample projects. This adapter imports presentation code only; it never starts the RPG Maker game loop.',catalogPackageId:null,catalogNote:'The two 0.9.2.8 sample directories are not in Resources/_asset_index/catalog.jsonl at import time.',files:records},null,2)+'\n');
console.log(`Imported ${records.length} source files for MV3D/MZ3D 0.9.2.8.`);
