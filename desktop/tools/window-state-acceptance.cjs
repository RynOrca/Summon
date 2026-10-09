// Native geometry checks target only the process started by this harness.
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.SUMMON_PLAYWRIGHT_PATH);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute = promisify(execFile);

async function bounds(pid, hwnd, update, show) {
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SummonBoundsTest {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int h2, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int mode);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[SummonBoundsTest]::SetProcessDPIAware() | Out-Null
$targetHandle = [IntPtr]${hwnd || `(Get-Process -Id ${pid}).MainWindowHandle`}
[uint32]$owner = 0
[SummonBoundsTest]::GetWindowThreadProcessId($targetHandle,[ref]$owner) | Out-Null
if($owner -ne ${pid}) { throw 'Window does not belong to this test instance' }
${update ? `[SummonBoundsTest]::SetWindowPos($targetHandle,[IntPtr]::Zero,${update.x},${update.y},${update.width},${update.height},0x0014) | Out-Null` : ''}
${show ? '[SummonBoundsTest]::ShowWindow($targetHandle,5) | Out-Null' : ''}
$outer = New-Object SummonBoundsTest+Rect
$client = New-Object SummonBoundsTest+Rect
[SummonBoundsTest]::GetWindowRect($targetHandle,[ref]$outer) | Out-Null
[SummonBoundsTest]::GetClientRect($targetHandle,[ref]$client) | Out-Null
@{handle=$targetHandle.ToInt64();x=$outer.Left;y=$outer.Top;width=$client.Right-$client.Left;height=$client.Bottom-$client.Top;outerWidth=$outer.Right-$outer.Left;outerHeight=$outer.Bottom-$outer.Top;visible=[SummonBoundsTest]::IsWindowVisible($targetHandle)} | ConvertTo-Json -Compress
`;
  const output = await execute('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], { windowsHide:true });
  return JSON.parse(output.stdout.trim());
}
function geometry(value) { return {x:value.x,y:value.y,width:value.width,height:value.height}; }

(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(),'summon-window-state-test-'));
  const packageDir = process.env.SUMMON_TEST_PACKAGE;
  const checks = []; let child, browser, page;
  async function start() {
    child = spawn(path.join(packageDir,'Summon.exe'), [], {cwd:packageDir,windowsHide:true,stdio:'ignore',env:{...process.env,SUMMON_TEST_DATA_DIR:data,SUMMON_TEST_WEBVIEW_PORT:'9313'}});
    for(let i=0;i<50;i++) { assert.equal(child.exitCode,null,'test app exited early'); try {browser=await chromium.connectOverCDP('http://127.0.0.1:9313',{timeout:1000});break;}catch{await delay(300);} }
    assert.ok(browser); page=browser.contexts()[0].pages().find(p=>!p.url().includes('settings.html'));
    await page.locator('#status').filter({hasText:'就绪'}).waitFor({timeout:25000});
  }
  async function stop() { if(browser){await browser.close();browser=null;} if(child?.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}await delay(700); }
  try {
    await start();const initial=await bounds(child.pid);
    const adjusted=await bounds(child.pid,initial.handle,{x:160,y:120,width:1040,height:840});
    assert.notDeepEqual(geometry(adjusted),geometry(initial));
    await delay(1300);let saved=JSON.parse(await fs.readFile(path.join(data,'window-state.json'),'utf8')).main;
    assert.deepEqual(geometry(saved),geometry(adjusted));checks.push('拖动/缩放后窗口仍显示时，大小和位置自动落盘');
    await page.evaluate(()=>window.__TAURI__.core.invoke('dismiss'));assert.equal((await bounds(child.pid,initial.handle)).visible,false);
    const reopened=await bounds(child.pid,initial.handle,null,true);assert.deepEqual(geometry(reopened),geometry(adjusted));checks.push('隐藏后重新呼出保持大小和位置');
    // Change once more, wait for autosave, then terminate only our test instance.
    const last=await bounds(child.pid,initial.handle,{x:220,y:150,width:1080,height:860});await delay(1300);
    saved=JSON.parse(await fs.readFile(path.join(data,'window-state.json'),'utf8')).main;assert.deepEqual(geometry(saved),geometry(last));
    await stop();await start();const restored=await bounds(child.pid);
    assert.deepEqual(geometry(restored),geometry(last));checks.push('测试实例异常退出后，下次启动恢复最后调整的大小和位置');
    const artifacts=path.resolve(__dirname,'../../dist/acceptance');await fs.mkdir(artifacts,{recursive:true});await fs.writeFile(path.join(artifacts,'window-state-report.json'),JSON.stringify({checks,data,initial:geometry(initial),last:geometry(last),restored:geometry(restored)},null,2));
    console.log(JSON.stringify({checks,last:geometry(last),restored:geometry(restored),data},null,2));
  } finally {await stop();}
})().catch(e=>{console.error(e);process.exitCode=1;});
