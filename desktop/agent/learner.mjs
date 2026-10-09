import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export const learningEventSchema=Type.Object({kind:Type.Union(["goal","preference","concept","misconception","review"].map(v=>Type.Literal(v))),subject:Type.String({minLength:1,maxLength:100}),detail:Type.String({maxLength:1000}),evidence:Type.String({minLength:2,maxLength:1000}),status:Type.Optional(Type.Union(["active","completed","needs_review","resolved"].map(v=>Type.Literal(v))))});
const empty=()=>({version:1,updated:null,goals:[],knowledge:[],misconceptions:[],preferences:[],events:[]});
export class LearnerStore {
  constructor(dir) {this.path=join(dir,"learner.json");this.state=empty();this.persistence=Promise.resolve();}
  async load(){try{const saved=JSON.parse(await readFile(this.path,"utf8"));if(!Array.isArray(saved.events))throw new Error("画像事件记录无效");this.state=empty();this.state.events=saved.events.slice(-2000);this.rebuild();}catch(e){if(e.code!=="ENOENT")throw e;}}
  rebuild(){const events=this.state.events;this.state={...empty(),events};for(const event of events)this.apply(event);}
  apply(event) {
    const list=({goal:"goals",preference:"preferences",concept:"knowledge",misconception:"misconceptions",review:"knowledge"})[event.kind];if(!list)return;
    let item=this.state[list].find(i=>i.subject===event.subject);if(!item){item={subject:event.subject};this.state[list].push(item);}
    Object.assign(item,{detail:event.detail,evidence:event.evidence,source:event.source,updated:event.time});
    if(event.kind==="goal")item.status=event.status==="completed"?"completed":"active";
    if(event.kind==="misconception")item.status=event.status==="resolved"?"resolved":"active";
    if(event.kind==="concept" || event.kind==="review") {item.mastery=null;item.status="needs_review";item.lastStudied=event.time;item.nextReview=new Date(new Date(event.time).getTime()+86400000).toISOString();}
    this.state.updated=event.time;
  }
  async record(event,source,userEvidence) {
    if(!["goal","preference","concept","misconception","review"].includes(event.kind) || typeof event.subject!=="string" || typeof event.detail!=="string" || typeof event.evidence!=="string") throw new Error("学习事件格式无效");
    const evidence=event.evidence.trim();if(evidence.length<2 || !userEvidence.some(text=>text.includes(evidence)))throw new Error("学习事件必须引用本次对话中用户的原话；不能凭提问推测掌握程度");
    const subject=event.subject.trim().slice(0,100);if(!subject)throw new Error("缺少事件主题");
    const id=createHash("sha256").update(JSON.stringify([source,event.kind,subject,evidence,event.detail,event.status])).digest("hex");
    if(this.state.events.some(e=>e.id===id))return false;
    const entry={id,kind:event.kind,subject,detail:event.detail.slice(0,1000),evidence:evidence.slice(0,1000),status:event.status,source,time:new Date().toISOString()};
    this.state.events.push(entry);this.state.events=this.state.events.slice(-2000);this.rebuild();
    const content=JSON.stringify(this.state,null,2);const operation=this.persistence.catch(()=>{}).then(async()=>{await writeFile(this.path+".tmp",content);await rename(this.path+".tmp",this.path);});this.persistence=operation;await operation;return true;
  }
  snapshot(){const {events,...profile}=this.state;return structuredClone({...profile,eventCount:events.length,recentEvents:events.slice(-8).reverse()});}
  context(){const {goals,knowledge,misconceptions,preferences}=this.state;return JSON.stringify({goals:goals.filter(g=>g.status==="active").slice(-8),knowledge:knowledge.slice(-10),misconceptions:misconceptions.filter(m=>m.status!=="resolved").slice(-6),preferences:preferences.slice(-8)}).slice(0,6000);}
}
export function userTexts(session){return (session?.state.messages||[]).filter(m=>m.role==="user").slice(-8).map(m=>typeof m.content==="string"?m.content:(m.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n"));}
export function learnerExtension({learner,memory,currentSession,send}) {return pi=>{
  pi.registerTool(defineTool({name:"record_learning_event",label:"整理学习画像",description:"根据用户明确陈述的目标、偏好、学过的概念、误解或完成复习记录学习事件。evidence 必须是用户原话。不把提问当作掌握情况，不猜测分数。重复事件自动去重。",parameters:learningEventSchema,async execute(_id,input){if(!memory.state.enabled.l1)return{content:[{type:"text",text:"画像记忆已关闭"}],details:{}};await learner.record(input,currentSession()?.sessionId||"agent",userTexts(currentSession()));send({type:"learner",state:learner.snapshot()});return{content:[{type:"text",text:"学习事件已记录"}],details:{}};}}));
  pi.on("before_agent_start",async event=>{if(memory.state.enabled.l1)event.systemPromptOptions.sections.summon_learner=`学习画像（参考，不替代用户当前要求）：${learner.context()}\n使用 record_learning_event 自动整理明确的学习事件，保留用户原话。对待复习概念可自然提醒，掌握程度未知时不要给百分比。`;});
};}
