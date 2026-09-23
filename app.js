'use strict';
const $ = id => document.getElementById(id);
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function fmt(s){if(!isFinite(s))return'0:00';const m=Math.floor(s/60),ss=Math.floor(s%60);return`${m}:${ss.toString().padStart(2,'0')}`}
function genId(){return Date.now().toString(36)+Math.random().toString(36).slice(2)}
function toast(msg,dur=2500){const e=$('toast');e.textContent=msg;e.classList.add('show');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('show'),dur)}

const state={tracks:[],idx:-1,playing:false,shuffle:false,repeat:'none',lyrics:[],lyricIdx:-1,muted:false,vol:1,libraryHandle:null};
const audio=new Audio();

/* ── Mobile drawer ── */
function openQueue(){$('sidebar').classList.add('open');$('sbBackdrop').classList.add('vis');}
function closeQueue(){$('sidebar').classList.remove('open');$('sbBackdrop').classList.remove('vis');}
$('mobQBtn').addEventListener('click',openQueue);
$('sbBackdrop').addEventListener('click',closeQueue);

/* ── IndexedDB (settings + song persistence) ── */
function openDB(){
  return new Promise((res,rej)=>{
    const r=indexedDB.open('lyricplayer_v1',2);
    r.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains('kv'))db.createObjectStore('kv');
      if(!db.objectStoreNames.contains('songs')){
        const s=db.createObjectStore('songs',{keyPath:'id'});
        s.createIndex('by_added','addedAt',{unique:false});
      }
    };
    r.onsuccess=e=>res(e.target.result);r.onerror=rej;
  });
}
async function dbGet(key){const db=await openDB();return new Promise((res,rej)=>{const t=db.transaction('kv','readonly');const r=t.objectStore('kv').get(key);r.onsuccess=e=>res(e.target.result);r.onerror=rej;});}
async function dbSet(key,val){const db=await openDB();return new Promise((res,rej)=>{const t=db.transaction('kv','readwrite');t.objectStore('kv').put(val,key);t.oncomplete=res;t.onerror=rej;});}

/* ── Song IDB persistence ── */
async function saveSongToIDB(track){
  try{
    const data=await track.file.arrayBuffer();
    const db=await openDB();
    await new Promise((res,rej)=>{
      const tx=db.transaction('songs','readwrite');
      tx.objectStore('songs').put({id:track.id,title:track.title,artist:track.artist,filename:track.file.name,mimeType:track.file.type||'audio/mpeg',data,lrc:track.lrc||null,stem:track.stem,addedAt:Date.now()});
      tx.oncomplete=res;tx.onerror=rej;
    });
  }catch(e){console.warn('IDB save failed',e);}
}
async function updateSongInIDB(id,updates){
  if(!id)return;
  try{
    const db=await openDB();
    const tx=db.transaction('songs','readwrite');
    const store=tx.objectStore('songs');
    await new Promise((res,rej)=>{
      const req=store.get(id);
      req.onsuccess=e=>{const rec=e.target.result;if(rec){Object.assign(rec,updates);store.put(rec);}res();};
      req.onerror=rej;
    });
  }catch{}
}
async function removeSongFromIDB(id){
  if(!id)return;
  try{
    const db=await openDB();
    await new Promise((res,rej)=>{const tx=db.transaction('songs','readwrite');tx.objectStore('songs').delete(id);tx.oncomplete=res;tx.onerror=rej;});
  }catch{}
}
async function loadSongsFromIDB(){
  try{
    const db=await openDB();
    const records=await new Promise((res,rej)=>{
      const tx=db.transaction('songs','readonly');
      const req=tx.objectStore('songs').index('by_added').getAll();
      req.onsuccess=e=>res(e.target.result);req.onerror=rej;
    });
    if(!records.length)return;
    const startIdx=state.tracks.length;
    for(const r of records){
      const file=new File([r.data],r.filename,{type:r.mimeType});
      state.tracks.push({id:r.id,file,title:r.title,artist:r.artist,dur:'—',artUrl:null,lrc:r.lrc||null,stem:r.stem});
    }
    renderPlaylist();
    if(state.idx===-1)loadTrack(startIdx,false);
    for(let i=0;i<records.length;i++){
      const ti=startIdx+i;if(!state.tracks[ti])continue;
      const url=URL.createObjectURL(state.tracks[ti].file);
      const a=new Audio();a.src=url;
      a.addEventListener('loadedmetadata',()=>{if(state.tracks[ti]){state.tracks[ti].dur=fmt(a.duration);URL.revokeObjectURL(url);renderPlaylist();}});
      parseID3(state.tracks[ti].file).then(meta=>{
        if(!state.tracks[ti])return;
        if(meta.title)state.tracks[ti].title=meta.title;
        if(meta.artist)state.tracks[ti].artist=meta.artist;
        if(meta.artUrl)state.tracks[ti].artUrl=meta.artUrl;
        renderPlaylist();if(ti===state.idx)refreshPlayerUI(ti);
      });
    }
    toast(`Restored ${records.length} track${records.length>1?'s':''} ✓`,2000);
  }catch(e){console.warn('IDB load failed',e);}
}

/* ── Library folder (desktop) ── */
async function ensurePermission(handle){
  const perm=await handle.queryPermission({mode:'readwrite'});
  if(perm==='granted')return true;
  return(await handle.requestPermission({mode:'readwrite'})) ==='granted';
}
async function initLibrary(){
  try{
    const h=await dbGet('libraryHandle');if(!h)return;
    const ok=await ensurePermission(h);if(!ok)return;
    state.libraryHandle=h;showLibStatus(h.name);await loadLibrary();
  }catch{}
}
async function setLibraryFolder(){
  try{
    const h=await window.showDirectoryPicker({mode:'readwrite'});
    state.libraryHandle=h;await dbSet('libraryHandle',h);
    showLibStatus(h.name);toast(`Library: ${h.name}`);await loadLibrary();
  }catch(e){if(e.name!=='AbortError')toast('Could not access folder');}
}
function showLibStatus(name){$('libName').textContent=name;$('libStatus').classList.add('vis');$('folderBtn').classList.add('active');}
async function loadLibrary(){
  if(!state.libraryHandle)return;
  const aExt=/\.(mp3|wav|ogg|flac|m4a|aac|opus|webm)$/i;
  const audioEntries=[],lrcMap={};
  try{
    for await(const[name,h]of state.libraryHandle.entries()){
      if(h.kind!=='file')continue;
      if(aExt.test(name))audioEntries.push({name,h});
      else if(/\.lrc$/i.test(name))lrcMap[name.replace(/\.lrc$/i,'').toLowerCase()]=h;
    }
  }catch{toast('Cannot read library folder');return;}
  audioEntries.sort((a,b)=>a.name.localeCompare(b.name));
  // Skip files already loaded (by filename)
  const existing=new Set(state.tracks.map(t=>t.file.name));
  const newEntries=audioEntries.filter(({name})=>!existing.has(name));
  if(!newEntries.length){toast('Library up to date');return;}
  const startIdx=state.tracks.length;let loaded=0;
  for(const{name,h}of newEntries){
    try{
      const file=await h.getFile();
      const stem=name.replace(/\.[^.]+$/,'');
      const parts=stem.split(' - ');
      const title=parts.length>1?parts.slice(1).join(' - ').trim():stem.trim();
      const artist=parts.length>1?parts[0].trim():'Unknown';
      let lrc=null;const lrcH=lrcMap[stem.toLowerCase()];
      if(lrcH){const lf=await lrcH.getFile();lrc=await lf.text();}
      const id=genId();
      state.tracks.push({id,file,title,artist,dur:'—',artUrl:null,lrc,stem});
      loaded++;
    }catch{}
  }
  if(loaded){
    renderPlaylist();if(state.idx===-1)loadTrack(startIdx,false);
    for(let i=0;i<loaded;i++){
      const ti=startIdx+i;if(!state.tracks[ti])continue;
      const url=URL.createObjectURL(state.tracks[ti].file);
      const a=new Audio();a.src=url;
      a.addEventListener('loadedmetadata',()=>{if(state.tracks[ti]){state.tracks[ti].dur=fmt(a.duration);URL.revokeObjectURL(url);renderPlaylist();}});
      parseID3(state.tracks[ti].file).then(meta=>{
        if(!state.tracks[ti])return;
        if(meta.title)state.tracks[ti].title=meta.title;
        if(meta.artist)state.tracks[ti].artist=meta.artist;
        if(meta.artUrl)state.tracks[ti].artUrl=meta.artUrl;
        renderPlaylist();if(ti===state.idx)refreshPlayerUI(ti);
      });
    }
    toast(`Loaded ${loaded} track${loaded>1?'s':''} from library`);
  }else toast('Library folder is empty');
}
async function saveFileToLibrary(file,filename){
  if(!state.libraryHandle)return;
  try{const fh=await state.libraryHandle.getFileHandle(filename,{create:true});const w=await fh.createWritable();await w.write(file);await w.close();}catch{}
}
async function saveLRCToLibrary(stem,text){
  if(!state.libraryHandle)return;
  try{const fh=await state.libraryHandle.getFileHandle(stem+'.lrc',{create:true});const w=await fh.createWritable();await w.write(text);await w.close();}catch{}
}

/* ── ID3 parser ── */
async function parseID3(file){
  const res={title:null,artist:null,artUrl:null};
  try{
    const buf=await file.slice(0,512*1024).arrayBuffer();
    const u8=new Uint8Array(buf),dv=new DataView(buf);
    if(!(u8[0]===0x49&&u8[1]===0x44&&u8[2]===0x33))return res;
    const ver=u8[3];if(ver<3)return res;
    const flags=u8[5];
    const tagSz=((u8[6]&0x7f)<<21)|((u8[7]&0x7f)<<14)|((u8[8]&0x7f)<<7)|(u8[9]&0x7f);
    let pos=10;
    if(flags&0x40){pos=ver===4?10+(((u8[10]&0x7f)<<21)|((u8[11]&0x7f)<<14)|((u8[12]&0x7f)<<7)|(u8[13]&0x7f)):10+4+dv.getUint32(10);}
    const end=Math.min(10+tagSz,buf.byteLength);
    function readStr(data){
      const enc=data[0],d=data.subarray(1);
      if(enc===0)return new TextDecoder('iso-8859-1').decode(d).replace(/\0/g,'').trim();
      if(enc===3)return new TextDecoder('utf-8').decode(d).replace(/\0/g,'').trim();
      if(enc===1||enc===2){const hasBom=(d[0]===0xff&&d[1]===0xfe)||(d[0]===0xfe&&d[1]===0xff);return new TextDecoder('utf-16').decode(hasBom?d:new Uint8Array([0xff,0xfe,...d])).replace(/\0/g,'').trim();}
      return'';
    }
    while(pos<end-10){
      const id=String.fromCharCode(u8[pos],u8[pos+1],u8[pos+2],u8[pos+3]);
      if(!id.trim()||id[0]==='\0')break;
      const fsz=ver===4?(((u8[pos+4]&0x7f)<<21)|((u8[pos+5]&0x7f)<<14)|((u8[pos+6]&0x7f)<<7)|(u8[pos+7]&0x7f)):dv.getUint32(pos+4);
      if(fsz<=0||pos+10+fsz>buf.byteLength)break;
      const data=u8.subarray(pos+10,pos+10+fsz);
      if(id==='TIT2')res.title=readStr(data)||null;
      if(id==='TPE1')res.artist=readStr(data)||null;
      if(id==='APIC'&&!res.artUrl){
        let i=1;const enc=data[0];let mime='';
        while(i<data.length&&data[i]!==0)mime+=String.fromCharCode(data[i++]);
        i++;i++;
        if(enc===1||enc===2){while(i<data.length-1&&!(data[i]===0&&data[i+1]===0))i+=2;i+=2;}
        else{while(i<data.length&&data[i]!==0)i++;i++;}
        if(i<data.length){const m=mime.includes('png')?'image/png':'image/jpeg';res.artUrl=URL.createObjectURL(new Blob([data.subarray(i)],{type:m}));}
      }
      pos+=10+fsz;
    }
  }catch{}
  return res;
}

/* ── LRC parser ── */
function parseLRC(text){
  const lines=[],meta={};
  for(const raw of text.split('\n')){
    const t=raw.trim();if(!t)continue;
    const mm=t.match(/^\[([a-zA-Z]+):(.+)\]$/);
    if(mm){meta[mm[1].toLowerCase()]=mm[2].trim();continue;}
    const re=/\[(\d{1,2}):(\d{2})[.:](\d{1,3})\]/g;
    const times=[];let m;
    while((m=re.exec(t))!==null)times.push(+m[1]*60+ +m[2]+ +m[3].padEnd(3,'0')/1000);
    if(!times.length)continue;
    const content=t.replace(/\[\d{1,2}:\d{2}[.:]\d{1,3}\]/g,'').trim();
    if(!content)continue;
    for(const ts of times)lines.push({time:ts,text:content});
  }
  return{lines:lines.sort((a,b)=>a.time-b.time),meta};
}

/* ── Render playlist ── */
function renderPlaylist(){
  const pl=$('playlist');
  if(!state.tracks.length){pl.innerHTML='';return;}
  pl.innerHTML=state.tracks.map((t,i)=>{
    const a=i===state.idx,p=a&&state.playing;
    const lrcBadge=t.lrc?'<span class="lrc-badge">LRC</span>':'';
    return`<div class="track${a?' active':''}${p?' playing':''}" data-i="${i}">
      <div class="track-num">${i+1}</div>
      <div class="eq-icon"><div class="eq-b" style="height:3px"></div><div class="eq-b" style="height:8px"></div><div class="eq-b" style="height:5px"></div></div>
      <div class="track-info"><div class="track-title">${esc(t.title)}</div><div class="track-artist">${esc(t.artist)}</div></div>
      <div class="track-meta">${lrcBadge}<div class="track-dur">${t.dur}</div><button class="del-track" data-i="${i}" title="Remove">×</button></div>
    </div>`;
  }).join('');
  pl.querySelectorAll('.track').forEach(el=>el.addEventListener('click',e=>{
    if(e.target.closest('.del-track'))return;
    selectTrack(+el.dataset.i);closeQueue();
  }));
  pl.querySelectorAll('.del-track').forEach(btn=>btn.addEventListener('click',e=>{
    e.stopPropagation();
    const i=+btn.dataset.i;
    const track=state.tracks[i];
    if(track.id)removeSongFromIDB(track.id);
    state.tracks.splice(i,1);
    if(state.idx===i){
      if(!state.tracks.length){
        audio.pause();audio.src='';state.idx=-1;state.lyrics=[];state.lyricIdx=-1;
        renderLyrics();$('pTitle').textContent='No song selected';$('pArtist').textContent='—';
        $('siTitle').textContent='LyricPlayer';$('siArtist').textContent='Drop songs or tap Add Songs';
        $('iPlay').style.display='';$('iPause').style.display='none';
      }else loadTrack(Math.min(i,state.tracks.length-1),state.playing);
    }else if(state.idx>i)state.idx--;
    renderPlaylist();toast('Removed',1500);
  }));
}

/* ── Render lyrics ── */
function renderLyrics(){
  const sc=$('lyrScroll');
  if(!state.lyrics.length){
    sc.innerHTML=`<div class="spacer"></div><div class="no-lyr"><svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><p>No lyrics loaded</p><small>Tap Fetch or load an .lrc file</small></div><div class="spacer"></div>`;
    return;
  }
  const parts=['<div class="spacer"></div>'];
  state.lyrics.forEach((l,i)=>parts.push(`<div class="lyric-line" id="ll${i}" data-i="${i}">${esc(l.text)}</div>`));
  parts.push('<div class="spacer"></div>');
  sc.innerHTML=parts.join('');
  sc.querySelectorAll('.lyric-line').forEach(el=>el.addEventListener('click',()=>{audio.currentTime=state.lyrics[+el.dataset.i].time;if(audio.paused)audio.play();}));
}
function updateLyricHL(idx){
  if(idx===state.lyricIdx)return;
  $('lyrScroll').querySelectorAll('.lyric-line.cur,.lyric-line.p1,.lyric-line.p2,.lyric-line.n1,.lyric-line.n2').forEach(e=>e.classList.remove('cur','p1','p2','n1','n2'));
  state.lyricIdx=idx;if(idx<0)return;
  const set=(i,c)=>{const e=$(`ll${i}`);if(e)e.classList.add(c);};
  set(idx,'cur');set(idx-1,'p1');set(idx-2,'p2');set(idx+1,'n1');set(idx+2,'n2');
  const el=$(`ll${idx}`);if(el)el.scrollIntoView({block:'center',behavior:'smooth'});
}

/* ── Load track ── */
async function loadTrack(idx,play=true){
  if(idx<0||idx>=state.tracks.length)return;
  state.idx=idx;const t=state.tracks[idx];
  if(audio._ou)URL.revokeObjectURL(audio._ou);
  audio._ou=URL.createObjectURL(t.file);audio.src=audio._ou;
  refreshPlayerUI(idx);
  if(t.lrc)applyLRC(t.lrc,false);
  else{state.lyrics=[];state.lyricIdx=-1;renderLyrics();}
  renderPlaylist();
  if(play){state.playing=true;audio.play();}
}
function refreshPlayerUI(idx){
  const t=state.tracks[idx];if(!t)return;
  $('pTitle').textContent=t.title;$('pArtist').textContent=t.artist;
  $('siTitle').textContent=t.title;$('siArtist').textContent=t.artist;
  const img=$('artImg'),ph=document.querySelector('.art-ph');
  if(t.artUrl){img.src=t.artUrl;img.style.display='block';ph.style.display='none';}
  else{img.style.display='none';ph.style.display='flex';}
}
function selectTrack(idx){loadTrack(idx,true);}
function applyLRC(text,save=true){
  const{lines,meta}=parseLRC(text);state.lyrics=lines;state.lyricIdx=-1;
  if(meta.ti){$('siTitle').textContent=meta.ti;$('pTitle').textContent=meta.ti;}
  if(meta.ar){$('siArtist').textContent=meta.ar;$('pArtist').textContent=meta.ar;}
  if(state.idx>=0){
    state.tracks[state.idx].lrc=text;
    updateSongInIDB(state.tracks[state.idx].id,{lrc:text});
  }
  renderLyrics();renderPlaylist();
  if(save&&state.idx>=0&&state.libraryHandle){
    const stem=state.tracks[state.idx].stem||state.tracks[state.idx].title;
    saveLRCToLibrary(stem,text);toast('Lyrics saved to library');
  }else if(save){toast('Lyrics loaded');}
}

/* ── Audio events ── */
audio.addEventListener('play',()=>{state.playing=true;$('iPlay').style.display='none';$('iPause').style.display='';renderPlaylist();});
audio.addEventListener('pause',()=>{state.playing=false;$('iPlay').style.display='';$('iPause').style.display='none';renderPlaylist();});
audio.addEventListener('loadedmetadata',()=>{$('totT').textContent=fmt(audio.duration);if(state.tracks[state.idx]){state.tracks[state.idx].dur=fmt(audio.duration);renderPlaylist();}});
audio.addEventListener('timeupdate',()=>{
  const ct=audio.currentTime,dur=audio.duration||0,pct=dur?(ct/dur)*100:0;
  $('progFill').style.width=pct+'%';$('progThumb').style.left=pct+'%';$('curT').textContent=fmt(ct);
  if(state.lyrics.length){
    let ni=-1;
    for(let i=state.lyrics.length-1;i>=0;i--){if(ct>=state.lyrics[i].time-.04){ni=i;break;}}
    updateLyricHL(ni);
  }
});
audio.addEventListener('ended',()=>{if(state.repeat==='one'){audio.currentTime=0;audio.play();}else skipNext();});

/* ── Playback controls ── */
function togglePlay(){
  if(!state.tracks.length){$('fileIn').click();return;}
  if(state.idx===-1){loadTrack(0);return;}
  audio.paused?audio.play():audio.pause();
}
function skipNext(){
  const n=state.tracks.length;if(!n)return;
  let next=state.shuffle?Math.floor(Math.random()*n):state.idx+1;
  if(next>=n){if(state.repeat==='all')next=0;else return;}
  loadTrack(next,true);
}
function skipPrev(){
  if(audio.currentTime>3){audio.currentTime=0;return;}
  const prev=state.idx-1;
  if(prev<0){if(state.repeat==='all')loadTrack(state.tracks.length-1,true);else audio.currentTime=0;}
  else loadTrack(prev,true);
}
$('playBtn').addEventListener('click',togglePlay);
$('nextBtn').addEventListener('click',skipNext);
$('prevBtn').addEventListener('click',skipPrev);
$('shuffleBtn').addEventListener('click',()=>{state.shuffle=!state.shuffle;$('shuffleBtn').classList.toggle('on',state.shuffle);toast(state.shuffle?'Shuffle on':'Shuffle off');});
const rModes=['none','all','one'];
$('repeatBtn').addEventListener('click',()=>{
  const i=rModes.indexOf(state.repeat);state.repeat=rModes[(i+1)%3];
  const btn=$('repeatBtn');btn.classList.toggle('on',state.repeat!=='none');btn.classList.toggle('repeat1',state.repeat==='one');
  toast(`Repeat: ${state.repeat}`);
});
$('volSlider').addEventListener('input',e=>{state.vol=parseFloat(e.target.value);audio.volume=state.muted?0:state.vol;});
$('muteBtn').addEventListener('click',()=>{state.muted=!state.muted;audio.volume=state.muted?0:state.vol;$('volIcon').style.opacity=state.muted?'.3':'1';});

/* ── Progress bar (mouse + touch) ── */
let dragging=false;
const prog=$('prog');
function seekPct(pct){audio.currentTime=Math.max(0,Math.min(1,pct))*(audio.duration||0);}
function pctFromEvent(e){const r=prog.getBoundingClientRect();const x=(e.touches?e.touches[0].clientX:e.clientX)-r.left;return x/r.width;}
prog.addEventListener('click',e=>seekPct(pctFromEvent(e)));
prog.addEventListener('mousedown',e=>{dragging=true;prog.classList.add('drag');seekPct(pctFromEvent(e));});
document.addEventListener('mouseup',()=>{dragging=false;prog.classList.remove('drag');});
document.addEventListener('mousemove',e=>{if(dragging)seekPct(pctFromEvent(e));});
prog.addEventListener('touchstart',e=>{e.preventDefault();dragging=true;prog.classList.add('drag');seekPct(pctFromEvent(e));},{passive:false});
document.addEventListener('touchend',()=>{dragging=false;prog.classList.remove('drag');});
document.addEventListener('touchmove',e=>{if(dragging){e.preventDefault();seekPct(pctFromEvent(e));}},{passive:false});

/* ── File loading ── */
$('folderBtn').addEventListener('click',setLibraryFolder);
$('libReload').addEventListener('click',async()=>{
  if(!state.libraryHandle)return;
  await loadLibrary();
});
$('addBtn').addEventListener('click',()=>$('fileIn').click());
$('lrcBtn').addEventListener('click',()=>$('lrcIn').click());
$('sbDrop').addEventListener('click',()=>$('fileIn').click());
$('fileIn').addEventListener('change',e=>{addFiles(e.target.files);e.target.value='';});
$('lrcIn').addEventListener('change',e=>{
  const f=e.target.files[0];if(!f)return;
  const r=new FileReader();r.onload=ev=>applyLRC(ev.target.result,true);r.readAsText(f);e.target.value='';
});

async function addFiles(fl){
  const files=Array.from(fl);
  const aExt=/\.(mp3|wav|ogg|flac|m4a|aac|opus|webm|weba)$/i;
  const aFiles=files.filter(f=>f.type.startsWith('audio/')||aExt.test(f.name));
  const lFiles=files.filter(f=>/\.lrc$/i.test(f.name));
  if(lFiles.length&&state.idx>=0){const r=new FileReader();r.onload=e=>applyLRC(e.target.result,true);r.readAsText(lFiles[0]);}
  if(!aFiles.length)return;
  const startIdx=state.tracks.length,wasEmpty=state.idx===-1;
  for(const file of aFiles){
    const name=file.name.replace(/\.[^.]+$/,'');
    const parts=name.split(' - ');
    const title=parts.length>1?parts.slice(1).join(' - ').trim():name.trim();
    const artist=parts.length>1?parts[0].trim():'Unknown';
    const id=genId();
    const track={id,file,title,artist,dur:'—',artUrl:null,lrc:null,stem:name};
    state.tracks.push(track);
    if(state.libraryHandle)saveFileToLibrary(file,file.name);
    saveSongToIDB(track); // persist to IDB
  }
  if(wasEmpty)loadTrack(startIdx,true);else renderPlaylist();
  toast(`Added ${aFiles.length} track${aFiles.length>1?'s':''}`,2000);
  for(let i=0;i<aFiles.length;i++){
    const ti=startIdx+i;
    const url=URL.createObjectURL(aFiles[i]);
    const a=new Audio();a.src=url;
    a.addEventListener('loadedmetadata',()=>{if(state.tracks[ti]){state.tracks[ti].dur=fmt(a.duration);URL.revokeObjectURL(url);renderPlaylist();}});
    parseID3(aFiles[i]).then(meta=>{
      if(!state.tracks[ti])return;
      if(meta.title)state.tracks[ti].title=meta.title;
      if(meta.artist)state.tracks[ti].artist=meta.artist;
      if(meta.artUrl)state.tracks[ti].artUrl=meta.artUrl;
      renderPlaylist();if(ti===state.idx)refreshPlayerUI(ti);
    });
  }
}

/* ── Fetch lyrics (LRCLIB) ── */
async function fetchLyrics(){
  if(state.idx<0){toast('Load a song first');return;}
  const t=state.tracks[state.idx];
  const btn=$('fetchBtn');
  btn.disabled=true;btn.classList.add('loading');
  const origHTML=btn.innerHTML;
  btn.innerHTML=`<svg class="fetch-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Fetching…`;
  try{
    const dur=Math.round(audio.duration||0);
    const artist=t.artist==='Unknown'?'':t.artist;
    const p=new URLSearchParams({artist_name:artist,track_name:t.title});
    if(dur)p.set('duration',dur);
    let data=null;
    let res=await fetch(`https://lrclib.net/api/get?${p}`).catch(()=>null);
    if(res&&res.ok){
      data=await res.json();
    }else{
      const q=encodeURIComponent(`${t.title} ${artist}`.trim());
      res=await fetch(`https://lrclib.net/api/search?q=${q}`).catch(()=>null);
      if(res&&res.ok){
        const results=await res.json();
        data=results.find(r=>r.syncedLyrics)||results.find(r=>r.plainLyrics)||null;
      }
    }
    if(!data){toast('No lyrics found on LRCLIB');return;}
    if(data.syncedLyrics){applyLRC(data.syncedLyrics,true);toast('Synced lyrics fetched ✓');}
    else if(data.plainLyrics){applyPlainAsLRC(data.plainLyrics);}
    else toast('No lyrics in result');
  }catch{toast('Fetch failed — check connection');}
  finally{btn.disabled=false;btn.classList.remove('loading');btn.innerHTML=origHTML;}
}
function applyPlainAsLRC(text){
  const lines=text.split('\n').filter(l=>l.trim());
  if(!lines.length){toast('Empty lyrics');return;}
  const dur=audio.duration||0;
  const step=dur>0?dur/lines.length:3;
  const lrcText=lines.map((l,i)=>{const t=i*step;const m=Math.floor(t/60).toString().padStart(2,'0');const s=(t%60).toFixed(2).padStart(5,'0');return`[${m}:${s}]${l}`;}).join('\n');
  applyLRC(lrcText,true);
  toast(dur>0?'Plain lyrics — sync is approximate':'Plain lyrics loaded');
}
$('fetchBtn').addEventListener('click',fetchLyrics);

/* ── Drag & drop ── */
let dc=0;
document.addEventListener('dragenter',e=>{e.preventDefault();dc++;$('dropOv').classList.add('vis');});
document.addEventListener('dragleave',()=>{dc--;if(dc<=0){dc=0;$('dropOv').classList.remove('vis');}});
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>{e.preventDefault();dc=0;$('dropOv').classList.remove('vis');if(e.dataTransfer.files.length)addFiles(e.dataTransfer.files);});

/* ── Keyboard ── */
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT')return;
  switch(e.key){
    case' ':e.preventDefault();togglePlay();break;
    case'ArrowRight':audio.currentTime=Math.min(audio.duration||0,audio.currentTime+10);break;
    case'ArrowLeft':audio.currentTime=Math.max(0,audio.currentTime-10);break;
    case'ArrowUp':e.preventDefault();audio.volume=Math.min(1,audio.volume+.05);$('volSlider').value=audio.volume;break;
    case'ArrowDown':e.preventDefault();audio.volume=Math.max(0,audio.volume-.05);$('volSlider').value=audio.volume;break;
    case'n':case'N':skipNext();break;
    case'p':case'P':skipPrev();break;
    case'm':case'M':$('muteBtn').click();break;
    case's':case'S':$('shuffleBtn').click();break;
    case'r':case'R':$('repeatBtn').click();break;
  }
});

/* ── Init ── */
if(!('showDirectoryPicker' in window))$('folderBtn').style.display='none';
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));

// Load persisted songs first, then desktop library folder
loadSongsFromIDB().then(()=>initLibrary());
