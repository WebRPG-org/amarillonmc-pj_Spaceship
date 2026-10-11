// Data-only compatibility for MV message escapes. Never executes plugin JavaScript.
const COLORS = ['#ffffff','#20a0d6','#ff784c','#66cc40','#99ccff','#ccc0ff','#ffffa0','#808080','#c0c0c0','#2080cc','#ff3810','#00a010','#3e9ade','#a098ff','#ffcc20','#000000','#84aaff','#ffff40','#ff2020','#202040','#e08040','#f0c040','#4080c0','#40c0f0','#80ff80','#c08080','#8080ff','#ff80ff','#00a040','#00e060','#a060e0','#c080ff'];
const PARAMS = ['mhp','mmp','atk','def','mat','mdf','agi','luk'];
const RATES = ['hit','eva','cri','cev','mev','mrf','cnt','hrg','mrg','trg','tgr','grd','rec','pha','mcr','tcr','pdr','mdr','fdr','exr'];
const LOOKUPS = { nc:'Classes',ni:'Items',nw:'Weapons',na:'Armors',ns:'Skills',nt:'States',ii:'Items',iw:'Weapons',ia:'Armors',is:'Skills',it:'States',en:'Enemies' };
const NO_ARGUMENT = new Set(['g','fr','fb','fi','playtime','auto','msgreset','lson','lsoff','lsr','lsreset','resetshake','circle','br','{','}','$','.','|','!','>','<','^']);
const limit = (value,min,max,fallback=min) => Number.isFinite(Number(value)) ? Math.min(max,Math.max(min,Number(value))) : fallback;
const bool = (value,fallback=false) => value == null ? fallback : value === true || String(value).toLowerCase() === 'true';
const own = (object,key) => object != null && Object.hasOwn(object,key) ? object[key] : undefined;
const group = value => Number(value).toLocaleString('en-US',{maximumFractionDigits:8});
const databaseEntry = (context,table,id) => own(context.database?.[table] || context[table] || context[table.toLowerCase()],id);
const actorEntry = (context,id) => own(context.actors,id) || databaseEntry(context,'Actors',id);
const partyEntry = (context,id) => {const entry = context.party?.[id-1];return typeof entry === 'object' ? entry : actorEntry(context,entry);};

export function richTextDefaults(config={}) {
  const core=config.messageCore||{}, ext=config.extended1||{}, shake=config.shaking||{};
  return {
    fontFace:core['Font Name CH']||core['Font Name']||'GameFont, sans-serif',fontSize:limit(core['Font Size'],1,160,28),
    fontStep:limit(core['Font Size Change'],1,100,12),fontMin:limit(core['Font Changed Min'],1,160,12),fontMax:limit(core['Font Changed Max'],1,160,96),
    outlineWidth:limit(core['Font Outline'],0,12,4),outlineColor:'rgba(0,0,0,0.5)',color:COLORS[0],
    rows:limit(core['Default Rows'],1,100,4),width:Number(core['Default Width'])||null,
    wordWrap:bool(core['Word Wrapping']),wordWrapSpace:bool(core['Word Wrap Space']),fastForward:bool(core['Enable Fast Forward'],true),
    maintainFont:bool(core['Maintain Font']),namePrefix:core['Name Box Added Text']||'',nameColor:Number(core['Name Box Color'])||0,
    anchorX:ext['Default X']||'center',anchorY:ext['Default Y']||'bottom',
    letterSound:{enabled:bool(ext['Enable Sound'],false),name:ext['Sound Name']||'Cursor1',volume:limit(ext['Sound Volume'],0,100,50),pitch:limit(ext['Sound Pitch'],0,400,100),pitchVariance:limit(ext['Pitch Variance'],0,100,10),pan:limit(ext['Sound Pan'],-100,100,0),panVariance:limit(ext['Pan Variance'],0,100,10),interval:limit(ext['Sound Interval'],0,100,2)},
    shake:{power:Number(shake['Default Shaking Power'])||0.35,max:Number(shake['Default Shaking Max'])||1,wavePower:Number(shake['Default Wave Power'])||0.5,waveMax:Number(shake['Default Wave Max'])||4,slidePower:Number(shake['Default Slide Power'])||0.5,slideMax:Number(shake['Default Slide Max'])||4},
  };
}

// A deliberately small expression grammar for CaseEval and numeric parameters.
// Calls are normalized only if their complete spelling is explicitly supported.
export function evaluateTextExpression(source, context={}) {
  let text=String(source).trim();
  if(text.length>1024)throw new Error('Expression exceeds 1024 characters');
  text=text.replace(/\$gameVariables\.value\(\s*(\d+)\s*\)/g,'v[$1]')
    .replace(/\$gameSwitches\.value\(\s*(\d+)\s*\)/g,'s[$1]')
    .replace(/\$gameActors\.actor\(\s*(\d+)\s*\)\.([A-Za-z]+)(\(\))?/g,(_,id,key)=>`a[${id}].${key}`)
    .replace(/\$gameParty\.gold\(\)/g,'gold');
  const parts=[];let at=0;
  const scanner=/\s*(?:(\d+(?:\.\d*)?|\.\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(v\[\d+\]|s\[\d+\]|a\[\d+\]\.[A-Za-z]+|true\b|false\b|null\b|gold\b)|(&&|\|\||===|!==|==|!=|<=|>=|[()+\-*/%!<>]))/gy;
  while(at<text.length){scanner.lastIndex=at;const match=scanner.exec(text);if(!match)throw new Error(`Unsupported expression near ${text.slice(at,at+24)}`);parts.push(match[1]!==undefined?{value:Number(match[1])}:match[2]!==undefined?{value:match[2].slice(1,-1).replace(/\\(['"\\])/g,'$1')}:match[3]!==undefined?{ref:match[3]}:{op:match[4]});at=scanner.lastIndex;}
  let cursor=0,depth=0;
  const reference=ref=>{let m;if((m=/^([vs])\[(\d+)\]$/.exec(ref)))return own(context[m[1]==='v'?'variables':'switches'],m[2])??(m[1]==='v'?0:false);if((m=/^a\[(\d+)\]\.([A-Za-z]+)$/.exec(ref))){const actor=actorEntry(context,m[1]);const key=m[2]==='maxTp'?'mtp':m[2];if(!['name','nickname','level','classId','hp','mp','tp','mtp',...PARAMS,...RATES].includes(key))throw new Error(`Unsupported actor property ${key}`);const value=own(actor,key);if(value===undefined)throw new Error(`Actor ${m[1]} has no ${key} value`);return value;}return {true:true,false:false,null:null,gold:context.gold??0}[ref];};
  const precedence={'||':1,'&&':2,'==':3,'!=':3,'===':3,'!==':3,'<':4,'>':4,'<=':4,'>=':4,'+':5,'-':5,'*':6,'/':6,'%':6};
  const binary=(op,a,b)=>{switch(op){case '||':return a||b;case '&&':return a&&b;case '==':return a==b;case '!=':return a!=b;case '===':return a===b;case '!==':return a!==b;case '<':return a<b;case '>':return a>b;case '<=':return a<=b;case '>=':return a>=b;case '+':return typeof a==='string'||typeof b==='string'?String(a)+String(b):Number(a)+Number(b);case '-':return a-b;case '*':return a*b;case '/':return a/b;case '%':return a%b;}};
  const expr=(minimum=0)=>{if(++depth>64)throw new Error('Expression nesting limit');const token=parts[cursor++];if(!token)throw new Error('Incomplete expression');let value;if(['!','+','-'].includes(token.op)){const arg=expr(7);value=token.op==='!'?!arg:token.op==='-'?-arg:+arg;}else if(token.op==='('){value=expr();if(parts[cursor++]?.op!==')')throw new Error('Unclosed parentheses');}else if(token.ref)value=reference(token.ref);else if(Object.hasOwn(token,'value'))value=token.value;else throw new Error('Invalid expression');while(parts[cursor]?.op in precedence && precedence[parts[cursor].op]>=minimum){const op=parts[cursor++].op;value=binary(op,value,expr(precedence[op]+1));}depth--;return value;};
  const value=expr();if(cursor!==parts.length||typeof value==='number'&&!Number.isFinite(value))throw new Error('Invalid expression result');return value;
}

function readArgument(text,start) {
  const open=text[start],close={'[':']','<':'>','{':'}'}[open];if(!close)return null;
  let depth=1,quote='';const conditionDepth=[false,true];for(let i=start+1;i<text.length;i++) {const c=text[i];if(quote){if(c===quote&&text[i-1]!=='\\')quote='';continue;}if((c==='"'||c==="'")&&open==='{'&&conditionDepth[depth]){quote=c;continue;}if(c==='?')conditionDepth[depth]=false;if(c===open){depth++;conditionDepth[depth]=true;}if(c===close&&--depth===0)return {value:text.slice(start+1,i),end:i+1,open};}
  return {value:text.slice(start+1),end:text.length,open,invalid:true};
}

function splitConditional(text) {
  let depth=0,quote='',question=-1;
  for(let i=0;i<text.length;i++){const c=text[i];if(quote){if(c===quote&&text[i-1]!=='\\')quote='';continue;}if(question<0&&(c==='"'||c==="'")){quote=c;continue;}if('([{'.includes(c))depth++;if(')]}'.includes(c))depth--;if(!depth&&c==='?'&&question<0)question=i;else if(!depth&&c===':'&&question>=0)return [text.slice(0,question),text.slice(question+1,i),text.slice(i+1)];}
  throw new Error('Expected condition?yes:no');
}

export function parseRichText(source,context={},defaults={}) {
  defaults={...richTextDefaults(),...defaults};
  const tokens=[],diagnostics=[];
  const meta={name:defaults.name||'',nameAlign:'left',nameBackground:0,faceName:defaults.faceName||'',faceIndex:defaults.faceIndex||0,position:defaults.positionType??defaults.position??2,background:defaults.background??0,width:defaults.width,rows:defaults.rows,x:defaults.x??null,y:defaults.y??null,anchorX:defaults.anchorX,anchorY:defaults.anchorY,wordWrap:defaults.wordWrap,fastForward:defaults.fastForward,autoClose:false};
  let style=baseStyle(),sound={...defaults.letterSound},length=0;
  function baseStyle(){return {fontFace:defaults.fontFace,fontSize:defaults.fontSize,color:defaults.color,outlineWidth:defaults.outlineWidth,outlineColor:defaults.outlineColor,bold:false,italic:false,effect:null};}
  const diagnostic=(raw,message)=>{diagnostics.push({code:raw,message});};
  const emit=(text)=>{text=String(text??'');if(!text)return;length+=text.length;if(length>32768)throw new Error('Text expansion exceeds limit');tokens.push({type:'text',text,style:{...style},sound:{...sound}});};
  const need=(entry,label)=>{if(entry===undefined||entry===null)throw new Error(`${label} unavailable`);return entry;};
  const numeric=(value)=>{const result=Number(evaluateTextExpression(expandValues(value),context));if(!Number.isFinite(result))throw new Error('Expected a finite number');return result;};
  function expandValues(text){for(let pass=0;pass<8;pass++){const next=String(text).replace(/\\V\[(\d+)\]/gi,(_,id)=>String(own(context.variables,id)??0));if(next===text)return next;text=next;}return text;}
  const numberArg=(arg)=>numeric(need(arg?.value,'Argument'));
  function parse(text,depth=0){if(depth>12)throw new Error('Text expansion recursion limit');text=String(text??'');for(let i=0;i<text.length;){
    if(text[i]==='<' && /^<(?:WordWrap|br|line break)>/i.test(text.slice(i))){const tag=/^<(WordWrap|br|line break)>/i.exec(text.slice(i));if(tag[1].toLowerCase()==='wordwrap')meta.wordWrap=true;else tokens.push({type:'newline'});i+=tag[0].length;continue;}
    if(text[i]==='\n'){if(meta.wordWrap){if(defaults.wordWrapSpace)emit(' ');}else tokens.push({type:'newline'});i++;continue;}
    if(text[i]==='\f'){tokens.push({type:'page'});i++;continue;}
    if(text[i]!=='\\'&&text[i]!=='\x1b'){let end=i+1;while(end<text.length&&!['\\','\x1b','\n','\f','<'].includes(text[end]))end++;emit(text.slice(i,end));i=end;continue;}
    const start=i++;if(text[i]==='\\'){emit('\\');i++;continue;}
    const found=/^(?:resetshake|shake|wave|slide|circle)/i.exec(text.slice(i))||/^(?:[A-Za-z]+\d*%?|[{}$.|!><^])/.exec(text.slice(i));if(!found){emit(text[start]);continue;}
    const code=found[0].toLowerCase();i+=found[0].length;const arg=NO_ARGUMENT.has(code)?null:readArgument(text,i);if(arg)i=arg.end;const raw=text.slice(start,i);
    try{
      if(arg?.invalid)throw new Error('Unclosed escape parameter');
      if(code==='v'){const id=numberArg(arg);parse(String(own(context.variables,id)??0),depth+1);}
      else if(code==='n'&&arg?.open==='[')emit(need(actorEntry(context,numberArg(arg)),'Actor').name);
      else if(code==='p')emit(need(partyEntry(context,numberArg(arg)),'Party member').name);
      else if(code==='g')emit(context.currencyUnit??context.database?.System?.currencyUnit??'G');
      else if(/^n(?:[dtrc]|[dt][cr]|[dt]?[1-5])?$/.test(code)&&arg?.open==='<'){
        meta.name=expandValues(arg.value);meta.nameAlign=code.endsWith('c')||code.endsWith('3')?'center':code.endsWith('r')||code.endsWith('5')?'right':code.endsWith('2')?'quarter':code.endsWith('4')?'three-quarter':'left';meta.nameBackground=code.startsWith('nd')?1:code.startsWith('nt')?2:0;
      }
      else if(code in LOOKUPS){const entry=need(databaseEntry(context,LOOKUPS[code],numberArg(arg)),`${LOOKUPS[code]} entry`);if(code.startsWith('i'))tokens.push({type:'icon',index:entry.iconIndex||0,style:{...style}});emit(entry.name);}
      else if(['ac','an','af','pc','pn','pf'].includes(code)){const entry=need(code[0]==='a'?actorEntry(context,numberArg(arg)):partyEntry(context,numberArg(arg)),'Actor');if(code[1]==='c')emit(need(databaseEntry(context,'Classes',entry.classId),'Class').name);else if(code[1]==='n')emit(entry.nickname);else {meta.faceName=entry.faceName||'';meta.faceIndex=entry.faceIndex||0;}}
      else if(code==='et')emit(need(context.enemies?.[numberArg(arg)-1],'Troop member').name);
      else if(/^q[iwa]$/.test(code)){const id=numberArg(arg),kind={i:'item',w:'weapon',a:'armor'}[code[1]];const quantity=(context.inventory||[]).filter(entry=>entry.kind===kind&&Number(entry.itemId??entry.id)===id).reduce((total,entry)=>total+Number(entry.quantity??entry.count??1),0);emit(group(quantity));}
      else if(/^[ae](?:lvl|mhp|hp%?|mmp|mp%?|mtp|tp%?|atk|def|mat|mdf|agi|luk|exp|gold|hit|eva|cri|cev|mev|mrf|cnt|hrg|mrg|trg|tgr|grd|rec|pha|mcr|tcr|pdr|mdr|fdr|exr)$/.test(code)){
        const id=numberArg(arg),entry=need(code[0]==='a'?actorEntry(context,id):context.enemies?.[id],'Battler');let key=code.slice(1),percent=key.endsWith('%')||RATES.includes(key);key=key.replace('%','');if(key==='lvl')key='level';let value=own(entry,key);if(value===undefined&&Array.isArray(entry.params)&&PARAMS.includes(key))value=entry.params[PARAMS.indexOf(key)];value=Number(need(value,`Battler ${id} ${key}`));if(code.endsWith('%'))value/=Number(need(entry[`m${key}`],`Maximum ${key}`))||1;emit(percent?`${Math.floor(value*100)}%`:group(value));
      }
      else if(/^compare\d?$/.test(code)){const fields=need(arg?.value,'Comparison').split(':');if(fields.length!==2)throw new Error('Expected x:y');const pairs=[[24,25],[2,0],[14,0],[3,0],[4,0],[0,7],[0,25],[0,13],[0,9],[0,20]],pair=pairs[Number(code.slice(7))||0];style.color=COLORS[pair[numeric(fields[0])>=numeric(fields[1])?0:1]];}
      else if(code==='caseswitch'||code==='caseeval'){const [condition,yes,no]=splitConditional(need(arg?.value,'Conditional'));const result=code==='caseswitch'?Boolean(own(context.switches,numeric(condition))):evaluateTextExpression(expandValues(condition),context);parse(result?yes:no,depth+1);}
      else if(code==='c')style.color=COLORS[Math.floor(numberArg(arg))]||COLORS[0];
      else if(code==='hc'){if(!/^[0-9a-f]{6}$/i.test(arg?.value||''))throw new Error('Expected six-digit RGB color');style.color=`#${arg.value}`;}
      else if(code==='oc'){if(/^\d+$/.test(arg?.value||''))style.outlineColor=COLORS[Number(arg.value)]||COLORS[0];else if(/^(?:#[a-f\d]{3,8}|[a-z]+|rgba?\([\d.,\s]+\))$/i.test(arg?.value||''))style.outlineColor=arg.value;else throw new Error('Invalid outline color');}
      else if(code==='ow')style.outlineWidth=limit(numberArg(arg),0,12);
      else if(code==='i')tokens.push({type:'icon',index:Math.max(0,Math.floor(numberArg(arg))),style:{...style}});
      else if(code==='fs')style.fontSize=limit(numberArg(arg),1,160);
      else if(code==='fn')style.fontFace=need(arg?.value,'Font family');
      else if(code==='fb')style.bold=!style.bold;
      else if(code==='fi')style.italic=!style.italic;
      else if(code==='fr')style=baseStyle();
      else if(code==='{')style.fontSize=Math.min(defaults.fontMax,style.fontSize+defaults.fontStep);
      else if(code==='}')style.fontSize=Math.max(defaults.fontMin,style.fontSize-defaults.fontStep);
      else if(code==='px'||code==='py')tokens.push({type:'position',axis:code[1],value:limit(numberArg(arg),-10000,10000)});
      else if(code==='.'||code==='|'||code==='w')tokens.push({type:'wait',milliseconds:code==='.'?250:code==='|'?1000:limit(numberArg(arg),0,36000)*1000/60});
      else if(code==='!')tokens.push({type:'pause'});
      else if(code==='>'||code==='<')tokens.push({type:'fast',enabled:code==='>'});
      else if(code==='^')meta.autoClose=true;
      else if(code==='$')tokens.push({type:'gold',value:context.gold??0,currency:context.currencyUnit||'G'});
      else if(code==='br')tokens.push({type:'newline'});
      else if(code==='faceindex')meta.faceIndex=Math.floor(limit(numberArg(arg),0,7));
      else if(code==='msgreset'){Object.assign(meta,{width:defaults.width,rows:defaults.rows,x:defaults.x??null,y:defaults.y??null,target:null});}
      else if(['msgposx','msgposy','msgwidth','msgrows'].includes(code)){const key={msgposx:'x',msgposy:'y',msgwidth:'width',msgrows:'rows'}[code];meta[key]=arg?.value.toLowerCase()==='auto'?'auto':numberArg(arg);}
      else if(code==='auto'){meta.width='auto';meta.rows='auto';}
      else if(/^(msg|auto)(event|actor|party|enemy)$/.test(code)){meta.target={kind:code.replace(/^(msg|auto)/,''),id:numberArg(arg)};if(code.startsWith('auto')){meta.width='auto';meta.rows='auto';}}
      else if(code==='dg')emit(group(numberArg(arg)));
      else if(code==='map'){const id=numberArg(arg)||context.mapId;emit(need(databaseEntry(context,'MapInfos',id)||context.maps?.find?.(entry=>entry.id===id),'Map').name);}
      else if(code==='playtime'){const seconds=Math.max(0,Math.floor(context.playtime||0));emit(`${Math.floor(seconds/3600).toString().padStart(2,'0')}:${Math.floor(seconds/60)%60<10?'0':''}${Math.floor(seconds/60)%60}:${String(seconds%60).padStart(2,'0')}`);}
      else if(code==='lson'||code==='lsoff')sound.enabled=code==='lson';
      else if(code==='lsr'||code==='lsreset')sound={...(defaults.resetLetterSound||defaults.letterSound)};
      else if(code==='lsn')sound.name=need(arg?.value,'Sound filename');
      else if(['lsv','lspi','lspiv','lspa','lspav','lsi'].includes(code)){const key={lsv:'volume',lspi:'pitch',lspiv:'pitchVariance',lspa:'pan',lspav:'panVariance',lsi:'interval'}[code];sound[key]=limit(numberArg(arg),key==='pan'?-100:0,key==='pitch'?400:100);}
      else if(code==='resetshake')style.effect=null;
      else if(['shake','wave','slide','circle'].includes(code)){
        const values=arg?arg.value.split(',').map(numeric):[],settings=defaults.shake;
        if(code==='shake'&&![0,1,2,4].includes(values.length)||['wave','slide'].includes(code)&&![0,2].includes(values.length)||code==='circle'&&values.length)throw new Error('Invalid animation parameters');
        const effect={kind:code,xSpeed:0,ySpeed:0,xMax:0,yMax:0};if(code==='circle')Object.assign(effect,{xSpeed:0.1,ySpeed:0.1,xMax:3,yMax:3});else if(code==='shake')Object.assign(effect,{xSpeed:values[0]??settings.power,ySpeed:values[1]??values[0]??settings.power,xMax:values[2]??settings.max,yMax:values[3]??settings.max});else if(code==='wave')Object.assign(effect,{ySpeed:values[0]??settings.wavePower,yMax:values[1]??settings.waveMax});else Object.assign(effect,{xSpeed:values[0]??settings.slidePower,xMax:values[1]??settings.slideMax});for(const key of ['xMax','yMax'])effect[key]=limit(effect[key],0,100);for(const key of ['xSpeed','ySpeed'])effect[key]=limit(effect[key],-100,100);style.effect=effect;
      }
      else throw new Error('Unsupported text escape');
    }catch(error){diagnostic(raw,error.message);emit(raw);}
  }}
  if(String(source??'').length>32768)diagnostic('','Message exceeds 32768 characters; remaining text omitted');
  try{parse(String(source??'').slice(0,32768));}catch(error){diagnostic('',error.message);}
  if(meta.name){const name=parseRichText(`${defaults.namePrefix||''}${meta.name}`,context,{...defaults,name:'',namePrefix:'',color:COLORS[defaults.nameColor]||defaults.color});meta.nameTokens=name.tokens;meta.name=name.plainText;diagnostics.push(...name.diagnostics);}
  if(Number(meta.rows)>0){let row=1;for(const token of tokens){if(token.type==='page')row=1;else if(token.type==='newline'&&++row>Number(meta.rows)){token.type='page';row=1;}}}
  const plainText=tokens.map(token=>token.type==='text'?token.text:token.type==='newline'||token.type==='page'?'\n':'').join('');
  return {tokens,meta,plainText,diagnostics,finalStyle:style,finalSound:sound};
}

function applyStyle(element,style={}) {
  element.style.fontFamily=style.fontFace||'';element.style.fontSize=`${style.fontSize||28}px`;element.style.color=style.color||COLORS[0];
  element.style.fontWeight=style.bold?'bold':'normal';element.style.fontStyle=style.italic?'italic':'normal';
  const width=(style.outlineWidth||0)/2,color=style.outlineColor||'#000';element.style.textShadow=width?`${-width}px 0 ${color}, ${width}px 0 ${color}, 0 ${-width}px ${color}, 0 ${width}px ${color}`:'none';
}

// Rendering owns one timer and the animation handles. Call destroy on dialogue
// replacement, disconnect, or removal of a floating window.
export function renderRichText(element,source,options={}) {
  const parsed=typeof source==='string'?parseRichText(source,options.context,options.defaults):source;
  const document=element.ownerDocument||globalThis.document,instant=!!options.instant;
  const schedule=options.schedule||((fn,delay)=>setTimeout(fn,delay)),cancel=options.cancel||clearTimeout;
  let cursor=0,letter=0,timer=null,destroyed=false,done=false,paused=false,clearPage=false,lineFast=false,soundCount=0,glyphCount=0,lastSoundTime=0;
  const animations=[],charactersByToken=new WeakMap();let currentLine;
  element.replaceChildren();element.classList.add('mv-rich-text');element.style.whiteSpace=parsed.meta.wordWrap?'normal':'pre-wrap';
  const newLine=()=>{currentLine=document.createElement('div');currentLine.className='mv-text-line';element.append(currentLine);};newLine();
  for(const diagnostic of parsed.diagnostics||[])options.onDiagnostic?.(diagnostic);
  function animate(element,effect){if(!effect||!element.animate)return;const {xMax,yMax,xSpeed,ySpeed}=effect;let frames;
    if(effect.kind==='circle')frames=Array.from({length:17},(_,i)=>({transform:`translate(${Math.sin(i*Math.PI/8)*xMax}px, ${Math.cos(i*Math.PI/8)*yMax}px)`}));
    else frames=[{transform:`translate(${-xMax}px, ${-yMax}px)`},{transform:`translate(${xMax}px, ${yMax}px)`},{transform:`translate(${-xMax}px, ${-yMax}px)`}];
    const duration=Math.max(80,Math.min(8000,Math.max(xMax,yMax,1)*4/Math.max(Math.abs(xSpeed),Math.abs(ySpeed),0.01)*1000/60));
    const animation=element.animate(frames,{duration,iterations:Infinity,delay:-glyphCount*47,easing:effect.kind==='shake'?'linear':'ease-in-out'});animations.push(animation);
  }
  function stopTimer(){if(timer!==null){cancel(timer);timer=null;}}
  function queue(delay){stopTimer();timer=schedule(()=>{timer=null;step(false);},delay);}
  function finishMessage(){if(done||destroyed)return;done=true;paused=false;element.classList.remove('mv-text-paused');options.onComplete?.(parsed);}
  function drawCharacter(token,char,fast){const span=document.createElement('span');span.className='mv-text-glyph';span.textContent=char;applyStyle(span,token.style);if(token.style.effect){span.classList.add('mv-text-animated');animate(span,token.style.effect);}currentLine.append(span);glyphCount++;
    if(!fast&&token.sound?.enabled&&char.trim()){soundCount++;const time=options.now?.()??Date.now();if(soundCount>token.sound.interval&&time-lastSoundTime>=45){soundCount=0;lastSoundTime=time;const sound={...token.sound};sound.pitch=limit(sound.pitch+(Math.random()*2-1)*sound.pitchVariance,0,400);sound.pan=limit(sound.pan+(Math.random()*2-1)*sound.panVariance,-100,100);options.onSound?.(sound);}}
  }
  function drawIcon(token){const icon=document.createElement('span');icon.className='mv-text-icon';icon.setAttribute('aria-label',`图标 ${token.index}`);icon.style.backgroundImage='url("/assets/img/system/IconSet.png")';icon.style.backgroundPosition=`${-(token.index%16)*32}px ${-Math.floor(token.index/16)*32}px`;currentLine.append(icon);}
  function step(reveal){if(destroyed||done||paused)return;let operations=0;
    while(cursor<parsed.tokens.length&&operations++<65536){const token=parsed.tokens[cursor];
      if(token.type==='text'){let characters=charactersByToken.get(token);if(!characters){characters=Array.from(token.text);charactersByToken.set(token,characters);}if(letter>=characters.length){cursor++;letter=0;continue;}drawCharacter(token,characters[letter++],instant||reveal||lineFast);if(!instant&&!reveal&&!lineFast){queue(options.charDelay??25);return;}}
      else {cursor++;letter=0;
        if(token.type==='icon')drawIcon(token);
        else if(token.type==='newline'){lineFast=false;newLine();}
        else if(token.type==='position'){if(token.axis==='x'){const run=document.createElement('span');run.className='mv-text-positioned';run.style.position='absolute';run.style.left=`${token.value}px`;currentLine.append(run);currentLine=run;}else {newLine();currentLine.style.position='absolute';currentLine.style.top=`${token.value}px`;}}
        else if(token.type==='fast')lineFast=token.enabled;
        else if(token.type==='gold')options.onGold?.(token.value,token.currency);
        else if(token.type==='wait'&&!instant&&!reveal){queue(token.milliseconds);return;}
        else if(token.type==='pause'||token.type==='page'){if(instant){if(token.type==='page')newLine();continue;}paused=true;clearPage=token.type==='page';element.classList.add('mv-text-paused');options.onPause?.(clearPage?'page':'input');return;}
      }
    }
    if(cursor>=parsed.tokens.length)finishMessage();
  }
  const controller={
    parsed,get done(){return done;},get paused(){return paused;},
    advance(){if(destroyed||done)return false;if(!paused&&parsed.meta.fastForward===false)return true;stopTimer();if(paused){paused=false;element.classList.remove('mv-text-paused');if(clearPage){for(const animation of animations.splice(0))animation.cancel();element.replaceChildren();newLine();clearPage=false;}step(false);}else step(true);return true;},
    finish(){if(destroyed||done)return;stopTimer();step(true);},
    destroy(){destroyed=true;stopTimer();for(const animation of animations.splice(0))animation.cancel();element.classList.remove('mv-text-paused');},
  };
  // Deferring completion allows callers to store the controller before callbacks.
  if(instant)step(true);else queue(0);
  return controller;
}

export function applyMessageLayout(element,meta,{speakerElement,faceElement,resolveTarget}={}) {
  element.classList.add('mv-message-window');element.dataset.background=String(meta.background??0);element.dataset.position=String(meta.position??2);
  for(const key of ['width','minHeight','left','right','top','bottom','transform'])element.style[key]='';
  element.style.width=meta.width==='auto'?'max-content':Number(meta.width)>0?`${limit(meta.width,120,10000)}px`:'';
  element.style.minHeight=meta.rows==='auto'?'0':Number(meta.rows)>0?`${limit(meta.rows,1,100)*36+48}px`:'';
  let {x,y}=meta;if(meta.target){const position=resolveTarget?.(meta.target);if(position){x=position.x;y=position.y;}}
  const hasX=x!==null&&x!==undefined&&x!=='auto'&&Number.isFinite(Number(x)),hasY=y!==null&&y!==undefined&&y!=='auto'&&Number.isFinite(Number(y));
  const anchor=(value,axis)=>typeof value==='number'?-limit(value,0,1)*100:({left:0,top:0,center:-50,right:-100,bottom:-100}[value]??(axis==='x'?-50:-100));
  if(hasX){element.style.left=`${x}px`;element.style.right='auto';}
  if(hasY){element.style.top=`${y}px`;element.style.bottom='auto';}
  element.style.transform=`translate(${hasX?anchor(meta.anchorX,'x'):-50}%,${hasY?anchor(meta.anchorY,'y'):Number(meta.position)===1?-50:0}%)`;
  if(speakerElement){speakerElement.classList.add('mv-message-speaker');speakerElement.dataset.background=String(meta.nameBackground||0);const fraction=({left:0,quarter:.25,center:.5,'three-quarter':.75,right:1}[meta.nameAlign]||0);speakerElement.style.left=`${fraction*100}%`;speakerElement.style.transform=`translateX(${-fraction*100}%)`;if(meta.nameTokens)renderRichText(speakerElement,{tokens:meta.nameTokens.map(token=>({...token,style:{...token.style,effect:null}})),meta:{},diagnostics:[]},{instant:true});else speakerElement.textContent=meta.name||'';}
  if(faceElement){faceElement.hidden=!meta.faceName;faceElement.classList.add('mv-message-face');faceElement.style.backgroundImage=meta.faceName?`url("/assets/img/faces/${encodeURIComponent(meta.faceName)}.png")`:'';const index=Math.floor(limit(meta.faceIndex,0,7));faceElement.style.backgroundPosition=`calc(var(--mv-face-size, 144px) * ${-(index%4)}) calc(var(--mv-face-size, 144px) * ${-Math.floor(index/4)})`;}
}

export async function loadCustomFonts(config={},environment={}) {
  const parameters=config.fonts||config,document=environment.document||globalThis.document,FontFaceClass=environment.FontFace||globalThis.FontFace;
  const files=Array.isArray(parameters)?parameters.map(font=>font.filename):String(parameters['Font Filenames']||'').split(',').map(file=>file.trim()).filter(Boolean);
  const families=Array.isArray(parameters)?parameters.map(font=>font.family):String(parameters['Font Families']||'').split(',').map(family=>family.trim());
  if(!FontFaceClass||!document?.fonts)return files.map(filename=>({filename,error:'Font loading API unavailable'}));
  return Promise.all(files.map(async(filename,index)=>{const family=families[index];try{if(!family)throw new Error('Missing font family');if(/[\\/]/.test(filename)||filename==='..')throw new Error('Font filename must be within fonts directory');const font=new FontFaceClass(family,`url("/assets/fonts/${encodeURIComponent(filename)}")`);await font.load();document.fonts.add(font);return {filename,family,loaded:true};}catch(error){return {filename,family,error:error.message};}}));
}
