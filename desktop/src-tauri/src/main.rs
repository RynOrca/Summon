#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewWindowBuilder, WebviewUrl, WindowEvent,
};
use tauri_plugin_global_shortcut::{ShortcutState, GlobalShortcutExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use std::{
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Mutex, Arc},
    thread,
};

const BOUNDS: StateFlags = StateFlags::SIZE.union(StateFlags::POSITION);

struct AgentProcess {
    child: Child,
    stdin: ChildStdin,
    errors: Arc<Mutex<Vec<String>>>,
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct AgentState(Mutex<Option<AgentProcess>>);
#[derive(Default)]
struct ShortcutStateStore(Mutex<String>);

fn preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_directory(app)?.join("desktop-prefs.json"))
}

fn data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Isolated desktop acceptance runs never read or modify the user's agent data.
    if let Some(path) = std::env::var_os("SUMMON_TEST_DATA_DIR") { return Ok(PathBuf::from(path)); }
    app.path().app_data_dir().map_err(|error| error.to_string())
}

fn read_preferences(app: &tauri::AppHandle) -> serde_json::Value {
    preferences_path(app).ok().and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({"shortcut":"Alt+Shift+C","autostart":false}))
}

fn save_preferences(app: &tauri::AppHandle, value: &serde_json::Value) -> Result<(), String> {
    let path = preferences_path(app)?;
    std::fs::create_dir_all(path.parent().ok_or("Invalid preferences path")?).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    std::fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_preferences(app: tauri::AppHandle, state: tauri::State<'_, ShortcutStateStore>) -> serde_json::Value {
    let mut prefs = read_preferences(&app);
    prefs["activeShortcut"] = state.0.lock().map(|value| value.clone()).unwrap_or_default().into();
    prefs
}

#[tauri::command]
fn set_shortcut(app: tauri::AppHandle, state: tauri::State<'_, ShortcutStateStore>, shortcut: String) -> Result<String, String> {
    let requested = shortcut.trim();
    if requested.is_empty() || requested.len() > 64 || !requested.is_ascii() {
        return Err("请输入有效的快捷键，例如 Ctrl+Alt+Space".into());
    }
    let mut current = state.0.lock().map_err(|_| "Shortcut lock failed")?;
    if *current != requested {
        app.global_shortcut().register(requested).map_err(|error| format!("快捷键不可用或已被占用：{error}"))?;
        if !current.is_empty() { let _ = app.global_shortcut().unregister(current.as_str()); }
        *current = requested.to_owned();
    }
    let mut prefs = read_preferences(&app);
    prefs["shortcut"] = requested.into();
    save_preferences(&app, &prefs)?;
    Ok(current.clone())
}

#[cfg(windows)]
fn apply_autostart(enabled: bool) -> Result<(), String> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let mut command = Command::new("reg.exe");
    if enabled {
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        command.args(["add", key, "/v", "Summon", "/t", "REG_SZ", "/d"])
            .arg(format!("\"{}\" --autostart", exe.display())).arg("/f");
    } else {
        let existing = Command::new("reg.exe").args(["query", key, "/v", "Summon"])
            .output().map_err(|error| error.to_string())?;
        if !existing.status.success() { return Ok(()); }
        command.args(["delete", key, "/v", "Summon", "/f"]);
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("设置开机自启失败：{}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}

#[cfg(not(windows))]
fn apply_autostart(_enabled: bool) -> Result<(), String> { Err("开机自启目前仅支持 Windows".into()) }

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    apply_autostart(enabled)?;
    let mut prefs = read_preferences(&app);
    prefs["autostart"] = enabled.into();
    save_preferences(&app, &prefs)
}

fn runtime_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let exe_directory = std::env::current_exe().map_err(|error| error.to_string())?
        .parent().ok_or("Executable directory unavailable")?.to_path_buf();
    let resources = if exe_directory.join("agent/bridge.mjs").is_file() { exe_directory }
        else { app.path().resource_dir().map_err(|error| error.to_string())? };
    let node = resources.join("runtime/node.exe");
    let script = resources.join("agent/bridge.mjs");
    if node.is_file() && script.is_file() { return Ok((node, script)); }
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../agent/bridge.mjs");
    if source.is_file() { return Ok((PathBuf::from("node"), source)); }
    Err("PI Agent runtime files are missing".into())
}

#[tauri::command]
fn agent_command(app: tauri::AppHandle, state: tauri::State<'_, AgentState>, command: serde_json::Value) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "Agent lock failed".to_string())?;
    if let Some(process) = guard.as_mut() {
        if let Some(status) = process.child.try_wait().map_err(|error| error.to_string())? {
            let errors = process.errors.lock().map(|items| items.join("\n")).unwrap_or_default();
            startup_log(&format!("Agent exited: {status}; stderr: {errors}"));
            *guard = None;
        }
    }
    if guard.is_none() {
        let data_dir = data_directory(&app)?;
        std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        let (node, script) = runtime_paths(&app)?;
        startup_log(&format!("Starting Agent: node={}, script={}, data={}", node.display(), script.display(), data_dir.display()));
        let workspace = app.path().home_dir().map_err(|error| error.to_string())?;
        let mut command_line = Command::new(node);
        command_line.arg(script)
            .env("SUMMON_DATA_DIR", &data_dir)
            .env("SUMMON_WORKSPACE", &workspace)
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command_line.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command_line.spawn()
            .map_err(|error| format!("Cannot start PI Agent: {error}"))?;
        let stdin = child.stdin.take().ok_or("Agent stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Agent stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("Agent stderr unavailable")?;
        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let error_buffer = errors.clone();
        let diagnostic_path = data_dir.join("agent.log");
        let events = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                            let _ = events.emit("agent-event", value);
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = events.emit("agent-event", serde_json::json!({"type":"disconnected","message":"Agent 连接中断，正在恢复"}));
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                if let Ok(mut buffer) = error_buffer.lock() { if buffer.len() >= 20 { buffer.remove(0); } buffer.push(line.clone()); }
                if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&diagnostic_path) { let _ = writeln!(file, "{line}"); }
                startup_log(&format!("Agent stderr: {line}"));
            }
        });
        *guard = Some(AgentProcess { child, stdin, errors });
        if command["type"].as_str() != Some("init") {
            let process = guard.as_mut().ok_or("Agent unavailable")?;
            writeln!(process.stdin, "{}", serde_json::json!({"type":"init","id":"host-init"})).map_err(|error| error.to_string())?;
        }
    }
    let process = guard.as_mut().ok_or("Agent unavailable")?;
    writeln!(process.stdin, "{}", command).map_err(|error| error.to_string())
}

#[tauri::command]
async fn open_settings(app: tauri::AppHandle, section: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        let _ = window.emit("settings-section", section.unwrap_or_else(|| "general".into()));
    } else {
        let initial = serde_json::to_string(&section.unwrap_or_else(|| "general".into())).map_err(|error| error.to_string())?;
        let mut builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
            .data_directory(std::env::current_exe().map_err(|error| error.to_string())?.parent().ok_or("Executable directory unavailable")?.join("data/webview"))
            .initialization_script(format!("window.SUMMON_SETTINGS_SECTION={initial};"))
            .title("Summon 设置").inner_size(980.0, 700.0).min_inner_size(740.0, 480.0);
        #[cfg(windows)]
        if std::env::var_os("SUMMON_TEST_DATA_DIR").is_some() {
            if let Ok(port) = std::env::var("SUMMON_TEST_WEBVIEW_PORT") {
                if let Ok(port) = port.parse::<u16>() { builder = builder.additional_browser_args(&format!("--remote-debugging-port={port}")); }
            }
        }
        builder.build().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn capture_shortcut(app: tauri::AppHandle, state: tauri::State<'_, ShortcutStateStore>, active: bool) -> Result<(), String> {
    let current = state.0.lock().map_err(|_| "Shortcut lock failed")?;
    if !current.is_empty() {
        if active { let _ = app.global_shortcut().unregister(current.as_str()); }
        else if !app.global_shortcut().is_registered(current.as_str()) {
            app.global_shortcut().register(current.as_str()).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
            let _ = app.save_window_state(BOUNDS);
            let _ = window.hide();
        } else {
            show_main(app);
        }
    }
}

#[tauri::command]
fn dismiss(window: tauri::WebviewWindow) {
    let _ = window.app_handle().save_window_state(BOUNDS);
    let _ = window.hide();
}

#[tauri::command]
async fn choose_workspace() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $shell=New-Object -ComObject Shell.Application; $folder=$shell.BrowseForFolder(0,'选择工作目录',0,0); if($folder){[Console]::Write($folder.Self.Path)}";
            let mut picker = Command::new("powershell.exe");
            picker.args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
            use std::os::windows::process::CommandExt;
            picker.creation_flags(0x08000000); // Hide the console; keep the native folder dialog visible.
            let output = picker.output().map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
            }
            let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            Ok(if path.is_empty() { None } else { Some(path) })
        }).await.map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    { Err("Folder selection is currently available on Windows only".into()) }
}

fn startup_log(message: &str) {
    let paths = [
        std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("startup.log"))),
        Some(std::env::temp_dir().join("Summon-startup.log")),
    ];
    for path in paths.into_iter().flatten() {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{message}");
            break;
        }
    }
}

#[cfg(windows)]
fn show_startup_error(message: &str) {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }
    let text: Vec<u16> = std::ffi::OsStr::new(message).encode_wide().chain(Some(0)).collect();
    let caption: Vec<u16> = std::ffi::OsStr::new("Summon 启动失败").encode_wide().chain(Some(0)).collect();
    unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), 0x10); }
}

#[cfg(not(windows))]
fn show_startup_error(message: &str) {
    eprintln!("{message}");
}

#[cfg(windows)]
struct InstanceGuard(isize);

#[cfg(windows)]
impl Drop for InstanceGuard {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        extern "system" {
            fn CloseHandle(handle: isize) -> i32;
        }
        unsafe { CloseHandle(self.0); }
    }
}

#[cfg(windows)]
fn claim_instance() -> Result<Option<InstanceGuard>, String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attributes: *const std::ffi::c_void, initial_owner: i32, name: *const u16) -> isize;
        fn GetLastError() -> u32;
        fn CloseHandle(handle: isize) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class_name: *const u16, window_name: *const u16) -> isize;
        fn ShowWindow(window: isize, command: i32) -> i32;
        fn SetForegroundWindow(window: isize) -> i32;
    }
    let lock_name = if let Some(directory) = std::env::var_os("SUMMON_TEST_DATA_DIR") {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new(); directory.hash(&mut hasher);
        format!("Local\\dev.rynorca.summon.test.{}", hasher.finish())
    } else { "Local\\dev.rynorca.summon.instance".to_owned() };
    let name: Vec<u16> = std::ffi::OsStr::new(&lock_name)
        .encode_wide().chain(Some(0)).collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle == 0 {
        return Err(format!("Cannot create single-instance lock: {}", std::io::Error::last_os_error()));
    }
    if unsafe { GetLastError() } != 183 {
        return Ok(Some(InstanceGuard(handle)));
    }
    let title: Vec<u16> = std::ffi::OsStr::new("Summon").encode_wide().chain(Some(0)).collect();
    for _ in 0..20 {
        let window = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
        if window != 0 {
            unsafe {
                ShowWindow(window, 9);
                SetForegroundWindow(window);
                CloseHandle(handle);
            }
            return Ok(None);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    unsafe { CloseHandle(handle); }
    Err("Summon is already running, but its window was not found".into())
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "显示 Summon", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Summon", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => {
                let _ = app.save_window_state(BOUNDS);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn run_desktop() -> tauri::Result<()> {
    let shortcuts = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_main(app);
            }
        })
        .build();

    let mut window_state = tauri_plugin_window_state::Builder::new().with_state_flags(BOUNDS);
    if let Some(directory) = std::env::var_os("SUMMON_TEST_DATA_DIR") {
        window_state = window_state.with_filename(PathBuf::from(directory).join("window-state.json").to_string_lossy().into_owned());
    }
    tauri::Builder::default()
        .manage(AgentState::default())
        .manage(ShortcutStateStore::default())
        .plugin(window_state.build())
        .plugin(shortcuts)
        .invoke_handler(tauri::generate_handler![dismiss, agent_command, choose_workspace, desktop_preferences, set_shortcut, set_autostart, open_settings, capture_shortcut])
        .setup(|app| {
            startup_log("Creating Tauri window");
            let exe_dir = std::env::current_exe()?.parent().ok_or("Executable directory unavailable")?.to_path_buf();
            let portable_webview_dir = exe_dir.join("data").join("webview");
            let webview_dir = if std::fs::create_dir_all(&portable_webview_dir).is_ok() {
                portable_webview_dir
            } else {
                let fallback = std::env::temp_dir().join("Summon").join("webview");
                std::fs::create_dir_all(&fallback)?;
                fallback
            };
            startup_log(&format!("WebView2 data directory: {}", webview_dir.display()));
            let config = &app.config().app.windows[0];
            let mut builder = WebviewWindowBuilder::from_config(app.handle(), config)?.data_directory(webview_dir);
            #[cfg(windows)]
            if std::env::var_os("SUMMON_TEST_DATA_DIR").is_some() {
                if let Ok(port) = std::env::var("SUMMON_TEST_WEBVIEW_PORT") {
                    if let Ok(port) = port.parse::<u16>() { builder = builder.additional_browser_args(&format!("--remote-debugging-port={port}")); }
                }
            }
            let main_window = builder.build()?;
            if std::env::args().any(|arg| arg == "--autostart") {
                let _ = main_window.hide();
            }
            startup_log("Tauri window created");
            if let Err(error) = setup_tray(app) {
                startup_log(&format!("Tray unavailable: {error}"));
            }

            let prefs = read_preferences(app.handle());
            let preferred = prefs["shortcut"].as_str().unwrap_or("Alt+Shift+C");
            let mut shortcut = String::new();
            for accelerator in std::iter::once(preferred).chain(["Alt+Shift+C", "Alt+Shift+Q", "Alt+Shift+J", "F3"]) {
                if !shortcut.is_empty() { break; }
                if app.global_shortcut().register(accelerator).is_ok() {
                    shortcut = accelerator.to_owned();
                }
            }
            if let Ok(mut active) = app.state::<ShortcutStateStore>().0.lock() { *active = shortcut.clone(); }
            if std::env::var_os("SUMMON_TEST_DATA_DIR").is_none() && prefs["autostart"].as_bool() == Some(true) {
                if let Err(error) = apply_autostart(true) { startup_log(&error); }
            }
            startup_log(&format!("Global shortcut: {shortcut}"));
            startup_log("Setup complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.app_handle().save_window_state(BOUNDS);
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
}

fn main() {
    startup_log("Starting Summon");
    #[cfg(windows)]
    let _instance_guard = match claim_instance() {
        Ok(Some(guard)) => guard,
        Ok(None) => return,
        Err(error) => {
            startup_log(&error);
            show_startup_error(&error);
            return;
        }
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run_desktop));
    let error = match result {
        Ok(Ok(())) => return,
        Ok(Err(error)) => format!("{error:?}"),
        Err(panic) => panic.downcast_ref::<String>().cloned()
            .or_else(|| panic.downcast_ref::<&str>().map(|value| (*value).to_string()))
            .unwrap_or_else(|| "Unknown startup panic".to_string()),
    };
    let message = format!("Summon 无法启动：{error}\n\n请将便携包文件夹中的 startup.log 发给开发者；若文件不存在，请查看系统临时目录中的 Summon-startup.log。");
    startup_log(&format!("Startup failed: {error}"));
    show_startup_error(&message);
}
