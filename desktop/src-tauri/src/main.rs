#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{ShortcutState, GlobalShortcutExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const BOUNDS: StateFlags = StateFlags::SIZE.union(StateFlags::POSITION);

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

fn main() {
    let shortcuts = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_main(app);
            }
        })
        .build();

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().with_state_flags(BOUNDS).build())
        .plugin(shortcuts)
        .invoke_handler(tauri::generate_handler![dismiss])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "显示 Summon", true, None::<&str>)
                .map_err(|error| { eprintln!("tray open item: {error}"); error })?;
            let quit = MenuItem::with_id(app, "quit", "退出 Summon", true, None::<&str>)
                .map_err(|error| { eprintln!("tray quit item: {error}"); error })?;
            let menu = Menu::with_items(app, &[&open, &quit])
                .map_err(|error| { eprintln!("tray menu: {error}"); error })?;
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
                .build(app)
                .map_err(|error| { eprintln!("tray icon: {error}"); error })?;

            for accelerator in ["Alt+Shift+C", "Alt+Shift+Q", "Alt+Shift+J", "F3"] {
                if app.global_shortcut().register(accelerator).is_ok() {
                    break;
                }
            }
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
        .expect("Summon desktop failed to start");
}
