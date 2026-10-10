import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import {UserConfig} from "./user-config.mjs";
import {ProviderStore} from "./providers.mjs";
import {LazyMcp} from "./mcp.mjs";
test("unified config migrates credentials and preserves concurrent sections across reload",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-config-test-"));try{
 const config=new UserConfig(root);await writeFile(join(root,"providers.json"),JSON.stringify({providers:[{id:"test",models:[]}]}));await writeFile(join(root,"test.dpapi"),"encrypted:old-key");
 const p=new ProviderStore(root,{config,protect:async s=>"encrypted:"+s,unprotect:async s=>s.slice(10)});await p.load();assert.equal(p.keys.get("test"),"old-key");
 await Promise.all([config.set("desktop",{shortcut:"Ctrl+Alt+Space"}),new UserConfig(root).set("security",{readOnly:[root]})]);
 await p.saveKey("test","new-key");const data=JSON.parse(await readFile(config.path,"utf8"));assert.equal(data.desktop.shortcut,"Ctrl+Alt+Space");assert.equal(data.security.readOnly[0],root);assert.equal(data.credentials.test,"encrypted:new-key");
 const reloaded=new ProviderStore(root,{config,unprotect:async s=>s.slice(10)});await reloaded.load();assert.equal(reloaded.keys.get("test"),"new-key");
 }finally{await rm(root,{recursive:true,force:true});}
});
test("MCP remains disconnected at startup; discovers on demand, gates execution and reconnects after idle",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-mcp-test-"));let requests=0,full=false;
 const server=createServer(async(req,res)=>{if(req.method==="DELETE"){res.writeHead(200);res.end();return;}let body="";for await(const c of req)body+=c;const m=JSON.parse(body);requests++;if(m.id===undefined){res.writeHead(202);res.end();return;}
 const result=m.method==="initialize"?{protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"isolated",version:"1"}}:m.method==="tools/list"?{tools:[{name:"echo",description:"isolated",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}}]}:{content:[{type:"text",text:m.params.arguments.text}]};res.setHeader("Content-Type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:m.id,result}));});await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const mcp=new LazyMcp({config:new UserConfig(root),scope:{fullAccess:()=>full,workspace:()=>root},send:()=>{},idleMs:60});try{
 await mcp.load();const id=await mcp.save({name:"test",url:`http://127.0.0.1:${server.address().port}/mcp`});assert.equal(requests,0);assert.equal(mcp.snapshot()[0].connected,false);
 assert.equal((await mcp.discover(id))[0].name,"echo");await assert.rejects(mcp.call(id,"echo",{text:"x"}),/完全文件权限/);full=true;assert.equal((await mcp.call(id,"echo",{text:"verified"})).content[0].text,"verified");await new Promise(r=>setTimeout(r,100));assert.equal(mcp.snapshot()[0].connected,false);assert.equal((await mcp.discover(id))[0].name,"echo");
 await mcp.remove(id);assert.equal(mcp.snapshot().length,0);assert.equal((await mcp.config.read()).mcp.length,0);
 }finally{await mcp.closeAll();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
