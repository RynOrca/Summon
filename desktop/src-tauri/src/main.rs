#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{ShortcutState, GlobalShortcutExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use std::{
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    thread,
};

const BOUNDS: StateFlags = StateFlags::SIZE.union(StateFlags::POSITION);

struct AgentProcess {
    child: Child,
    stdin: ChildStdin,
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct AgentState(Mutex<Option<AgentProcess>>);

fn runtime_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
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
    if guard.is_none() {
        let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        let (node, script) = runtime_paths(&app)?;
        let workspace = app.path().home_dir().map_err(|error| error.to_string())?;
        let mut command_line = Command::new(node);
        command_line.arg(script)
            .env("SUMMON_DATA_DIR", data_dir)
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
            let _ = events.emit("agent-event", serde_json::json!({"type":"disconnected"}));
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                eprintln!("pi-agent: {line}");
            }
        });
        *guard = Some(AgentProcess { child, stdin });
    }
    let process = guard.as_mut().ok_or("Agent unavailable")?;
    if process.child.try_wait().map_err(|error| error.to_string())?.is_some() {
        *guard = None;
        return Err("PI Agent process exited; retry the command".into());
    }
    writeln!(process.stdin, "{}", command).map_err(|error| error.to_string())
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

    tauri::Builder::default()
        .manage(AgentState::default())
        .plugin(tauri_plugin_window_state::Builder::new().with_state_flags(BOUNDS).build())
        .plugin(shortcuts)
        .invoke_handler(tauri::generate_handler![dismiss, agent_command])
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
            WebviewWindowBuilder::from_config(app.handle(), config)?
                .data_directory(webview_dir)
                .build()?;
            startup_log("Tauri window created");
            if let Err(error) = setup_tray(app) {
                startup_log(&format!("Tray unavailable: {error}"));
            }

            for accelerator in ["Alt+Shift+C", "Alt+Shift+Q", "Alt+Shift+J", "F3"] {
                if app.global_shortcut().register(accelerator).is_ok() {
                    break;
                }
            }
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
