import { realpath, lstat, readdir, readFile } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { inside } from "./capabilities.mjs";

export const FILE_TOOLS=["read","write","edit","ls","find","grep"];
const textResult=text=>({content:[{type:"text",text}],details:{}});
export class FileScope {
  constructor({workspace,readOnly,fullAccess=()=>false}) {this.workspace=workspace;this.readOnly=readOnly;this.fullAccess=fullAccess;}
  async roots() {return {write:await realpath(this.workspace()),readOnly:await Promise.all(this.readOnly().map(p=>realpath(p).catch(()=>null))).then(r=>r.filter(Boolean))};}
  async check(input,mutation=false) {
    if(typeof input!=="string" || input.includes("\0") || /(^|[\\/])[^\\/]*:[^\\/]/.test(input.replace(/^[A-Za-z]:/,"")))throw new Error("文件路径无效");
    const roots=await this.roots();let path=resolve(roots.write,input),nearest=path,parts=[];
    while(true) {
      try {nearest=await realpath(nearest);break;}catch(e){if(e.code!=="ENOENT")throw e;const parent=dirname(nearest);if(parent===nearest)throw e;parts.unshift(relative(parent,nearest));nearest=parent;}
    }
    path=resolve(nearest,...parts);
    if(mutation && !this.fullAccess() && (!inside(roots.write,path) || roots.readOnly.some(root=>inside(root,path))))throw new Error("操作被阻止：默认只允许修改当前工作区；此目录只读，可在设置中切换完全文件权限");
    // Do not allow NTFS alternate data streams or device names.
    if(path.replace(/^[A-Za-z]:/,"").includes(":") || /(^|[\\/])(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(path))throw new Error("不支持设备路径或备用数据流");
    return path;
  }
  async entries(input=".",deep=false) {
    const root=await this.check(input),out=[];let count=0;
    async function visit(dir,depth) {
      if(depth>20)return;
      for(const item of await readdir(dir,{withFileTypes:true})) {
        if(++count>10000)throw new Error("目录过大，请缩小检索范围");
        if(item.isSymbolicLink() || [".git","node_modules"].includes(item.name))continue;
        const path=join(dir,item.name);out.push({path,name:relative(root,path),directory:item.isDirectory()});
        if(deep && item.isDirectory())await visit(path,depth+1);
      }
    }
    await visit(root,0);return out;
  }
  extension(pi) {pi.on("tool_call",async event=>{
    if(["bash","powershell"].includes(event.toolName))return{block:true,terminate:true,reason:"未隔离终端已关闭"};
    if(FILE_TOOLS.includes(event.toolName)) {try{await this.check(event.input.path || ".",["write","edit"].includes(event.toolName));}catch(e){return{block:true,terminate:true,reason:e.message};}}
    if(event.toolName==="file_manage") {try{await this.check(event.input.path,event.input.action==="move");if(event.input.destination)await this.check(event.input.destination,true);}catch(e){return{block:true,terminate:true,reason:e.message};}}
  });}
}
export function sandboxTools(scope) {
  const tools=["read","write","edit"].map(name=>{
    const original=({read:createReadToolDefinition,write:createWriteToolDefinition,edit:createEditToolDefinition})[name](scope.workspace());
    return {...original,description:original.description+" 可读取其他目录；默认编辑仅限工作区，知识库和技能目录只读。完全文件权限可跨目录编辑。",async execute(id,input,signal,update,ctx){const path=await scope.check(input.path,name!=="read");if(name==="read" && (await lstat(path)).size>5*1024*1024)throw new Error("读取文件上限 5 MB");return original.execute(id,{...input,path},signal,update,ctx);}};
  });
  tools.push(defineTool({name:"ls",label:"列出目录",description:"列出允许目录的直接子项，不跟随符号链接。",parameters:Type.Object({path:Type.Optional(Type.String())}),async execute(_id,{path="."}){return textResult(JSON.stringify((await scope.entries(path)).slice(0,500),null,2));}}));
  tools.push(defineTool({name:"find",label:"查找文件",description:"在允许目录按文件名查找，pattern 为文件名片段或 * 通配符。",parameters:Type.Object({path:Type.Optional(Type.String()),pattern:Type.String()}),async execute(_id,{path=".",pattern}){const needles=pattern.toLowerCase().split("*").filter(Boolean);return textResult((await scope.entries(path,true)).filter(e=>needles.every(n=>e.name.toLowerCase().includes(n))).slice(0,200).map(e=>e.path).join("\n"));}}));
  tools.push(defineTool({name:"grep",label:"检索文件内容",description:"在允许目录中按字面关键词检索文本，返回文件与行号。不跟随链接。",parameters:Type.Object({path:Type.Optional(Type.String()),pattern:Type.String({minLength:1,maxLength:500})}),async execute(_id,{path=".",pattern},signal){const target=await scope.check(path);const entries=(await lstat(target)).isFile()?[{path:target}]:await scope.entries(target,true);const hits=[];for(const e of entries){if(signal?.aborted)throw new Error("已停止检索");if(e.directory)continue;const file=await scope.check(e.path),info=await lstat(file);if(info.size>1024*1024)continue;const body=await readFile(file,"utf8");if(body.includes("\0"))continue;for(const [i,line] of body.split(/\r?\n/).entries()){if(line.toLowerCase().includes(pattern.toLowerCase()))hits.push(`${file}:${i+1}: ${line.slice(0,600)}`);if(hits.length>=100)return textResult(hits.join("\n"));}}return textResult(hits.join("\n")||"无匹配");}}));
  return tools;
}
