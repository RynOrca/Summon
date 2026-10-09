import { spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Own, isolated Edge profile; starts only when the agent uses the browser.
export class AgentBrowser {
  constructor(dir) { this.dir=dir; this.sequence=0; this.pending=new Map(); }
  async start() {
    if(this.socket?.readyState===1) return;
    const candidates=[process.env.PROGRAMFILES,process.env["PROGRAMFILES(X86)"],process.env.LOCALAPPDATA].filter(Boolean).map(p=>join(p,"Microsoft","Edge","Application","msedge.exe"));
    let executable; for(const path of candidates) { if(await access(path).then(()=>true,()=>false)) { executable=path; break; } }
    if(!executable) throw new Error("未找到 Microsoft Edge，请安装后使用浏览器工具");
    const profile=join(this.dir,`browser-${process.pid}`); await mkdir(profile,{recursive:true});
    this.child=spawn(executable,["--headless=new","--remote-debugging-port=0",`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check","about:blank"],{windowsHide:true,stdio:"ignore"});
    let launchError; this.child.once("error",e=>{launchError=e;});
    try {
      let port;
      for(let i=0;i<100;i++) { if(launchError) throw launchError; if(this.child.exitCode!==null) throw new Error("浏览器启动失败"); try { port=Number((await readFile(join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0]); if(port) break; } catch {} await new Promise(r=>setTimeout(r,100)); }
      if(!port) throw new Error("浏览器启动超时");
      const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(5000)}); const version=await response.json();
      this.socket=new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((res,rej)=>{ const timer=setTimeout(()=>rej(new Error("浏览器连接超时")),5000); this.socket.addEventListener("open",()=>{clearTimeout(timer);res();},{once:true}); this.socket.addEventListener("error",()=>{clearTimeout(timer);rej(new Error("浏览器连接失败"));},{once:true}); });
      this.socket.addEventListener("message",e=>{ const msg=JSON.parse(e.data); const req=this.pending.get(msg.id); if(req) { this.pending.delete(msg.id); clearTimeout(req.timer); msg.error ? req.reject(new Error(msg.error.message)) : req.resolve(msg.result); } });
      const ownedSocket=this.socket;
      this.socket.addEventListener("close",()=>{ if(this.socket && this.socket!==ownedSocket)return; for(const req of this.pending.values()) {clearTimeout(req.timer);req.reject(new Error("浏览器已断开"));} this.pending.clear(); this.sessionId=null; });
      const target=await this.call("Target.createTarget",{url:"about:blank"}); const attached=await this.call("Target.attachToTarget",{targetId:target.targetId,flatten:true}); this.sessionId=attached.sessionId;
      await this.call("Page.enable");
    } catch(e) { this.close(); throw e; }
  }
  call(method,params={}) { const id=++this.sequence; return new Promise((resolve,reject)=>{ const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error("浏览器操作超时"));},15000); this.pending.set(id,{resolve,reject,timer}); this.socket.send(JSON.stringify({id,method,params,...(this.sessionId?{sessionId:this.sessionId}:{})})); }); }
  async evaluate(expression) { const r=await this.call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true}); if(r.exceptionDetails) throw new Error("网页操作失败"); return r.result.value; }
  async run({action,url,index,text}) {
    clearTimeout(this.idleTimer);
    this.idleTimer=setTimeout(()=>this.close(),60000); this.idleTimer.unref();
    await this.start();
    if(action==="navigate") { const u=new URL(url); if(!["http:","https:"].includes(u.protocol) || u.username || u.password) throw new Error("浏览器只接受 HTTP(S) 地址"); const r=await this.call("Page.navigate",{url:u.href}); if(r.errorText) throw new Error(r.errorText); await this.evaluate(`new Promise(resolve => { if(document.readyState==='complete') resolve(); else { addEventListener('load',()=>resolve(),{once:true}); setTimeout(resolve,4000); } })`); }
    if(action==="click" || action==="fill") {
      if(!Number.isInteger(index) || index<1) throw new Error("请使用最近快照中的元素编号");
      await this.evaluate(`(()=>{const e=document.querySelector('[data-summon-element="${index}"]'); if(!e) throw Error('元素已失效，请刷新快照'); ${action==="click" ? "e.click();" : `if(!('value' in e)) throw Error('不是输入框'); const setter=Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')?.set; if(setter) setter.call(e,${JSON.stringify(String(text||"").slice(0,10000))}); else e.value=${JSON.stringify(String(text||"").slice(0,10000))}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));`} return true;})()`);
    }
    if(action==="screenshot") { const r=await this.call("Page.captureScreenshot",{format:"png"}); return {content:[{type:"image",data:r.data,mimeType:"image/png"}],details:{}}; }
    const snapshot=await this.evaluate(`(()=>{const elements=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).slice(0,150); document.querySelectorAll('[data-summon-element]').forEach(e=>e.removeAttribute('data-summon-element')); const controls=elements.map((e,i)=>{e.setAttribute('data-summon-element',String(i+1));return {index:i+1,tag:e.tagName,label:(e.innerText||e.getAttribute('aria-label')||e.placeholder||e.type||'').slice(0,150),href:e.href};}); return {url:location.href,title:document.title,text:document.body.innerText.slice(0,14000),controls};})()`);
    return {content:[{type:"text",text:JSON.stringify(snapshot)}],details:{url:snapshot.url}};
  }
  close() {
    clearTimeout(this.idleTimer);
    const child=this.child, socket=this.socket;
    if(socket?.readyState===1) {
      socket.send(JSON.stringify({id:++this.sequence,method:"Browser.close"}));
      const fallback=setTimeout(()=>child?.kill(),2000); fallback.unref(); child?.once("exit",()=>clearTimeout(fallback));
    } else child?.kill();
    this.socket=null; this.child=null; this.sessionId=null;
  }
}
