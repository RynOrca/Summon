import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CapabilityStore } from "./capabilities.mjs";
import { LearnerStore } from "./learner.mjs";
import { createLearningTools } from "./learning-tools.mjs";
import { createApprovalGate } from "./approval.mjs";

test("Vault paragraph recall, edits, file boundaries and skill import stay isolated",async()=>{
  const root=await mkdtemp(join(tmpdir(),"summon-learning-"));
  try {
    const data=join(root,"data"),vault=join(root,"vault"),skill=join(root,"skill"); for(const p of [data,vault,skill,join(vault,".obsidian")])await mkdir(p,{recursive:true});
    const note=join(vault,"线性代数.md");await writeFile(note,"# 矩阵\n\n矩阵代表线性变换。\n\n# 复习\n\n通过练习验证理解。\n");await writeFile(join(vault,".obsidian","secret.md"),"矩阵 secret");
    await writeFile(join(skill,"SKILL.md"),"---\nname: test-learning\ndescription: Test learning workflow\n---\nUse examples first.\n");await writeFile(join(skill,"helper.txt"),"support");
    const store=new CapabilityStore(data,{encrypt:async k=>"encrypted:"+k,decrypt:async k=>k.slice(10)});await store.load();await store.configure({vaultPath:vault,key:"isolated-key",webEnabled:true});
    const hits=await store.searchNotes("矩阵");assert.equal(hits[0].path,note);assert.ok(hits.some(h=>h.startLine===3 && h.content.includes("线性变换")));assert.ok(!hits.some(h=>h.path.includes(".obsidian")));
    assert.equal(await store.resolveFile(hits[0].url,root),note);await assert.rejects(store.resolveFile(process.execPath,root));
    await writeFile(join(root,"space note.html"),"<h1>test</h1>"); assert.equal(await store.resolveFile("space%20note.html",root),join(root,"space note.html"));
    const id=await store.importSkill(skill);assert.equal(store.enabledSkills().length,1);assert.equal(await readFile(join(store.enabledSkills()[0],"helper.txt"),"utf8"),"support");await store.toggleSkill(id,false);assert.deepEqual(store.enabledSkills(),[]);
    await writeFile(note,"# 特征值\n\n特征值描述变换。\n");assert.equal((await store.searchNotes("矩阵")).length,0);assert.ok((await store.searchNotes("特征值")).length);
    assert.ok(!(await readFile(store.path,"utf8")).includes("isolated-key"));assert.ok(!(JSON.stringify(store.snapshot())).includes("isolated-key"));
  } finally {await rm(root,{recursive:true,force:true});}
});
test("Learning events require user evidence, deduplicate and rebuild with unknown mastery",async()=>{
  const root=await mkdtemp(join(tmpdir(),"summon-learner-"));try{
    const store=new LearnerStore(root);await store.load();const event={kind:"concept",subject:"矩阵",detail:"学习过矩阵",evidence:"我学过矩阵"};
    await assert.rejects(store.record(event,"test",["什么是矩阵"]),/原话/);assert.equal(store.state.events.length,0);
    assert.equal(await store.record(event,"test",["我学过矩阵，但需要复习"]),true);assert.equal(await store.record(event,"test",["我学过矩阵"]),false);
    const reload=new LearnerStore(root);await reload.load();assert.equal(reload.snapshot().eventCount,1);assert.equal(reload.snapshot().knowledge[0].mastery,null);assert.equal(reload.snapshot().knowledge[0].status,"needs_review");assert.ok(reload.context().includes("我学过矩阵"));
  }finally{await rm(root,{recursive:true,force:true});}
});
test("Tavily tools preserve citations, use private key and request permissions for mutations",async()=>{
  const root=await mkdtemp(join(tmpdir(),"summon-tools-"));try{
    const store=new CapabilityStore(root);store.key="test-key";store.state.webEnabled=true;const tools=new Map(),hooks={};let request;
    const extension=createLearningTools({capabilities:store,currentWorkspace:()=>root,roles:{current:()=>({system:"必须用中文回答"})},send:()=>{},request:async(url,options)=>{request={url,options};return{ok:true,json:async()=>({results:[{title:"test",url:"https://example.com",content:"source",raw_content:"full source"}]})};}});
    extension.extension({registerTool:t=>tools.set(t.name,t),on:(name,fn)=>hooks[name]=fn});
    const result=await tools.get("web_search").execute("test",{query:"test"});assert.ok(result.content[0].text.includes("https://example.com"));assert.equal(request.options.headers.Authorization,"Bearer test-key");assert.equal(JSON.parse(request.options.body).max_results,5);
    assert.ok((await tools.get("current_time").execute()).content[0].text.includes(new Date().getUTCFullYear()));
    const event={prompt:"test",systemPromptOptions:{sections:{}}};await hooks.before_agent_start(event);assert.ok(event.systemPromptOptions.sections.summon_role.includes("必须用中文回答"));
    const original=join(root,"original.txt"),dest=join(root,"copy.txt");await writeFile(original,"isolated");await tools.get("file_manage").execute("test",{action:"copy",path:original,destination:dest});await assert.rejects(tools.get("file_manage").execute("test",{action:"copy",path:original,destination:dest}),/EEXIST/);
    let hook,permission;const gate=createApprovalGate(e=>{permission=e;},1000);gate.extension({on:(_name,fn)=>hook=fn});assert.equal(await hook({toolName:"browser",input:{action:"snapshot"}}),undefined);
    const awaiting=hook({toolName:"browser",toolCallId:"test",input:{action:"click",index:1}});assert.equal(permission.type,"tool_permission_request");gate.decide(permission.requestId,"deny");assert.equal((await awaiting).block,true);extension.close();
  }finally{await rm(root,{recursive:true,force:true});}
});
