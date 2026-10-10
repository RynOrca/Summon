import {readFile,writeFile,mkdir,rmdir,rename,stat} from "node:fs/promises";
import {join} from "node:path";
export class UserConfig {
  constructor(dir){this.path=join(dir,"user-config.json");this.lock=this.path+".lock";}
  async read(){try{return JSON.parse(await readFile(this.path,"utf8"));}catch(e){if(e.code==="ENOENT")return {version:1};throw e;}}
  async get(key,legacy,fallback){const data=await this.read();if(Object.hasOwn(data,key))return data[key];let value=fallback;try{value=JSON.parse(await readFile(legacy,"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;}await this.set(key,value);return value;}
  async set(key,value){return this.update(data=>{data[key]=value;});}
  async update(work){const end=Date.now()+10000;while(true){try{await mkdir(this.lock);break;}catch(e){if(e.code==="EEXIST" && Date.now()-(await stat(this.lock)).mtimeMs>30000){await rmdir(this.lock).catch(()=>{});continue;}if(e.code!=="EEXIST" || Date.now()>end)throw new Error("配置正在保存，请稍后重试");await new Promise(r=>setTimeout(r,40));}}
    try{const data=await this.read();await work(data);await writeFile(this.path+".tmp",JSON.stringify(data,null,2));await rename(this.path+".tmp",this.path);}finally{await rmdir(this.lock);}}
}
