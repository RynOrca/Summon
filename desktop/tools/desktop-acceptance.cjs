// Acceptance harness: only launches its own app and uses an isolated data directory.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.SUMMON_PLAYWRIGHT_PATH);

(async () => {
  const packageDir = process.env.SUMMON_TEST_PACKAGE;
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'summon-desktop-data-'));
  const artifacts = path.resolve(__dirname, '../../dist/acceptance'); await fs.mkdir(artifacts, { recursive: true });
  let apiCalls = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'isolated-learning-model', context_length: 65536, supports_reasoning: true, reasoning_efforts: ['off','low','high'] }] })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); apiCalls++;
    const memory = body.messages.some(m => JSON.stringify(m.content).includes('记忆整理器'));
    const text = memory ? '{"facts":[{"key":"学习目标","content":"学习线性代数"}],"notes":[]}' : '这是桌面验收的流式回答。';
    const delta = (value, finish_reason = null) => ({ id:'desktop-test', object:'chat.completion.chunk', model:body.model, created:1, choices:[{index:0,delta:value,finish_reason}] });
    res.setHeader('content-type','text/event-stream'); res.write(`data: ${JSON.stringify(delta({role:'assistant',content:text}))}\n\n`); res.write(`data: ${JSON.stringify(delta({},'stop'))}\n\n`); res.end('data: [DONE]\n\n');
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
    assert.equal(await main.locator('#hide-button,#memory-button').count(),0);
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
    const prefs = JSON.parse(await fs.readFile(path.join(data,'desktop-prefs.json'),'utf8')); assert.equal(prefs.shortcut,'Ctrl+Alt+Shift+F11'); checks.push('按键录入和真实全局快捷键注册');
    await settings.locator('button[data-section="models"]').click();
    await settings.locator('.template-card').filter({hasText:'自定义'}).click();
    await settings.locator('#provider-name').fill('桌面隔离测试');
    await settings.locator('#base-url').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await settings.locator('#discover').click(); await settings.locator('.model-info').filter({hasText:'isolated-learning-model'}).waitFor({timeout:25000});
    assert.ok((await settings.locator('.model-info').textContent()).includes('65,536')); checks.push('提供商卡片配置、模型发现及能力展示');
    await settings.screenshot({path:path.join(artifacts,'settings-models.png')});
    await settings.locator('.model-info button').click();
    await main.locator('#thinking-level option[value="high"]').waitFor({state:'attached'});
    await main.locator('#thinking-level').selectOption('high');
    await main.locator('#prompt').fill('我在学习线性代数'); await main.locator('#send-button').click();
    await main.locator('.prose-chat').filter({hasText:'桌面验收'}).waitFor({timeout:25000}); checks.push('主窗口选择思考档位并显示真实流式回答');
    await main.waitForFunction(() => document.getElementById('status').textContent === '就绪');
    await main.screenshot({path:path.join(artifacts,'chat.png')});
    await settings.locator('button[data-section="memory"]').click();
    await settings.locator('#facts').filter({hasText:'学习线性代数'}).waitFor({timeout:15000}); checks.push('Agent 自动整理记忆并在独立设置窗展示');
    await settings.screenshot({path:path.join(artifacts,'settings-memory.png')});
    await main.locator('#history-button').click(); await main.locator('.history-item').filter({hasText:'线性代数'}).waitFor();
    assert.equal(await main.locator('.history-section').allTextContents().then(a=>a.join(',')),'会话,项目'); checks.push('历史会话与项目分类');
    assert.equal(await main.evaluate(() => getComputedStyle(document.getElementById('transcript')).scrollbarWidth),'none');
    // Kill only this harness's child sidecar, then observe automatic reconnection.
    const native = await require('node:util').promisify(require('node:child_process').execFile)('powershell.exe',['-NoProfile','-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${child.pid}" | Where-Object Name -eq 'node.exe' | Select-Object -ExpandProperty ProcessId`],{windowsHide:true});
    const agentPid = Number(native.stdout.trim()); assert.ok(agentPid>0, 'test sidecar PID required');
    const disconnected = main.evaluate(() => new Promise(resolve => { window.__TAURI__.event.listen('agent-event', event => { if (event.payload.type === 'disconnected') resolve(true); }); }));
    await new Promise(resolve=>setTimeout(resolve,100)); process.kill(agentPid); await disconnected;
    await main.locator('#status').filter({hasText:'就绪'}).waitFor({timeout:25000});
    await main.evaluate(async () => { await window.__TAURI__.core.invoke('agent_command',{command:{id:'acceptance-state',type:'get_state'}}); });
    await main.locator('.prose-chat').filter({hasText:'桌面验收'}).waitFor(); checks.push('sidecar 中断后自动重启并恢复历史');
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
