import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, copyFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { protectKey, unprotectKey } from "./endpoint.mjs";

export function inside(root, path) { const rel = relative(root, path); return !rel.startsWith("..") && !isAbsolute(rel); }
export function terms(text) { const s = String(text).toLowerCase(); return [...new Set([...(s.match(/[a-z0-9_]{2,}/g) || []), ...(s.match(/[\u3400-\u9fff]+/g) || []).flatMap(v => Array.from({length: Math.max(1,v.length-1)}, (_,i)=>v.slice(i,i+2)))])]; }
async function walk(root, accept, budget = { files:0, bytes:0 }) {
  const found=[];
  async function visit(dir) {
    for (const item of await readdir(dir,{withFileTypes:true})) {
      if (item.isSymbolicLink() || [".git",".obsidian","node_modules"].includes(item.name)) continue;
      const path=join(dir,item.name);
      if(item.isDirectory()) { await visit(path); continue; }
      if(!item.isFile() || !accept(path)) continue;
      const info=await lstat(path); budget.files++; budget.bytes+=info.size;
      if(budget.files>10000 || budget.bytes>100*1024*1024) throw new Error("文件库超过轻量索引上限（1 万文件 / 100 MB），请选择较小的目录");
      found.push({path,size:info.size,mtime:info.mtimeMs});
    }
  }
  await visit(root); return found;
}
export class CapabilityStore {
  constructor(dir,{encrypt=protectKey,decrypt=unprotectKey}={}) { this.dir=dir; this.path=join(dir,"capabilities.json"); this.encrypt=encrypt; this.decrypt=decrypt; this.state={skills:[],vaultPath:null,webEnabled:false,browserEnabled:true}; this.cache=new Map(); this.key=""; }
  async load() { try { Object.assign(this.state,JSON.parse(await readFile(this.path,"utf8"))); } catch(e) { if(e.code!=="ENOENT") throw e; } try { this.key=await this.decrypt(await readFile(join(this.dir,"tavily-key.dpapi"),"utf8")); } catch(e) { if(e.code!=="ENOENT") this.keyError="搜索凭据无法读取，请重新保存"; } }
  snapshot() { return {...this.state,hasSearchKey:!!this.key,keyError:this.keyError}; }
  async persist() { await writeFile(this.path+".tmp",JSON.stringify(this.state,null,2)); await rename(this.path+".tmp",this.path); }
  async configure({vaultPath,webEnabled,browserEnabled,key}) {
    let selectedVault=this.state.vaultPath;
    if(vaultPath!==undefined) { selectedVault=vaultPath ? await realpath(vaultPath) : null; if(selectedVault && !(await lstat(selectedVault)).isDirectory()) throw new Error("请选择笔记目录"); }
    if(key!==undefined && key.trim()) { if(key.length>4096) throw new Error("Key 过长"); const encrypted=await this.encrypt(key.trim()); await writeFile(join(this.dir,"tavily-key.dpapi"),encrypted); this.key=key.trim(); this.keyError=null; }
    if(webEnabled!==undefined) this.state.webEnabled=!!webEnabled;
    if(browserEnabled!==undefined) this.state.browserEnabled=!!browserEnabled;
    if(vaultPath!==undefined) { this.state.vaultPath=selectedVault; this.cache.clear(); }
    await this.persist(); return this.snapshot();
  }
  async importSkill(source) {
    const root=await realpath(source), descriptor=join(root,"SKILL.md");
    const info=await lstat(descriptor); if(!info.isFile() || info.isSymbolicLink() || info.size>100000) throw new Error("请选择包含 SKILL.md 的技能目录");
    const text=await readFile(descriptor,"utf8");
    const name=text.match(/^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || basename(root);
    const description=text.match(/^description:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || "自定义技能";
    if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("技能名称须为小写字母、数字或连字符，最长 64 字符");
    if(this.state.skills.some(s=>s.name===name)) throw new Error("同名技能已导入");
    const files=await walk(root,()=>true,{files:0,bytes:0});
    if(files.length>500 || files.reduce((n,f)=>n+f.size,0)>10*1024*1024) throw new Error("单个技能最多 500 文件 / 10 MB");
    const id=randomUUID(), target=join(this.dir,"skills",id);
    for(const file of files) { const dest=join(target,relative(root,file.path)); await mkdir(resolve(dest,".."),{recursive:true}); await copyFile(file.path,dest); }
    this.state.skills.push({id,name,description:description.slice(0,1000),path:target,enabled:true}); await this.persist(); return id;
  }
  async toggleSkill(id,enabled) { const s=this.state.skills.find(s=>s.id===id); if(!s) throw new Error("技能不存在"); s.enabled=!!enabled; await this.persist(); }
  enabledSkills() { return this.state.skills.filter(s=>s.enabled).map(s=>s.path); }
  async searchNotes(query,limit=4) {
    if(!this.state.vaultPath) return [];
    const root=this.state.vaultPath, files=await walk(root,p=>extname(p).toLowerCase()===".md"), active=new Set(files.map(f=>f.path));
    for(const p of this.cache.keys()) if(!active.has(p)) this.cache.delete(p);
    const needles=terms(query); if(!needles.length) return [];
    const hits=[];
    for(const file of files) {
      if(file.size>1024*1024) continue;
      let entry=this.cache.get(file.path);
      if(!entry || entry.mtime!==file.mtime) {
        const lines=(await readFile(file.path,"utf8")).split(/\r?\n/), chunks=[]; let heading="",start=0;
        for(let i=0;i<=lines.length;i++) {
          if(i===lines.length || /^#{1,6}\s/.test(lines[i]) || (i>start && !lines[i].trim()) || i-start>=30) {
            let first=start,last=i; while(first<last && !lines[first].trim())first++; while(last>first && !lines[last-1].trim())last--;
            const content=lines.slice(first,last).join("\n").trim(); if(content) chunks.push({heading,startLine:first+1,endLine:last,content:content.slice(0,4000)});
            if(i<lines.length && /^#{1,6}\s/.test(lines[i])) heading=lines[i].replace(/^#+\s*/,""); start=i;
          }
        }
        entry={mtime:file.mtime,chunks}; this.cache.set(file.path,entry);
      }
      const name=relative(root,file.path);
      for(const chunk of entry.chunks) { const hay=chunk.content.toLowerCase(),title=(name+" "+chunk.heading).toLowerCase(); const score=needles.reduce((n,t)=>n+(hay.includes(t)?1:0)+(title.includes(t)?3:0),0); if(score) hits.push({...chunk,path:file.path,title:name,score,url:`summon-file:${encodeURIComponent(file.path)}#L${chunk.startLine}`}); }
    }
    return hits.sort((a,b)=>b.score-a.score).slice(0,Math.min(8,Math.max(1,limit)));
  }
  async resolveFile(input,workspace) {
    let raw=String(input); if(raw.startsWith("summon-file:")) raw=decodeURIComponent(raw.slice(12).split("#")[0]); else if(raw.startsWith("file:")) raw=new URL(raw).pathname.replace(/^\/(?=[A-Za-z]:)/,"");
    const path=await realpath(resolve(workspace,raw)), roots=[workspace,this.state.vaultPath,join(this.dir,"attachments")].filter(Boolean);
    if(!roots.some(r=>inside(r,path)) || !(await lstat(path)).isFile()) throw new Error("文件不在当前项目、笔记库或附件目录内");
    if(![".html",".htm",".md",".txt",".pdf",".png",".jpg",".jpeg",".svg",".csv"].includes(extname(path).toLowerCase())) throw new Error("此文件类型不支持直接打开"); return path;
  }
}
