import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,stat} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ProviderStore} from "./providers.mjs";

test("refresh one model preserves siblings; provider deletion removes credential and SDK config",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-provider-management-"));
 try {
  let store;let response=[{id:"one",context_length:32768,reasoning_efforts:["low","high"]},{id:"two",context_length:8192}];
  const keys=new Map(),runtime={getModels:()=>[],getModel:(p,id)=>store.providers.find(m=>m.id===p)?.models.find(m=>m.id===id),refresh:async()=>{},setRuntimeApiKey:async(p,k)=>keys.set(p,k)};
  const crypto={protect:async k=>"encrypted:"+k,unprotect:async k=>k.slice(10)};
  store=new ProviderStore(root,{...crypto,request:async()=>({ok:true,json:async()=>({data:response})})});await store.load();
  const first=await store.save({template:"custom",baseUrl:"http://127.0.0.1:12345/v1",protocol:"openai-completions",key:"test-secret"});await store.discover(first.id,runtime);
  const other=await store.save({template:"custom",baseUrl:"http://127.0.0.1:12346/v1",protocol:"openai-completions"});await store.updateModel(other.id,{id:"other",contextWindow:65536},runtime);
  response=[{id:"one",context_length:262144,reasoning_efforts:["low","high"]}];
  const config=await store.refreshModel(first.id,"one",runtime);assert.equal(config.contextWindow,262144);assert.deepEqual(config.thinkingLevels,["off","low","high"]);assert.equal(first.models.find(m=>m.id==="two").contextWindow,8192);
  await assert.rejects(store.refreshModel(first.id,"missing",runtime),/未返回/);
  await store.remove(first.id,runtime);assert.equal(keys.get(first.id),"");await assert.rejects(stat(join(root,first.id+".dpapi")),{code:"ENOENT"});
  const saved=JSON.parse(await readFile(store.modelsPath,"utf8"));assert.equal(saved.providers[first.id],undefined);assert.ok(saved.providers[other.id]);
  const reload=new ProviderStore(root,crypto);await reload.load();assert.deepEqual(reload.providers.map(p=>p.id),[other.id]);assert.ok(!(await readFile(store.path,"utf8")).includes("test-secret"));
 } finally {await rm(root,{recursive:true,force:true});}
});
