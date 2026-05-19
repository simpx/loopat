use std::fs::OpenOptions;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Emitter;
use tauri::Manager;

struct ServerProcess {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<std::process::ChildStdin>>,
}

struct StartupError(Mutex<Option<String>>);

/// Write diagnostics to a file AND inject into the loading page.
fn diag(app: &tauri::App, msg: &str) {
    eprintln!("[loopat] {msg}");
    // Write to diagnostics file
    if let Some(path) = diag_path() {
        let _ = std::fs::write(&path, format!("{}\n", msg));
    }
    // Inject into the loading page via eval
    if let Some(window) = app.get_webview_window("main") {
        let js = format!(
            r#"
(function(){{
  var d=document.getElementById('debug');
  var s=document.getElementById('status');
  var sp=document.getElementById('spinner');
  if(d){{d.style.display='block';d.textContent+=decodeURIComponent('{}')+'\n'}}
  if(s){{s.textContent='❌ 启动失败';s.style.color='#f85149'}}
  if(sp)sp.style.display='none';
}})();
"#,
            // Escape the message as a URI component for safe injection
            urlencoding(msg)
        );
        let _ = window.eval(&js);
    }
}

fn urlencoding(s: &str) -> String {
    s.bytes().map(|b| format!("%{:02X}", b)).collect::<String>()
}

/// Path to the diagnostics file.
fn diag_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let dir = PathBuf::from(home).join("Library/Logs/loopat");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("startup.log"))
}

/// Write to the running server's stdin (e.g. sudo password).
#[tauri::command]
fn write_server_stdin(
    state: tauri::State<ServerProcess>,
    input: String,
) -> Result<(), String> {
    let mut guard = state.stdin.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut stdin) = *guard {
        stdin.write_all(input.as_bytes()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open the server log in Terminal.app.
#[tauri::command]
fn show_server_console() -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let log_path = server_log_path();
        let escaped = log_path.display().to_string()
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        let script = format!(
            r#"tell app "Terminal" to do script "tail -f {}""#,
            escaped
        );
        Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return the startup error message (if any).
#[tauri::command]
fn get_server_startup_error(state: tauri::State<StartupError>) -> Option<String> {
    state.0.lock().ok()?.clone()
}

#[cfg(not(target_os = "windows"))]
fn server_log_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let dir = PathBuf::from(home).join("Library/Logs/loopat");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("server.log")
}



#[cfg(target_os = "windows")]
const WSL_DISTRO: &str = "loopat";
const SERVER_PORT: u16 = 7787;

// ── WSL helpers (Windows only) ──

#[cfg(target_os = "windows")]
const WSL_EXE: &str = r"C:\Windows\System32\wsl.exe";

#[cfg(target_os = "windows")]
fn decode_wsl(bytes: &[u8]) -> String {
    // WSL on Windows outputs UTF-16LE. Detect by checking for null bytes
    // in every other position (ASCII in UTF-16LE = byte + 0x00).
    if bytes.len() >= 2 {
        let null_at_odds = (1..bytes.len()).step_by(2).all(|i| bytes[i] == 0);
        if null_at_odds {
            // Likely UTF-16LE — decode as slices of u16
            let u16s: Vec<u16> = bytes
                .chunks_exact(2)
                .filter_map(|c| Some(u16::from_le_bytes([c[0], c[1]])))
                .take_while(|&c| c != 0)
                .collect();
            return String::from_utf16_lossy(&u16s).trim().to_string();
        }
    }
    // Fall back to UTF-8
    String::from_utf8_lossy(bytes).trim().to_string()
}

#[cfg(target_os = "windows")]
fn wsl(args: &[&str]) -> Result<Child, String> {
    Command::new(WSL_EXE)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("wsl.exe: {e}"))
}

#[cfg(target_os = "windows")]
fn wsl_output(args: &[&str]) -> Result<String, String> {
    let out = Command::new(WSL_EXE)
        .args(args)
        .output()
        .map_err(|e| format!("wsl.exe: {e}"))?;
    if !out.status.success() {
        let stderr = decode_wsl(&out.stderr);
        return Err(format!("wsl.exe exited {:?}: {stderr}", out.status.code()));
    }
    Ok(decode_wsl(&out.stdout))
}

#[cfg(target_os = "windows")]
fn ensure_wsl2() -> Result<(), String> {
    if !std::path::Path::new(WSL_EXE).exists() {
        return Err(
            "WSL not found. Run `wsl --install` from admin PowerShell, then reboot.".into(),
        );
    }
    let status = wsl_output(&["--status"]).unwrap_or_default();
    eprintln!("[loopat] wsl --status: {status:?}");
    if !status.contains("Default Version: 2") {
        match wsl_output(&["--set-default-version", "2"]) {
            Ok(_) => eprintln!("[loopat] WSL default set to version 2"),
            Err(e) => eprintln!("[loopat] could not set WSL2 as default: {e}"),
        }
    }
    let ver = wsl_output(&["--version"]).unwrap_or_default();
    eprintln!("[loopat] wsl --version: {ver:?}");
    Ok(())
}

#[cfg(target_os = "windows")]
fn distro_imported() -> bool {
    let out = wsl_output(&["-l", "-q"]);
    match &out {
        Ok(s) => {
            let found = s.lines().any(|l| l.trim() == WSL_DISTRO);
            eprintln!("[loopat] wsl -l -q: {s:?}  found={found}");
            found
        }
        Err(e) => {
            eprintln!("[loopat] wsl -l -q error: {e}");
            false
        }
    }
}

#[cfg(target_os = "windows")]
fn import_distro(tar_path: &std::path::Path) -> Result<(), String> {
    let install_dir = appdata_dir().join("wsl").join(WSL_DISTRO);
    let _ = std::fs::remove_dir_all(&install_dir);
    std::fs::create_dir_all(&install_dir).map_err(|e| format!("mkdir: {e}"))?;

    let tar_size = std::fs::metadata(tar_path).map(|m| m.len()).unwrap_or(0);
    eprintln!(
        "[loopat] import: tar={}, size={}, install_dir={}",
        tar_path.display(),
        tar_size,
        install_dir.display()
    );

    match try_import(&install_dir, tar_path, true) {
        Ok(()) => return Ok(()),
        Err(e) => {
            eprintln!("[loopat] retrying without --version flag… prev={e}");
            try_import(&install_dir, tar_path, false)
        }
    }
}

#[cfg(target_os = "windows")]
fn try_import(
    install_dir: &std::path::Path,
    tar_path: &std::path::Path,
    version_flag: bool,
) -> Result<(), String> {
    let mut args: Vec<String> = vec![
        "--import".into(),
        WSL_DISTRO.into(),
        install_dir.to_string_lossy().into(),
        tar_path.to_string_lossy().into(),
    ];
    if version_flag {
        args.push("--version".into());
        args.push("2".into());
    }
    let out = Command::new(WSL_EXE)
        .args(&args)
        .output()
        .map_err(|e| format!("spawn: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let exit_code = out.status.code();
    Err(format!("exit={exit_code:?} stderr={stderr}"))
}

#[cfg(target_os = "windows")]
fn appdata_dir() -> std::path::PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\ProgramData"))
        .join("loopat")
}

// ── server lifecycle ──

fn wait_for_server() -> bool {
    for _ in 0..120 {
        if std::net::TcpStream::connect(format!("127.0.0.1:{SERVER_PORT}")).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    eprintln!("[loopat] server did not start in time");
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerProcess {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
        })
        .manage(StartupError(Mutex::new(None)))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Kill server on window close
                if let Some(state) = window.try_state::<ServerProcess>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(ref mut child) = *guard {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
                #[cfg(target_os = "windows")]
                {
                    let _ = Command::new(WSL_EXE)
                        .args(["-d", WSL_DISTRO, "--", "pkill", "-f", "loopat-server"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn();
                }
            }
        })
        .setup(|app| {
            // ── Menu ──
            let show_console = MenuItemBuilder::with_id("show_console", "显示服务器日志")
                .accelerator("CmdOrCtrl+Shift+L")
                .build(app)?;
            let window_menu = SubmenuBuilder::new(app, "窗口")
                .item(&show_console)
                .build()?;
            let menu = MenuBuilder::new(app)
                .item(&window_menu)
                .build()?;
            app.set_menu(menu)?;

            // ── Server ──
            diag(app, "正在查找 loopat-server…");
            let (server, server_stdin) = start_server(app);
            let server_started = server.is_some();
            if let Some(guard) = app.try_state::<ServerProcess>() {
                if let Ok(mut g) = guard.child.lock() {
                    *g = server;
                }
                if let Ok(mut g) = guard.stdin.lock() {
                    *g = server_stdin;
                }
            }

            let server_ready = if server_started {
                diag(app, "server 已启动，等待端口就绪…");
                let ready = wait_for_server();
                if ready {
                    diag(app, "端口就绪，正在跳转…");
                } else {
                    diag(app, "等待超时（60s），server 未响应");
                    diag(app, "请检查 server 日志: 菜单 > 窗口 > 显示服务器日志");
                }
                ready
            } else {
                // Collect resource directory contents for diagnostics
                let exe = std::env::current_exe().ok();
                let exe_dir = exe.as_ref().and_then(|p| p.parent().map(|p| p.to_path_buf()));
                let mut detail = String::from("找不到 loopat-server\n\n搜索路径：\n");
                if let Some(ref d) = exe_dir {
                    detail += &format!("exe_dir:  {}\n", d.display());
                    if let Some(parent) = d.parent() {
                        let r = parent.join("Resources");
                        detail += &format!("Resources: {} (exists={})\n", r.display(), r.exists());
                        if r.exists() {
                            if let Ok(entries) = std::fs::read_dir(&r) {
                                for entry in entries.flatten() {
                                    let p = entry.path();
                                    detail += &format!("  {}\n", p.display());
                                    if p.is_dir() {
                                        if let Ok(sub) = std::fs::read_dir(&p) {
                                            for s in sub.flatten() {
                                                detail += &format!("    {}\n", s.path().display());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if let Ok(rd) = app.path().resource_dir() {
                    detail += &format!("\nTauri resource_dir(): {} (exists={})\n",
                        rd.display(), rd.exists());
                    if rd.exists() {
                        if let Ok(entries) = std::fs::read_dir(&rd) {
                            for entry in entries.flatten() {
                                detail += &format!("  {}\n", entry.path().display());
                            }
                        }
                    }
                }
                diag(app, &detail);
                false
            };

            if server_ready {
                // ── Password-prompt watcher ──
                #[cfg(not(target_os = "windows"))]
                {
                    let log_path = server_log_path();
                    let app_handle = app.handle().clone();
                    std::thread::spawn(move || {
                        use std::io::{BufRead, Seek, SeekFrom};
                        let mut last_size = 0u64;
                        loop {
                            std::thread::sleep(std::time::Duration::from_secs(1));
                            if let Ok(meta) = std::fs::metadata(&log_path) {
                                let size = meta.len();
                                if size == last_size || size == 0 {
                                    last_size = size;
                                    continue;
                                }
                                // File was truncated (server restart)
                                if size < last_size {
                                    last_size = 0;
                                    continue;
                                }
                                if let Ok(file) = std::fs::File::open(&log_path) {
                                    let mut reader = std::io::BufReader::new(file);
                                    if reader.seek(SeekFrom::Start(last_size)).is_ok() {
                                        let mut line = String::new();
                                        while reader.read_line(&mut line).is_ok()
                                            && !line.is_empty()
                                        {
                                            let lc = line.to_lowercase();
                                            if lc.contains("[sudo]")
                                                || lc.trim().contains("password:")
                                            {
                                                let _ = app_handle.emit(
                                                    "server-password-prompt",
                                                    (),
                                                );
                                            }
                                            line.clear();
                                        }
                                    }
                                }
                                last_size = size;
                            }
                        }
                    });
                }

                if let Some(window) = app.get_webview_window("main") {
                    let url = format!("http://localhost:{SERVER_PORT}");
                    let _ = window.navigate(url.parse().unwrap());
                }
            } else if !server_started {
                eprintln!("[loopat] server was not started; keeping startup page open");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            write_server_stdin,
            get_server_startup_error,
            show_server_console,
        ])
        .on_menu_event(|_app, event| {
            if event.id() == "show_console" {
                #[cfg(not(target_os = "windows"))]
                {
                    let log_path = server_log_path();
                    let escaped = log_path.display().to_string()
                        .replace('\\', "\\\\")
                        .replace('"', "\\\"");
                    let script = format!(
                        r#"tell app "Terminal" to do script "tail -f {}""#,
                        escaped
                    );
                    let _ = Command::new("osascript")
                        .arg("-e")
                        .arg(&script)
                        .spawn();
                }
                #[cfg(target_os = "windows")]
                {
                    let _ = Command::new("cmd")
                        .args(["/c", "start", "powershell", "-NoExit",
                            "-Command", "Get-Content -Wait \"$env:LOCALAPPDATA/loopat/server.log\""])
                        .spawn();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn start_server(app: &tauri::App) -> (Option<Child>, Option<std::process::ChildStdin>) {
    #[cfg(target_os = "windows")]
    {
        match setup_wsl(app) {
            Ok(child) => return (Some(child), None),
            Err(e) => {
                eprintln!("[loopat] WSL setup error: {e}");
                return (None, None);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let path = match find_server_binary(app) {
            Some(p) => p,
            None => return (None, None),
        };
        eprintln!("[loopat] starting server binary: {}", path.display());
        let log_path = server_log_path();
        if let Ok(log_file) = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_path)
        {
            if let Ok(log_clone) = log_file.try_clone() {
                let mut cmd = Command::new(&path);
                cmd.stdin(Stdio::piped());
                cmd.stdout(log_file);
                cmd.stderr(log_clone);
                match cmd.spawn() {
                    Ok(mut child) => {
                        let stdin = child.stdin.take();
                        eprintln!("[loopat] server started, log: {}",
                            log_path.display());
                        return (Some(child), stdin);
                    }
                    Err(e) => eprintln!("[loopat] failed to start server binary: {e}"),
                }
            }
        }
        // Fallback: piped stdin + inherit stdio
        let mut cmd = Command::new(&path);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::inherit());
        cmd.stderr(Stdio::inherit());
        match cmd.spawn() {
            Ok(mut child) => {
                let stdin = child.stdin.take();
                (Some(child), stdin)
            }
            Err(e) => {
                eprintln!("[loopat] failed to start server binary: {e}");
                (None, None)
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn find_tar_path(app: &tauri::App) -> Option<std::path::PathBuf> {
    app.handle()
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("loopat-wsl.tar.gz"))
        .filter(|p| p.exists())
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.join("loopat-wsl.tar.gz")))
                .filter(|p| p.exists())
        })
}

#[cfg(target_os = "windows")]
fn expected_version(tar_path: &std::path::Path) -> Option<String> {
    let mut vf = tar_path.to_path_buf();
    vf.set_file_name(format!(
        "{}.version",
        tar_path.file_stem()?.to_string_lossy()
    ));
    std::fs::read_to_string(&vf)
        .ok()
        .map(|s| s.trim().to_string())
}

#[cfg(target_os = "windows")]
fn current_distro_version() -> Option<String> {
    let out = Command::new(WSL_EXE)
        .args(["-d", WSL_DISTRO, "--", "cat", "/opt/loopat/.wsl-version"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(decode_wsl(&out.stdout).trim().to_string())
}

#[cfg(target_os = "windows")]
fn setup_wsl(app: &tauri::App) -> Result<Child, String> {
    eprintln!("[loopat] WSL: checking installation…");
    ensure_wsl2()?;

    let tar_path = find_tar_path(app).ok_or("loopat-wsl.tar.gz not found".to_string())?;
    eprintln!("[loopat] tar resolved to: {}", tar_path.display());

    let need_import = if !distro_imported() {
        eprintln!("[loopat] distro not registered, need import");
        true
    } else {
        let expected = expected_version(&tar_path);
        let current = current_distro_version();
        eprintln!("[loopat] version check: expected={expected:?} current={current:?}");
        match (expected, current) {
            (Some(exp), Some(cur)) if exp == cur => {
                eprintln!("[loopat] version match, skipping import");
                false
            }
            _ => {
                eprintln!("[loopat] version mismatch or unreadable, re-importing");
                // Unregister old/broken distro before re-import
                let _ = Command::new(WSL_EXE)
                    .args(["--unregister", WSL_DISTRO])
                    .output();
                true
            }
        }
    };

    if need_import {
        eprintln!("[loopat] WSL: importing loopat distro…");
        import_distro(&tar_path)?;
    }

    eprintln!("[loopat] WSL: starting server…");
    let child = wsl(&["-d", WSL_DISTRO, "--", "/opt/loopat/loopat-server"])?;
    Ok(child)
}

#[cfg(not(target_os = "windows"))]
fn find_server_binary(app: &tauri::App) -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok();
    eprintln!("[loopat] current_exe: {:?}", exe.as_ref().map(|p| p.display()));

    // 1) Search backward from executable path (macOS .app bundle structure)
    if let Some(exe_dir) = exe.as_ref().and_then(|p| p.parent()) {
        eprintln!("[loopat] exe_dir: {}", exe_dir.display());
        let resource_dir = exe_dir.parent().map(|p| p.join("Resources"));
        if let Some(ref r) = resource_dir {
            eprintln!("[loopat] resource_dir: {}  exists={}", r.display(), r.exists());
            // Recursive search (up to 3 levels deep for nested resource paths)
            if r.exists() {
                if let Ok(entries) = std::fs::read_dir(r) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        eprintln!("[loopat]   scanning: {}", path.display());
                        // Search this directory and up to 2 more levels deep
                        let mut dirs: Vec<PathBuf> = vec![path.clone()];
                        let mut next: Vec<PathBuf> = Vec::new();
                        for _level in 0..3 {
                            for d in dirs.drain(..) {
                                if d.is_dir() {
                                    if let Ok(sub) = std::fs::read_dir(&d) {
                                        for s in sub.flatten() {
                                            let p = s.path();
                                            if p.is_dir() {
                                                next.push(p.clone());
                                            }
                                            for name in &["loopat-server", "loopat"] {
                                                let candidate = if p.is_dir() {
                                                    p.join(name)
                                                } else {
                                                    p.clone()
                                                };
                                                let exists = candidate.exists();
                                                if !exists && p.is_dir() { continue; }
                                                let mode = std::fs::metadata(&candidate).ok()
                                                    .map(|m| format!("{:o}", m.permissions().mode()));
                                                eprintln!("[loopat]     {} exists={} mode={:?}",
                                                    candidate.display(), exists, mode);
                                                if exists && (candidate.file_name().map_or(false, |n| n == "loopat-server" || n == "loopat")) {
                                                    return Some(candidate);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            std::mem::swap(&mut dirs, &mut next);
                        }
                    }
                }
            }
            // Flat in Resources/
            for name in &["loopat-server", "loopat"] {
                let candidate = r.join(name);
                let exists = candidate.exists();
                eprintln!("[loopat]   flat: {}  exists={}", candidate.display(), exists);
                if exists { return Some(candidate); }
            }
        }
        // Next to executable
        let candidate = exe_dir.join("loopat-server");
        let exists = candidate.exists();
        eprintln!("[loopat]   exe_dir: {}  exists={}", candidate.display(), exists);
        if exists { return Some(candidate); }
    }

    // 2) Try Tauri's resource_dir() API
    if let Ok(rd) = app.path().resource_dir() {
        eprintln!("[loopat] Tauri resource_dir(): {}  exists={}", rd.display(), rd.exists());
        if rd.exists() {
            // Recursive (up to 3 levels)
            if let Ok(entries) = std::fs::read_dir(&rd) {
                let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
                let mut next: Vec<PathBuf> = Vec::new();
                for _level in 0..3 {
                    for d in dirs.drain(..) {
                        eprintln!("[loopat]   scanning: {}", d.display());
                        if let Ok(sub) = std::fs::read_dir(&d) {
                            for s in sub.flatten() {
                                let p = s.path();
                                if p.is_dir() {
                                    next.push(p.clone());
                                }
                                for name in &["loopat-server", "loopat"] {
                                    let candidate = if p.is_dir() { p.join(name) } else { p.clone() };
                                    if candidate.exists()
                                        && candidate.file_name().map_or(false, |n| n == "loopat-server" || n == "loopat")
                                    {
                                        eprintln!("[loopat]     FOUND: {}", candidate.display());
                                        return Some(candidate);
                                    }
                                }
                            }
                        }
                    }
                    std::mem::swap(&mut dirs, &mut next);
                }
            }
            // Flat
            for name in &["loopat-server", "loopat"] {
                let candidate = rd.join(name);
                if candidate.exists() {
                    eprintln!("[loopat]     FOUND (flat): {}", candidate.display());
                    return Some(candidate);
                }
            }
        }
    }

    // 3) Dev mode
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let base = manifest.parent()?;
    for name in &["loopat-server", "loopat"] {
        for dir in &["dist-macos-x64", "dist-macos-arm64", "dist"] {
            let candidate = base.join(dir).join(name);
            let exists = candidate.exists();
            eprintln!("[loopat]   dev: {}  exists={}", candidate.display(), exists);
            if exists { return Some(candidate); }
        }
    }
    eprintln!("[loopat] server binary not found");
    None
}
