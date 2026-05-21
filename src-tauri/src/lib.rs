mod vm;
mod commands;

use std::sync::{Arc, Mutex};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use vm::VmManager;

/// Shared application state passed to Tauri commands.
pub struct AppState {
    pub vm: Arc<Mutex<VmManager>>,
    pub log_buffer: Arc<Mutex<Vec<String>>>,
    /// Server URL once VM is ready (e.g. "http://192.168.64.2:7787")
    pub server_url: Arc<Mutex<Option<String>>>,
}

pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            vm: Arc::new(Mutex::new(VmManager::new())),
            log_buffer: Arc::new(Mutex::new(Vec::new())),
            server_url: Arc::new(Mutex::new(None)),
        })
        .setup(|app| {
            // ── Native macOS menu ──────────────────────────────────────────
            let app_menu = Submenu::with_items(
                app,
                "loopat",
                true,
                &[
                    &PredefinedMenuItem::about(app, Some("About loopat"), None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some("Quit loopat"))?,
                ],
            )?;

            let view_menu = Submenu::with_items(
                app,
                "View",
                true,
                &[&MenuItem::with_id(
                    app,
                    "show-logs",
                    "Server Logs",
                    true,
                    Some("CmdOrCtrl+Shift+L"),
                )?],
            )?;

            let window_menu = Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?;

            let menu = Menu::with_items(app, &[&app_menu, &view_menu, &window_menu])?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                if event.id().0 == "show-logs" {
                    open_logs_window(app);
                }
            });

            // ── Start VM in background ─────────────────────────────────────
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                start_vm_and_navigate(app_handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_logs,
            commands::get_vm_status,
            commands::restart_vm,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    // Stop VM when main window closes
                    if let Some(state) = window.try_state::<AppState>() {
                        let mut vm = state.vm.lock().unwrap();
                        vm.stop();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running loopat");
}

/// Open the logs window (or focus it if already open).
fn open_logs_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("logs") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    match WebviewWindowBuilder::new(app, "logs", WebviewUrl::App("logs.html".into()))
        .title("loopat – Server Logs")
        .inner_size(900.0, 600.0)
        .resizable(true)
        .build()
    {
        Ok(_) => {}
        Err(e) => log::error!("Failed to open logs window: {e}"),
    }
}

/// Background task: start the VM, wait until the server is ready, then
/// navigate the main window to the server URL.
pub async fn start_vm_and_navigate(app: tauri::AppHandle) {
    let state = app.state::<AppState>();

    let resources_dir = app
        .path()
        .resource_dir()
        .expect("failed to get resource dir");

    let loopat_home = dirs::home_dir()
        .expect("failed to get home dir")
        .join(".loopat");

    // ── Step 1: Decompress rootfs on first run (blocking, may take minutes) ──
    let _ = app.emit("vm-status", serde_json::json!({ "status": "decompressing", "message": "Preparing VM disk image (first launch only)…" }));

    let data_dir = {
        let vm = state.vm.lock().unwrap();
        match vm.prepare(&resources_dir) {
            Ok(d) => d,
            Err(e) => {
                let msg = format!("VM prepare failed: {e}");
                log::error!("{msg}");
                let _ = app.emit("vm-status", serde_json::json!({ "status": "error", "message": msg }));
                return;
            }
        }
    };

    // ── Step 2: Start VM via Virtualization.framework ─────────────────────────
    let _ = app.emit("vm-status", serde_json::json!({ "status": "starting", "message": "Starting virtual machine…" }));

    let log_buffer = state.log_buffer.clone();
    let server_url_slot = state.server_url.clone();
    let app2 = app.clone();

    // server.log path on the host (written by the VM via virtiofs, or by a
    // direct macOS server). Compute before loopat_home is moved into start().
    let server_log_path = loopat_home.join("server.log");

    {
        let mut vm = state.vm.lock().unwrap();
        if let Err(e) = vm.start(&resources_dir, data_dir, loopat_home) {
            let msg = format!("VM start failed: {e}");
            log::error!("{msg}");
            let _ = app.emit("vm-status", serde_json::json!({ "status": "error", "message": msg }));
            return;
        }
    }

    // ── Step 3: Poll console log + server log until ready signal or timeout ──
    let mut server_log_offset: u64 = 0;

    let start_time = std::time::Instant::now();
    const TIMEOUT_SECS: u64 = 120;

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Drain VM serial console logs
        let vm_lines: Vec<String> = {
            let mut vm = state.vm.lock().unwrap();
            vm.drain_new_logs()
        };

        // Drain server.log (shared via virtiofs, falls back to local file
        // when running the server directly on macOS without a VM).
        let server_lines = drain_file(&server_log_path, &mut server_log_offset);

        let new_lines: Vec<_> = vm_lines.iter().chain(server_lines.iter()).cloned().collect();

        for line in &new_lines {
            eprintln!("[vm-out] {line}");
            let _ = app2.emit("vm-log", line.clone());
        }

        {
            let mut buf = log_buffer.lock().unwrap();
            buf.extend(new_lines.iter().cloned());
            let len = buf.len();
            if len > 5000 {
                buf.drain(0..len - 5000);
            }
        }

        // Check for ready signal
        for line in &new_lines {
            if let Some(url) = parse_server_ready(line) {
                log::info!("VM server ready at {url}");
                *server_url_slot.lock().unwrap() = Some(url.clone());
                let _ = app2.emit("vm-status", serde_json::json!({ "status": "connecting", "url": url, "message": "Waiting for server to respond…" }));

                // ── Poll /api/health until the server is reachable ─────────
                // LOOPAT_SERVER_READY is emitted before the server starts, so
                // we must wait for it to bind and serve before navigating.
                let health_url = format!("{}/api/health", url.trim_end_matches('/'));
                let poll_start = std::time::Instant::now();
                const POLL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
                let mut connected = false;

                while poll_start.elapsed() < POLL_TIMEOUT {
                    if let Ok(parsed) = url::Url::parse(&health_url) {
                        let host = parsed.host_str().unwrap_or("localhost");
                        let port = parsed.port().unwrap_or(80);
                        let addr = format!("{host}:{port}");

                        if let Ok(mut stream) = tokio::net::TcpStream::connect(&addr).await {
                            use tokio::io::{AsyncReadExt, AsyncWriteExt};
                            let req = format!(
                                "GET /api/health HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
                            );
                            if stream.write_all(req.as_bytes()).await.is_ok() {
                                let mut buf = [0; 1024];
                                if stream.read(&mut buf).await.is_ok() {
                                    let resp = String::from_utf8_lossy(&buf[..]);
                                    if resp.contains("200 OK") {
                                        connected = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }

                if connected {
                    log::info!("Server health check passed, navigating to {url}");
                    let _ = app2.emit("vm-status", serde_json::json!({ "status": "ready", "url": url }));
                    if let Some(window) = app2.get_webview_window("main") {
                        if let Ok(parsed) = url::Url::parse(&url) {
                            let _ = window.navigate(parsed);
                        }
                    }
                } else {
                    let msg = format!("Server at {url} did not become reachable within 30s");
                    log::error!("{msg}");
                    let _ = app2.emit("vm-status", serde_json::json!({ "status": "error", "message": msg }));
                }
                return;
            }
        }

        // Check if VM process died
        let running = {
            let mut vm = state.vm.lock().unwrap();
            vm.is_running()
        };
        if !running {
            let msg = "VM exited unexpectedly. Check the server logs for details.".to_string();
            let _ = app2.emit("vm-status", serde_json::json!({ "status": "error", "message": msg }));
            return;
        }

        // Timeout
        if start_time.elapsed().as_secs() > TIMEOUT_SECS {
            let _ = app2.emit("vm-status", serde_json::json!({
                "status": "error",
                "message": format!("VM did not become ready within {TIMEOUT_SECS}s. Check logs for details.")
            }));
            return;
        }
    }
}

/// Read new lines from a file incrementally (seek to last offset).
fn drain_file(path: &PathBuf, offset: &mut u64) -> Vec<String> {
    let Ok(file) = fs::File::open(path) else { return vec![] };
    let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file_len <= *offset { return vec![] }

    let mut reader = BufReader::new(file);
    use std::io::Seek;
    if reader.seek(std::io::SeekFrom::Start(*offset)).is_err() { return vec![] }

    let mut lines = vec![];
    for line in reader.lines() {
        match line {
            Ok(l) => { *offset += l.len() as u64 + 1; lines.push(l); }
            Err(_) => break,
        }
    }
    lines
}

/// Parse "LOOPAT_SERVER_READY=http://..." from VM console output.
fn parse_server_ready(line: &str) -> Option<String> {
    let line = line.trim();
    if let Some(url) = line.strip_prefix("LOOPAT_SERVER_READY=") {
        let url = url.trim();
        if url.starts_with("http://") {
            return Some(url.to_string());
        }
    }
    None
}

