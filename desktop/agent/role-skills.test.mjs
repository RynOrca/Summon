import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityStore} from './capabilities.mjs';
import {RoleStore} from './roles.mjs';
import {installLearningSkills,prepareRoleSkills} from './role-skills.mjs';

test('角色绑定保存重载、兼容旧编辑入口、独立正文不被更新覆盖',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'summon-role-skills-'));
  try {
    const store=new CapabilityStore(dir);await installLearningSkills(store);
    const teach=store.state.skills.find(s=>s.name==='teach');
    const roles=new RoleStore(dir);const id=await roles.save({name:'学习导师',system:'一步一步教学',skills:[{skillId:teach.id,required:true}]});
    await roles.select(id);await roles.save({roleId:id,name:'学习导师',system:'遵守教学原则'});
    const loaded=new RoleStore(dir);await loaded.load();assert.deepEqual(loaded.current().skills,[{skillId:teach.id,required:true}]);
    const snapshot=loaded.list();snapshot.roles.find(r=>r.id===id).skills[0].required=false;assert.equal(loaded.current().skills[0].required,true);
    await assert.rejects(loaded.save({name:'bad',system:'',skills:[{skillId:teach.id,required:true},{skillId:teach.id,required:false}]}),/重复/);
    const path=join(teach.path,'SKILL.md');await writeFile(path,'用户独立修改');await installLearningSkills(store);assert.equal(await readFile(path,'utf8'),'用户独立修改');
    assert.equal(store.state.skills.length,3);
    store.state.skills=[];await installLearningSkills(store);assert.equal(await readFile(path,'utf8'),'用户独立修改');
    await loaded.save({roleId:id,name:'学习导师',system:'',skills:[]});assert.deepEqual(loaded.current().skills,[]);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('按需只有元数据，必选仅加载匹配流程，明确命令与停用/丢失正文',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'summon-role-routing-'));
  try {
    const store=new CapabilityStore(dir);await installLearningSkills(store);
    for(const skill of store.state.skills)await writeFile(join(skill.path,'SKILL.md'),`BODY_SENTINEL_${skill.name}`);
    const role={skills:store.state.skills.map(s=>({skillId:s.id,required:true}))};
    let text=await prepareRoleSkills(role,store,'教我矩阵');assert.ok(text.includes('BODY_SENTINEL_teach'));assert.ok(!text.includes('BODY_SENTINEL_practice-generator'));assert.ok(!text.includes('BODY_SENTINEL_spaced-review'));
    text=await prepareRoleSkills(role,store,'你好');assert.ok(!text.includes('BODY_SENTINEL_'));
    text=await prepareRoleSkills(role,store,'/skill spaced-review 矩阵');assert.ok(text.includes('BODY_SENTINEL_spaced-review'));assert.ok(!text.includes('BODY_SENTINEL_teach'));
    role.skills[0].required=false;text=await prepareRoleSkills(role,store,'教我矩阵');assert.ok(text.includes('SKILL.md'));assert.ok(!text.includes('BODY_SENTINEL_teach'));
    role.skills[0].required=true;store.state.skills[0].enabled=false;await assert.rejects(prepareRoleSkills(role,store,'教我矩阵'),/已停用/);
    store.state.skills[0].enabled=true;await rm(join(store.state.skills[0].path,'SKILL.md'));await assert.rejects(prepareRoleSkills(role,store,'教我矩阵'),/无法加载必选/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
