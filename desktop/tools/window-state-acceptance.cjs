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

async function bounds(pid, hwnd, update, show, capture) {
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
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr r);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int a,int b,int c,int d);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr r,int x,int y);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr r);
}
'@
[SummonBoundsTest]::SetProcessDPIAware() | Out-Null
$targetHandle = [IntPtr]${hwnd === "settings" ? `[IntPtr]::Zero` : hwnd || `(Get-Process -Id ${pid}).MainWindowHandle`}
[uint32]$owner = 0
${hwnd === "settings" ? `$candidate=[SummonBoundsTest]::GetTopWindow([IntPtr]::Zero); while($candidate -ne [IntPtr]::Zero){ [SummonBoundsTest]::GetWindowThreadProcessId($candidate,[ref]$owner) | Out-Null; if($owner -eq ${pid} -and [SummonBoundsTest]::IsWindowVisible($candidate)){ $r=New-Object SummonBoundsTest+Rect; [SummonBoundsTest]::GetWindowRect($candidate,[ref]$r) | Out-Null; if($r.Right-$r.Left -gt 700){$targetHandle=$candidate;break;} }; $candidate=[SummonBoundsTest]::GetWindow($candidate,2) }; if($targetHandle -eq [IntPtr]::Zero){throw 'Owned settings window unavailable'}` : ''}
[SummonBoundsTest]::GetWindowThreadProcessId($targetHandle,[ref]$owner) | Out-Null
if($owner -ne ${pid}) { throw 'Window does not belong to this test instance' }
${update ? `[SummonBoundsTest]::SetWindowPos($targetHandle,[IntPtr]::Zero,${update.x},${update.y},${update.width},${update.height},0x0014) | Out-Null` : ''}
${show ? '[SummonBoundsTest]::ShowWindow($targetHandle,5) | Out-Null' : ''}
$outer = New-Object SummonBoundsTest+Rect
$client = New-Object SummonBoundsTest+Rect
[SummonBoundsTest]::GetWindowRect($targetHandle,[ref]$outer) | Out-Null
[SummonBoundsTest]::GetClientRect($targetHandle,[ref]$client) | Out-Null
${capture ? `Add-Type -AssemblyName System.Drawing; $bitmap=New-Object System.Drawing.Bitmap(($outer.Right-$outer.Left),($outer.Bottom-$outer.Top)); $graphics=[System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($outer.Left,$outer.Top,0,0,$bitmap.Size); $bitmap.Save('${capture.replace(/'/g,"''")}',[System.Drawing.Imaging.ImageFormat]::Png); $graphics.Dispose(); $bitmap.Dispose()` : ''}
$region = [SummonBoundsTest]::CreateRectRgn(0,0,0,0)
$regionKind = [SummonBoundsTest]::GetWindowRgn($targetHandle,$region)
$cornerInside = [SummonBoundsTest]::PtInRegion($region,0,0)
$centerInside = [SummonBoundsTest]::PtInRegion($region,50,50)
[SummonBoundsTest]::DeleteObject($region) | Out-Null
@{regionKind=$regionKind;cornerInside=$cornerInside;centerInside=$centerInside;caption=([SummonBoundsTest]::GetWindowLong($targetHandle,-16) -band 0x00C00000);handle=$targetHandle.ToInt64();x=$outer.Left;y=$outer.Top;width=$client.Right-$client.Left;height=$client.Bottom-$client.Top;outerWidth=$outer.Right-$outer.Left;outerHeight=$outer.Bottom-$outer.Top;visible=[SummonBoundsTest]::IsWindowVisible($targetHandle)} | ConvertTo-Json -Compress
`;
  const output = await execute('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], { windowsHide:true });
  return JSON.parse(output.stdout.trim());
}
async function gesture(pid,hwnd,from,to) {
  const script=`Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class SummonPointerTest {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
}
'@
[uint32]$owner=0; [SummonPointerTest]::GetWindowThreadProcessId([IntPtr]${hwnd},[ref]$owner) | Out-Null; if($owner -ne ${pid}){throw 'Unowned test window'}
[SummonPointerTest]::SetProcessDPIAware() | Out-Null
$original=New-Object SummonPointerTest+Point; [SummonPointerTest]::GetCursorPos([ref]$original) | Out-Null
try { [SummonPointerTest]::SetCursorPos(${from.x},${from.y}) | Out-Null; $hit=New-Object SummonPointerTest+Point; [SummonPointerTest]::GetCursorPos([ref]$hit) | Out-Null; [SummonPointerTest]::GetWindowThreadProcessId([SummonPointerTest]::GetAncestor([SummonPointerTest]::WindowFromPoint($hit),2),[ref]$owner) | Out-Null; if($owner -ne ${pid}){throw 'Pointer is outside owned test window'}; [SummonPointerTest]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 300; [SummonPointerTest]::SetCursorPos(${to.x},${to.y}) | Out-Null; Start-Sleep -Milliseconds 300; }
finally { [SummonPointerTest]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 200; [SummonPointerTest]::SetCursorPos($original.X,$original.Y) | Out-Null }
`;
  await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true});await delay(700);
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
    const nativeArtifacts=path.resolve(__dirname,'../../dist/acceptance');await fs.mkdir(nativeArtifacts,{recursive:true});
    await start();const initial=await bounds(child.pid,undefined,undefined,undefined,path.join(nativeArtifacts,'native-main.png'));
    assert.equal(initial.outerWidth,initial.width);assert.equal(initial.outerHeight,initial.height);assert.ok(initial.regionKind>0 && !initial.cornerInside && initial.centerInside);checks.push('主窗口无系统标题栏，原生区域裁剪圆角');
    await page.locator('#settings-button').click();let settings;
    for(let i=0;i<30;i++){settings=browser.contexts()[0].pages().find(p=>p.url().includes('settings.html'));if(settings)break;await delay(200);}
    assert.ok(settings);await settings.locator('#shortcut').waitFor();
    const settingsHandle='settings';
    const settingsBounds=await bounds(child.pid,settingsHandle,undefined,undefined,path.join(nativeArtifacts,"native-settings.png"));assert.equal(settingsBounds.outerWidth,settingsBounds.width);assert.equal(settingsBounds.outerHeight,settingsBounds.height);assert.ok(settingsBounds.regionKind>0 && !settingsBounds.cornerInside && settingsBounds.centerInside);checks.push('设置窗口无系统标题栏，原生区域裁剪圆角');
    await settings.locator('#close').click();
    const scale=await page.evaluate(()=>window.devicePixelRatio);
    const dragFrom={x:Math.round(initial.x+initial.width/2),y:Math.round(initial.y+42*scale)};
    await gesture(child.pid,initial.handle,dragFrom,{x:dragFrom.x+40,y:dragFrom.y+30});const dragged=await bounds(child.pid,initial.handle);
    assert.equal(dragged.x,initial.x+40);assert.equal(dragged.y,initial.y+30);checks.push('无标题栏顶部空白区真实鼠标拖动');
    const resizeFrom={x:dragged.x+dragged.outerWidth-3,y:dragged.y+Math.round(dragged.outerHeight/2)};
    await gesture(child.pid,initial.handle,resizeFrom,{x:resizeFrom.x+60,y:resizeFrom.y});const resized=await bounds(child.pid,initial.handle);
    assert.equal(resized.outerWidth,dragged.outerWidth+60);checks.push('窗口边缘真实鼠标缩放');

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
