import {icon} from './icons.js';
export function createSkillBindings(root) {
  let bindings=[], skills=[];
  const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
  function render() {
    root.replaceChildren();
    root.append(make('h3','绑定技能'),make('p','角色负责原则，技能提供步骤。按需读取；开启“必须使用”后，进入对应流程时由程序加载正文。','binding-hint'));
    const list=make('div',null,'binding-list');
    for(const binding of bindings) {
      const skill=skills.find(s=>s.id===binding.skillId), row=make('div',null,'binding-row'), info=make('div',null,'binding-info');
      info.append(make('strong',skill?.name||'技能已缺失'),make('p',skill?.description||'请移除此绑定。','binding-description'));
      if(skill && !skill.enabled) info.append(make('small','已在技能仓库停用'));
      const controls=make('div',null,'binding-controls'), label=make('label',null,'binding-required'), toggle=make('input');
      toggle.type='checkbox';toggle.className='switch';toggle.checked=binding.required;toggle.setAttribute('aria-label',`必须使用 ${skill?.name||binding.skillId}`);
      toggle.onchange=()=>{binding.required=toggle.checked;};
      label.append(make('span','必须使用'),toggle);
      const remove=make('button',null,'binding-remove');remove.type='button';remove.title=`移除 ${skill?.name||'技能'} 的绑定`;remove.setAttribute('aria-label',remove.title);remove.append(icon('close'));
      remove.onclick=()=>{bindings=bindings.filter(b=>b!==binding);render();};
      controls.append(label,remove);row.append(info,controls);list.append(row);
    }
    if(!bindings.length) list.append(make('p','尚未绑定技能','binding-hint'));
    const add=make('select');add.setAttribute('aria-label','绑定技能');const placeholder=make('option','＋ 绑定技能');placeholder.value='';add.append(placeholder);
    for(const skill of skills.filter(s=>!bindings.some(b=>b.skillId===s.id))) {const option=make('option',`${skill.name}${skill.enabled?'':' · 已停用'}`);option.value=skill.id;add.append(option);}
    add.disabled=add.options.length===1;
    add.onchange=()=>{if(add.value){bindings.push({skillId:add.value,required:false});render();}};
    root.append(list,add,make('p','教学、练习和复习请求自动匹配内置流程。自定义流程可发送 /skill 技能名 明确启动；技能仍遵守仓库总开关。','binding-hint'));
  }
  render();
  return {set(value=[]){bindings=value.map(b=>({...b}));render();},update(value=[]){skills=value;render();},get(){return bindings.map(b=>({...b}));}};
}
