import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {FileScope,sandboxTools} from "./sandbox.mjs";
import {createApprovalGate} from "./approval.mjs";

test("external reads, workspace writes, readonly roots and full access use canonical paths",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-scope-"));
 try {
  const workspace=join(root,"work"),outside=join(root,"outside"),vault=join(workspace,"vault");
  for(const p of [workspace,outside,vault])await mkdir(p,{recursive:true});
  const external=join(outside,"read.txt");await writeFile(external,"external evidence");
  await symlink(outside,join(workspace,"escape"),"junction");
  let full=false;const scope=new FileScope({workspace:()=>workspace,readOnly:()=>[vault],fullAccess:()=>full});
  assert.equal(await scope.check(external),external);
  await assert.rejects(scope.check(join(workspace,"escape","new.txt"),true),/操作被阻止/);
  await assert.rejects(scope.check("../outside/new.txt",true),/操作被阻止/);
  await assert.rejects(scope.check(join(vault,"new.txt"),true),/只读/);
  const tools=sandboxTools(scope),read=tools.find(t=>t.name==="read"),write=tools.find(t=>t.name==="write");
  assert.match(JSON.stringify(await read.execute("r",{path:external})),/external evidence/);
  await assert.rejects(write.execute("w",{path:external,content:"wrong"}),/操作被阻止/);
  await write.execute("w",{path:"local.txt",content:"allowed"});assert.equal(await readFile(join(workspace,"local.txt"),"utf8"),"allowed");
  full=true;await write.execute("w",{path:external,content:"full"});assert.equal(await readFile(external,"utf8"),"full");
  await write.execute("w",{path:join(vault,"full.txt"),content:"full"});
  for(const invalid of ["file.txt:secret","NUL.txt","a\0b"])await assert.rejects(scope.check(invalid,true));
 } finally {await rm(root,{recursive:true,force:true});}
});

test("scope blocks before either approval policy; manual outcomes remove pending requests",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-policy-"));
 try {
  const scope=new FileScope({workspace:()=>root,readOnly:()=>[]});let guard;
  scope.extension({on:(_e,fn)=>guard=fn});
  for(const mode of ["auto","manual"]) {
   const events=[];let approve;const gate=createApprovalGate(e=>events.push(e),1000,()=>mode);gate.extension({on:(_e,fn)=>approve=fn});
   const external={toolName:"write",input:{path:join(root,"..","outside.txt")}};
   const blocked=await guard(external);assert.equal(blocked.block,true);assert.equal(events.length,0);
   assert.equal((await guard({toolName:"bash",input:{command:"echo hi"}})).block,true);
   const event={toolName:"write",input:{path:join(root,"local.txt")}};assert.equal(await guard(event),undefined);
   const pending=approve(event);
   if(mode==="manual"){assert.equal(events[0].type,"tool_permission_request");gate.decide(events[0].requestId,"allow");assert.throws(()=>gate.decide(events[0].requestId,"allow"));}
   assert.equal(await pending,undefined);assert.equal(events.at(-1).type,"tool_permission_result");
  }
 } finally {await rm(root,{recursive:true,force:true});}
});
