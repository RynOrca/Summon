import {readFile, mkdir, copyFile, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {constants} from 'node:fs';

const workflows = {
  teach: /教学|教我|教一下|我要学|想学|学习一下|讲解|teach\b|explain\b/i,
  'practice-generator': /练习|出题|习题|测试我的|practice\b|quiz\b/i,
  'spaced-review': /复习|回顾|间隔|review\b|recall\b/i,
};
export async function installLearningSkills(capabilities) {
  let changed=false;
  for(const name of Object.keys(workflows)) {
    // Seed only missing skills. Software updates never overwrite a user's independent files.
    if(capabilities.state.skills.some(s=>s.name===name)) continue;
    const source=fileURLToPath(new URL(`./skills/${name}/SKILL.md`,import.meta.url));
    const text=await readFile(source,'utf8'), id=`builtin-${name}`, path=join(capabilities.dir,'skills',id);
    await mkdir(path,{recursive:true});
    try {await copyFile(source,join(path,'SKILL.md'),constants.COPYFILE_EXCL);}
    catch(e) {if(e.code!=='EEXIST') throw e;}
    capabilities.state.skills.push({id,name,description:text.match(/^description:\s*(.+)$/m)[1],path,enabled:true,builtin:true});
    changed=true;
  }
  if(changed) await capabilities.persist();
}
export function skillApplies(skill,prompt) {
  const explicit=String(prompt).match(/^\s*\/skill\s+([a-z0-9-]+)(?:\s|$)/i);
  if(explicit) return explicit[1]===skill.name;
  const quoted=String(prompt).match(/(?:使用|启动|执行)\s*`?([a-z0-9-]+)`?/i);
  if(quoted?.[1]===skill.name) return true;
  return !!workflows[skill.name]?.test(String(prompt));
}
export async function prepareRoleSkills(role,capabilities,prompt) {
  const descriptors=[], bodies=[];
  for(const binding of role?.skills || []) {
    const skill=capabilities.state.skills.find(s=>s.id===binding.skillId);
    if(!skill) throw new Error('角色绑定的技能已不存在，请编辑角色移除该绑定');
    const applies=skillApplies(skill,prompt);
    if(!skill.enabled) {
      if(binding.required && applies) throw new Error(`必选技能 ${skill.name} 已停用，请在技能仓库启用后重试`);
      continue;
    }
    descriptors.push({name:skill.name,description:skill.description,path:join(skill.path,'SKILL.md'),required:binding.required});
    if(binding.required && applies) {
      try {
        const path=join(skill.path,'SKILL.md'), info=await lstat(path);
        if(!info.isFile() || info.size>100000) throw new Error('文件无效或超过 100 KB');
        const text=await readFile(path,'utf8');
        if(!text.trim()) throw new Error('正文为空');
        bodies.push(`必选流程：${skill.name}\n来源：${path}\n${text}`);
      } catch(e) {throw new Error(`无法加载必选技能 ${skill.name}：${e.message}`);}
    }
  }
  return descriptors.length ? `角色绑定技能（执行步骤不能越过角色原则、权限或用户当前要求）：\n${JSON.stringify(descriptors)}\n按需技能只列出说明；相关任务执行前用 read 读取对应 SKILL.md。可用 /skill 技能名 明确启动流程。\n${bodies.length?'以下必选正文已由程序加载，当前任务须遵循流程；缺少用户回答时先等待，不编造完成情况。\n'+bodies.join('\n\n'):''}` : '';
}
