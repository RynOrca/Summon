// Acceptance harness: only launches its own app and uses an isolated data directory.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.SUMMON_PLAYWRIGHT_PATH);

(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'summon-desktop-data-'));
  const packageDir = await require('./isolated-package.cjs')(process.env.SUMMON_TEST_PACKAGE, data);
  const artifacts = path.resolve(__dirname, '../../dist/acceptance'); await fs.mkdir(artifacts, { recursive: true });
  let apiCalls = 0;
  let receivedImage=false;
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'isolated-learning-model', context_length: 65536, supports_reasoning: true, reasoning_efforts: ['off','low','high'] }] })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); apiCalls++;
    if(body.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='image_url'&&b.image_url?.url?.startsWith('data:image/'))))receivedImage=true;
    const lastUser=body.messages.filter(m=>m.role==='user').at(-1); const userText=typeof lastUser?.content==='string'?lastUser.content:(lastUser?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    const memory = body.messages.some(m => JSON.stringify(m.content).includes('记忆整理器'));
    const text = memory ? '{"facts":[{"key":"学习目标","content":"学习线性代数"}],"notes":[],"learningEvents":[{"kind":"goal","subject":"线性代数","detail":"学习线性代数","evidence":"我在学习线性代数","status":"active"}]}' : '这是桌面验收的流式回答。\n\n| 概念 | 含义 |\n| --- | --- |\n| 矩阵 | 线性变换 |\n\n[打开生成的 HTML](preview.html)';
    const delta = (value, finish_reason = null) => ({ id:'desktop-test', object:'chat.completion.chunk', model:body.model, created:1, choices:[{index:0,delta:value,finish_reason}] });
    res.setHeader('content-type','text/event-stream');
    if (!memory && ['PERMISSION_TEST','READONLY_TEST'].includes(userText) && body.messages.at(-1)?.role!=='tool') {
      res.write(`data: ${JSON.stringify(delta({role:'assistant',reasoning_content:'先创建隔离测试文件。'}))}\n\n`);
      res.write(`data: ${JSON.stringify(delta({tool_calls:[{index:0,id:'desktop-write-'+apiCalls,type:'function',function:{name:'write',arguments:JSON.stringify({path:userText==='READONLY_TEST'?'readonly/note.txt':'permission-test.txt',content:'isolated approval evidence'})}}]}))}\n\n`);
      res.write(`data: ${JSON.stringify(delta({},'tool_calls'))}\n\n`);res.end('data: [DONE]\n\n'); return;
    }
    if(!memory && userText==='QUEUE_START') await new Promise(r=>setTimeout(r,1800));
    res.write(`data: ${JSON.stringify(delta({role:'assistant',content:text}))}\n\n`); await new Promise(r=>setTimeout(r,50)); res.write(`data: ${JSON.stringify(delta({},'stop'))}\n\n`); res.write(`data: ${JSON.stringify({ ...delta({}), choices:[], usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120} })}\n\n`); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = 9312;
  const child = spawn(path.join(packageDir, 'Summon.exe'), [], { windowsHide:true, cwd:packageDir, env:{ ...process.env, SUMMON_TEST_DATA_DIR:data, SUMMON_TEST_WEBVIEW_PORT:String(port) }, stdio:'ignore' });
  let browser; const errors = []; const checks = [];
  try {
    for (let n=0;n<50;n++) {
      if (child.exitCode !== null) throw new Error(`Desktop exited ${child.exitCode}: ${await fs.readFile(path.join(packageDir,'startup.log'),'utf8').catch(()=> '')}`);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout:1000 }); break; } catch { await new Promise(resolve => setTimeout(resolve,400)); }
    }
    assert.ok(browser, 'WebView2 debugging endpoint unavailable');
    const context = browser.contexts()[0];
    const main = context.pages().find(p => !p.url().includes('settings.html'));
    main.on('pageerror', e => errors.push(String(e)));
    await main.locator('#status').filter({hasText:'就绪'}).waitFor({timeout:25000}); checks.push('真实宿主成功初始化 PI sidecar');
    assert.equal(await main.locator('#hide-button').count(),1); assert.equal(await main.locator('#memory-button').count(),0);
    await main.locator('#model-button').click(); await main.locator('#models-dialog').waitFor({state:'visible'});
    await main.mouse.click(2,main.viewportSize()?.height || 300); await main.locator('#models-dialog').waitFor({state:'hidden'}); checks.push('点击弹窗外部关闭');
    await main.locator('#model-button').click(); await main.keyboard.press('Escape'); await main.locator('#models-dialog').waitFor({state:'hidden'}); checks.push('Escape 关闭弹窗');
    await main.locator('#settings-button').click(); let settings;
    for (let n=0;n<60;n++) {
      settings = browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('settings.html'));
      if (settings) break;
      const issue = await main.locator('.message-error').allTextContents(); if (issue.length) throw new Error(issue.join('\n'));
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    assert.ok(settings,'独立设置窗口未创建');
    settings.on('pageerror', e => errors.push(String(e)));
    await settings.locator('#shortcut').filter({hasText:/\+/}).waitFor();
    await settings.locator('#shortcut').click(); await settings.keyboard.press('Control+Alt+Shift+F11');
    await settings.locator('#shortcut').filter({hasText:'Ctrl+Alt+Shift+F11'}).waitFor();
    const prefs = JSON.parse(await fs.readFile(path.join(data,'user-config.json'),'utf8')).desktop; assert.equal(prefs.shortcut,'Ctrl+Alt+Shift+F11'); checks.push('按键录入和真实全局快捷键注册');
    await settings.locator('button[data-section="models"]').click();
    await settings.locator('.template-card').filter({hasText:'自定义'}).click();
    const providerGap=await settings.locator('#provider-form').evaluate(e=>e.getBoundingClientRect().top-document.getElementById('templates').getBoundingClientRect().bottom);assert.ok(providerGap>=20);
    await settings.locator('#provider-name').fill('桌面隔离测试');
    await settings.locator('#base-url').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await settings.locator('#discover').click(); await settings.locator('.model-info').filter({hasText:'isolated-learning-model'}).waitFor({timeout:25000});
    assert.ok((await settings.locator('.model-info').textContent()).includes('65,536')); checks.push('提供商卡片配置、模型发现及能力展示');
    const actionAlignment=await settings.locator('.model-info button').first().evaluate(e=>({align:getComputedStyle(e).alignItems,justify:getComputedStyle(e).justifyContent,padding:getComputedStyle(e).paddingTop}));assert.equal(actionAlignment.align,'center');assert.equal(actionAlignment.justify,'center');assert.equal(actionAlignment.padding,'7px');checks.push('供应商表单间距及模型配置按钮居中');
    await settings.screenshot({path:path.join(artifacts,'settings-models.png')});
    await settings.locator('.model-info').getByRole('button',{name:'获取配置',exact:true}).click();
    await settings.locator('#manual-model').filter({hasText:''}).waitFor({state:'visible'});
    assert.equal(await settings.locator('#manual-model').inputValue(),'isolated-learning-model');
    assert.equal(await settings.locator('#manual-context').inputValue(),'65536');assert.equal(await settings.locator('#manual-levels').inputValue(),'low, high');checks.push('获取配置展示上下文与档位，保持当前模型不变');
    const beforeModel=await main.locator('#model-label').innerText();
    await main.locator('#model-button').click();await main.locator('.model-option').first().click();await main.locator('#thinking-step').waitFor({state:'visible'});await main.keyboard.press('Escape');assert.equal(await main.locator('#model-label').innerText(),beforeModel);
    await main.locator('#model-button').click();await main.locator('.model-option').first().click();
    await main.locator('#thinking-level').selectOption('high');await main.locator('#model-apply').click();
    await main.waitForFunction(()=>document.getElementById('model-thinking').textContent.includes('高'));checks.push('模型与思考分步选择，取消不切换，确认后组合展示');
    await main.locator('#status-model').filter({hasText:'isolated-learning-model · high'}).waitFor();
    assert.equal(await main.locator('.compact-button-label').allTextContents().then(a=>a.join(',')),'Model,Role');assert.equal(await main.locator('#model-label').isVisible(),false);
    for (const id of ['model-button','role-button']) { const style=await main.locator('#'+id).evaluate(e=>({border:getComputedStyle(e).borderTopWidth,background:getComputedStyle(e).backgroundColor}));assert.equal(style.border,'0px');assert.equal(style.background,'rgba(0, 0, 0, 0)'); }
    assert.ok((await main.locator('.status-line').evaluate(e=>getComputedStyle(e,'::before').backdropFilter)).includes('blur'));checks.push('窄窗仅模型角色按钮、项目旁布局与就绪行内渐变模糊');
    const fade=await main.locator('.status-line').evaluate(e=>({background:getComputedStyle(e,'::before').backgroundColor,mask:getComputedStyle(e,'::before').maskImage,height:e.getBoundingClientRect().height}));assert.equal(fade.background,'rgb(24, 24, 24)');assert.ok(fade.mask.includes('80%'));assert.ok(fade.height>=36);
    const dragWidth=await main.locator('.drag-space').evaluate(e=>e.getBoundingClientRect().width);assert.ok(dragWidth>=100);
    await main.locator('#prompt').fill('我在学习线性代数'); await main.locator('#send-button').click();
    await main.locator('.prose-chat').filter({hasText:'桌面验收'}).first().waitFor({timeout:25000}); checks.push('主窗口选择思考档位并显示真实流式回答');
    await main.waitForFunction(() => document.getElementById('status').textContent === '就绪');
    assert.equal(await main.locator('.prose-chat table tbody tr').count(),1);
    await main.locator('#token-speed').filter({hasText:/[\d.]+ tok\/s/}).waitFor();
    await main.locator('#context-usage').click(); await main.locator('#context-dialog').waitFor({state:'visible'});
    assert.ok((await main.locator('#context-detail').innerText()).includes('65,536'));
    assert.ok((await main.locator('#compaction-state').innerText()).includes('自动压缩'));await main.locator('#compact-now').click();await main.locator('#compaction-state').filter({hasText:'较短'}).waitFor();
    await main.keyboard.press('Escape'); checks.push('Markdown 表格、上下文圆环与服务端 token 速度');
    const neutralWorkspace=path.join(data,'workspace'); await fs.writeFile(path.join(neutralWorkspace,'preview.html'),'<title>Summon isolated HTML preview</title><h1>Generated HTML preview</h1>');
    assert.equal(await main.locator('a[data-local-file="preview.html"]').count(),1);
    const nativeOpen=await main.evaluate(async()=>{const reply=await new Promise(async(resolve,reject)=>{const off=await window.__TAURI__.event.listen('agent-event',e=>{if(e.payload.id==='native-file-test'){off();e.payload.type==='error'?reject(Error(e.payload.message)):resolve(e.payload);}});await window.__TAURI__.core.invoke('agent_command',{command:{id:'native-file-test',type:'resolve_file',path:'preview.html'}});});await window.__TAURI__.core.invoke('open_local_file',{path:reply.path});return reply.path;});
    assert.equal(nativeOpen,path.join(neutralWorkspace,'preview.html')); checks.push('本地 HTML 链接解析与系统默认应用打开');
    await main.screenshot({path:path.join(artifacts,'chat.png')});
    await settings.locator('button[data-section="memory"]').click();
    await settings.locator('summary').filter({hasText:'背景与其他长期记忆'}).click();
    await settings.locator('#facts').filter({hasText:'学习线性代数'}).waitFor({timeout:15000}); checks.push('Agent 自动整理记忆并在独立设置窗展示');
    await settings.locator('#learner-profile').filter({hasText:'线性代数'}).waitFor(); checks.push('结构化画像与学习事件依据展示');
    await settings.screenshot({path:path.join(artifacts,'settings-memory.png')});
    const vault=path.join(data,'test-vault'),skill=path.join(data,'test-skill'); await fs.mkdir(vault);await fs.mkdir(skill);
    await fs.writeFile(path.join(vault,'线性代数.md'),'# 矩阵\n\n矩阵代表线性变换，复习时可以画图理解。\n');
    await fs.writeFile(path.join(skill,'SKILL.md'),'---\nname: desktop-study\ndescription: Desktop skill test\n---\nTeach with examples.\n');
    async function agentCommand(type,args={}) { return main.evaluate(async({type,args})=>new Promise(async(resolve,reject)=>{const id='desktop-'+Math.random();const off=await window.__TAURI__.event.listen('agent-event',e=>{if(e.payload.id===id){off();e.payload.type==='error'?reject(Error(e.payload.message)):resolve(e.payload);}});await window.__TAURI__.core.invoke('agent_command',{command:{id,type,...args}});}),{type,args}); }
    await agentCommand('configure_capabilities',{vaultPath:vault});await agentCommand('import_skill',{path:skill});
    await settings.locator('button[data-section="vault"]').click();await settings.locator('#vault-query').fill('矩阵');await settings.locator('#vault-search-form button').click();await settings.locator('#vault-results').filter({hasText:'线性变换'}).waitFor();assert.ok((await settings.locator('#vault-results').textContent()).includes('第 3'));
    await settings.screenshot({path:path.join(artifacts,'settings-vault.png')});
    await settings.locator('button[data-section="skills"]').click();const testSkillRow=settings.locator('#skill-list .setting-row').filter({hasText:'desktop-study'});const toggle=testSkillRow.locator('input');await toggle.waitFor();assert.equal(await toggle.isChecked(),true);await toggle.uncheck();
    await settings.waitForFunction(()=>[...document.querySelectorAll('#skill-list .setting-row')].find(r=>r.textContent.includes('desktop-study'))?.querySelector('input')?.checked===false);await testSkillRow.locator('button').click();await settings.locator('#skill-detail').filter({hasText:'Teach with examples'}).waitFor();
    await settings.screenshot({path:path.join(artifacts,'settings-skills.png')}); checks.push('笔记目录检索、原文行号、技能导入启停和正文查看');
    await settings.locator('button[data-section="roles"]').click();
    await settings.locator('#role-name').fill('绑定技能测试');await settings.locator('#role-system').fill('一步一步教学，保持简洁');
    await settings.locator('#role-skills select').selectOption('builtin-teach');
    await settings.locator('#role-skills input.switch').check();
    await settings.locator('#role-form button[type="submit"]').click();
    const roleRow=settings.locator('#role-list .memory-item').filter({hasText:'绑定技能测试'});await roleRow.waitFor();await roleRow.locator('button').first().click();
    assert.equal(await settings.locator('#role-skills input.switch').isChecked(),true);
    await settings.screenshot({path:path.join(artifacts,'settings-role-skills.png')});
    await main.evaluate(()=>document.getElementById('role-button').click());await main.locator('#roles-dialog').waitFor({state:'visible'});const mainRole=main.locator('.role-item').filter({hasText:'绑定技能测试'});await mainRole.locator('button').filter({hasText:'编辑'}).click();
    assert.equal(await main.locator('#role-skills input.switch').isChecked(),true);
    await main.locator('#role-skills select').selectOption('builtin-practice-generator');
    await main.screenshot({path:path.join(artifacts,'main-role-skills.png')});
    await main.locator('#role-save').click();await main.locator('#role-editor').waitFor({state:'hidden'});
    await main.keyboard.press('Escape');await roleRow.locator('button').first().click();
    await settings.locator('#role-skills .binding-row').filter({hasText:'practice-generator'}).waitFor();
    await settings.locator('#role-skills .binding-row').filter({hasText:'practice-generator'}).locator('.binding-remove').click();
    await settings.locator('#role-form button[type="submit"]').click();
    checks.push('角色双入口绑定技能、必选保存回显与移除引用');
    await main.locator('#history-button').click(); await main.locator('.history-item').filter({hasText:'线性代数'}).waitFor();
    assert.equal(await main.locator('.history-section-group > summary').allTextContents().then(a=>a.join(',')),'会话,项目'); checks.push('历史会话与项目分类');
    assert.equal(await main.evaluate(() => getComputedStyle(document.getElementById('transcript')).scrollbarWidth),'none');
    // Kill only this harness's child sidecar, then observe automatic reconnection.
    const native = await require('node:util').promisify(require('node:child_process').execFile)('powershell.exe',['-NoProfile','-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${child.pid}" | Where-Object Name -eq 'node.exe' | Select-Object -ExpandProperty ProcessId`],{windowsHide:true});
    await main.locator('#history-close').click();
    await settings.locator('button[data-section="security"]').click();
    await settings.locator('#approval-mode').selectOption('manual');
    await main.locator('#prompt').fill('PERMISSION_TEST');await main.locator('#send-button').click();
    await main.locator('.permission-actions button').filter({hasText:'允许'}).waitFor({timeout:25000});
    await main.locator('.permission-actions button').filter({hasText:'允许'}).click();
    await main.waitForFunction(()=>document.getElementById('status').textContent==='就绪');
    assert.equal(await main.locator('.permission-actions').count(),0);
    assert.equal(await fs.readFile(path.join(neutralWorkspace,'permission-test.txt'),'utf8'),'isolated approval evidence');
    assert.ok((await main.locator('.thinking').innerText()).includes('先创建隔离测试文件'));
    await main.locator('#activity-button').click();await main.locator('#activity-list').filter({hasText:'write'}).waitFor();
    await main.locator('#activity-list .tool-row-header').first().click();
    await main.screenshot({path:path.join(artifacts,'activity.png')});await main.keyboard.press('Escape');
    checks.push('真实写入审批、决定后按钮移除、思考流与工具历史');
    await settings.locator('#approval-mode').selectOption('auto');
    await main.locator('#prompt').fill('PERMISSION_TEST');await main.locator('#send-button').click();
    await main.locator('.permission').filter({hasText:'自动批准'}).waitFor({timeout:25000});
    await main.waitForFunction(()=>document.getElementById('status').textContent==='就绪');assert.equal(await main.locator('.permission-actions').count(),0);checks.push('自动审批实际执行文件写入，不遗留确认按钮');
    await settings.locator('button[data-section="agent"]').click();await settings.locator('#agent-tool-list').filter({hasText:'current_time'}).waitFor();
    assert.ok((await settings.locator('#agent-mcp').innerText()).includes('未'));checks.push('实际工具与扩展清单、MCP 状态、审批方式切换');
    await main.locator('#prompt').fill('QUEUE_START');await main.locator('#send-button').click();
    await main.locator('#stop-button').waitFor({state:'visible'});assert.equal(await main.locator('#message-mode').count(),0);const speedBounds=await main.locator('#token-speed').boundingBox(),contextBounds=await main.locator('#context-usage').boundingBox();assert.ok(speedBounds.x+speedBounds.width<=contextBounds.x);await main.locator('#prompt').fill('桌面排队测试');
    await main.locator('#send-button').click();await main.getByRole('button',{name:'发送（引导）',exact:true}).click();
    await main.locator('.message-row.user').filter({hasText:'桌面排队测试'}).waitFor({timeout:25000});
    await main.waitForFunction(()=>document.getElementById('status').textContent==='就绪');checks.push('回复期间发送后续消息并记录投递');
    const readonly=path.join(neutralWorkspace,'readonly');await fs.mkdir(readonly);await fs.writeFile(path.join(readonly,'note.txt'),'protected note');
    await settings.locator('button[data-section="security"]').click();
    // The native directory chooser uses frozen Tauri IPC; exercise its submitted command with an isolated directory.
    await agentCommand('add_readonly',{path:readonly}); await settings.locator('.readonly-item').filter({hasText:readonly}).waitFor();
    await main.locator('#prompt').fill('READONLY_TEST');await main.locator('#send-button').click();
    await main.waitForFunction(()=>document.getElementById('status').textContent==='就绪');assert.equal(await fs.readFile(path.join(readonly,'note.txt'),'utf8'),'protected note');
    assert.equal(await main.locator('.permission-actions').count(),0);assert.equal(await main.locator('.tool-row-header').first().evaluate(e=>getComputedStyle(e).fontSize),'11px');
    await settings.locator('.readonly-item button').click();await settings.locator('.readonly-item').waitFor({state:'detached'});checks.push('自定义只读目录添加移除与真实修改拦截、紧凑记录字号');
    const agentPid = Number(native.stdout.trim()); assert.ok(agentPid>0, 'test sidecar PID required');
    const disconnected = main.evaluate(() => new Promise(resolve => { window.__TAURI__.event.listen('agent-event', event => { if (event.payload.type === 'disconnected') resolve(true); }); }));
    await new Promise(resolve=>setTimeout(resolve,100)); process.kill(agentPid); await disconnected;
    await main.locator('#status').filter({hasText:'就绪'}).waitFor({timeout:25000});
    await main.evaluate(async () => { await window.__TAURI__.core.invoke('agent_command',{command:{id:'acceptance-state',type:'get_state'}}); });
    await main.locator('.prose-chat').filter({hasText:'桌面验收'}).first().waitFor(); checks.push('sidecar 中断后自动重启并恢复历史');
    await settings.locator('button[data-section="models"]').click();
    await agentCommand('new_session',{noProject:true});await main.locator('#prompt').fill('ARCHIVE_TEST');await main.locator('#send-button').click();await main.waitForFunction(()=>document.getElementById('status').textContent==='就绪');
    await main.locator('#history-button').click();let conversation=main.locator('.history-conversation').filter({hasText:'ARCHIVE_TEST'});
    assert.equal(await main.locator('#history-copy').count(),0);await conversation.waitFor();const looseGroup=main.locator('details[data-group="sessions"]');await looseGroup.locator(':scope > summary').click();assert.equal(await conversation.isVisible(),false);await agentCommand('list_sessions');assert.equal(await looseGroup.evaluate(e=>e.open),false);await looseGroup.locator(':scope > summary').click();await conversation.waitFor();
    assert.equal(await conversation.locator('.history-action').first().innerText(),'');assert.equal(await conversation.locator('.history-action svg').count(),2);await main.screenshot({path:path.join(artifacts,'history-icons.png')});
    await conversation.getByRole('button',{name:'归档',exact:true}).click();await conversation.waitFor({state:'detached'});
    await main.locator('#history-archives').click();await main.getByRole('button',{name:'恢复',exact:true}).waitFor();await main.getByRole('button',{name:'恢复',exact:true}).click();await main.getByRole('button',{name:'恢复',exact:true}).waitFor({state:'detached'});
    await main.locator('#history-archives').click();await main.locator('.history-conversation').filter({hasText:'ARCHIVE_TEST'}).getByRole('button',{name:'删除',exact:true}).click();await main.getByRole('button',{name:'确认删除',exact:true}).click();
    await main.locator('.history-item').filter({hasText:'线性代数'}).click();checks.push('会话归档、恢复与两步确认删除界面');
    await settings.locator('button[data-section="mcp"]').click();assert.equal(await settings.locator('#mcp-stdio-fields').isVisible(),false);await settings.locator('#mcp-transport').selectOption('stdio');assert.equal(await settings.locator('#mcp-http-fields').isVisible(),false);await settings.locator('#mcp-transport').selectOption('http');await settings.locator('#mcp-name').fill('按需隔离服务器');await settings.locator('#mcp-url').fill('http://127.0.0.1:1/mcp');await settings.locator('#mcp-form button[type="submit"]').click();
    await settings.locator('#mcp-list').filter({hasText:'按需隔离服务器'}).waitFor();assert.ok((await settings.locator('#mcp-list').innerText()).includes('按需连接'));await settings.screenshot({path:path.join(artifacts,'settings-mcp.png')});checks.push('MCP 设置保存后保持未连接，避免启动时加载');
    await settings.locator('button[data-section="models"]').click();
    await settings.locator('.model-info').getByRole('button',{name:'编辑',exact:true}).click();await settings.locator('#manual-vision').check();await settings.locator('#manual-save').click();await settings.locator('#notice').filter({hasText:'模型信息已保存'}).waitFor();
    await main.locator('#prompt').fill('IMAGE_TEST');await main.evaluate(data=>{const transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],'clipboard.png',{type:'image/png'}));document.getElementById('prompt').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));},(await fs.readFile(path.resolve(__dirname,'../src-tauri/icons/icon.png'))).toString('base64'));await main.locator('#attachment-strip img').waitFor();await main.locator('#send-button').click();await main.waitForFunction(()=>document.getElementById('status').textContent==='就绪');assert.ok(receivedImage);
    await main.getByRole('button',{name:'查看图片',exact:true}).click();await main.locator('#image-dialog').waitFor({state:'visible'});assert.ok((await main.locator('#image-preview').getAttribute('src')).startsWith('data:image/png;base64,'));await main.keyboard.press('Escape');await main.locator('#image-dialog').waitFor({state:'hidden'});checks.push('视觉能力保存立即生效，剪贴板图片发送与点击预览');
    const deleteProvider=settings.locator('.provider-row').filter({hasText:'桌面隔离测试'}).locator('button').filter({hasText:'删除'});
    await deleteProvider.click();assert.equal(await settings.locator('.provider-row').count(),1);await deleteProvider.filter({hasText:'确认删除'}).click();
    await settings.locator('.provider-row').waitFor({state:'detached'});assert.ok((await main.locator('.message-row.user').count())>0);checks.push('供应商两步确认删除，当前模型安全退回，对话历史保留');
    assert.deepEqual(errors,[]); assert.ok(apiCalls >= 2);
    await fs.writeFile(path.join(artifacts,'report.json'),JSON.stringify({checks,errors,data,apiCalls,packageDir},null,2));
    console.log(JSON.stringify({checks,errors,artifacts,data},null,2));
  } catch (error) {
    if (browser) {
      for (const [i, page] of browser.contexts().flatMap(c=>c.pages()).entries()) {
        console.error('Failed page', page.url(), await page.locator('body').innerText().catch(()=>''));
        await page.screenshot({path:path.join(artifacts,`failure-${i}.png`)}).catch(()=>{});
      }
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    child.kill(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    // Preserve isolated data and screenshots for review, never delete user data.
  }
})().catch(error => { console.error(error); process.exitCode=1; });
