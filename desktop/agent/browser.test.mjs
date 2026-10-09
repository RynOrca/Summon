import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBrowser } from "./browser.mjs";
test("Owned lazy Edge can read, fill, click and screenshot an isolated page",{timeout:30000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"summon-browser-test-"));
  const server=createServer((_req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.end('<title>Summon isolated browser</title><h1>Browser test</h1><input aria-label="Test input"><button onclick="document.querySelector(\'h1\').textContent=document.querySelector(\'input\').value">Apply</button>');});
  await new Promise(r=>server.listen(0,"127.0.0.1",r));const browser=new AgentBrowser(root);
  try{
    assert.equal(browser.child,undefined);
    const first=JSON.parse((await browser.run({action:"navigate",url:`http://127.0.0.1:${server.address().port}`})).content[0].text);assert.equal(first.title,"Summon isolated browser");assert.ok(first.text.includes("Browser test"));
    const input=first.controls.find(c=>c.tag==="INPUT"),button=first.controls.find(c=>c.tag==="BUTTON");assert.ok(input && button);
    await browser.run({action:"fill",index:input.index,text:"Verified local browser"});const result=await browser.run({action:"click",index:button.index});assert.ok(result.content[0].text.includes("Verified local browser"));
    const screenshot=await browser.run({action:"screenshot"});assert.equal(screenshot.content[0].mimeType,"image/png");assert.ok(screenshot.content[0].data.length>100);
  }finally{browser.close();await new Promise(r=>server.close(r));await new Promise(r=>setTimeout(r,600));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});
