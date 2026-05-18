use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

struct ServerProcess(Mutex<Option<Child>>);

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
            let u16s: Vec<u16> = bytes.chunks_exact(2)
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
        return Err("WSL not found. Run `wsl --install` from admin PowerShell, then reboot.".into());
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
    eprintln!("[loopat] import: tar={}, size={}, install_dir={}",
        tar_path.display(), tar_size, install_dir.display());

    match try_import(&install_dir, tar_path, true) {
        Ok(()) => return Ok(()),
        Err(e) => {
            eprintln!("[loopat] retrying without --version flag… prev={e}");
            try_import(&install_dir, tar_path, false)
        }
    }
}

#[cfg(target_os = "windows")]
fn try_import(install_dir: &std::path::Path, tar_path: &std::path::Path, version_flag: bool) -> Result<(), String> {
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

fn wait_for_server() {
    for _ in 0..120 {
        if std::net::TcpStream::connect(format!("127.0.0.1:{SERVER_PORT}")).is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    eprintln!("loopat server did not start in time");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerProcess(Mutex::new(None)))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Kill server on window close
                if let Some(state) = window.try_state::<ServerProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
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
                        .stdout(Stdio::null()).stderr(Stdio::null())
                        .spawn();
                }
            }
        })
        .setup(|app| {
            let server = start_server(app);
            if let Some(guard) = app.try_state::<ServerProcess>() {
                if let Ok(mut g) = guard.0.lock() {
                    *g = server;
                }
            }
            wait_for_server();
            if let Some(window) = app.get_webview_window("main") {
                let url = format!("http://localhost:{SERVER_PORT}");
                let _ = window.navigate(url.parse().unwrap());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn start_server(app: &tauri::App) -> Option<Child> {
    #[cfg(target_os = "windows")]
    {
        match setup_wsl(app) {
            Ok(child) => return Some(child),
            Err(e) => {
                eprintln!("[loopat] WSL setup error: {e}");
                return None;
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        find_server_binary().and_then(|path| {
            let mut cmd = Command::new(path);
            cmd.stdin(Stdio::null());
            cmd.stdout(Stdio::inherit());
            cmd.stderr(Stdio::inherit());
            cmd.spawn().ok()
        })
    }
}

#[cfg(target_os = "windows")]
fn find_tar_path(app: &tauri::App) -> Option<std::path::PathBuf> {
    app.handle().path().resource_dir()
        .ok()
        .map(|d| d.join("loopat-wsl.tar.gz"))
        .filter(|p| p.exists())
        .or_else(|| {
            std::env::current_exe().ok()
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
    std::fs::read_to_string(&vf).ok().map(|s| s.trim().to_string())
}

#[cfg(target_os = "windows")]
fn current_distro_version() -> Option<String> {
    let out = Command::new(WSL_EXE)
        .args(["-d", WSL_DISTRO, "--", "cat", "/opt/loopat/.wsl-version"])
        .output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(decode_wsl(&out.stdout).trim().to_string())
}

#[cfg(target_os = "windows")]
fn setup_wsl(app: &tauri::App) -> Result<Child, String> {
    eprintln!("[loopat] WSL: checking installation…");
    ensure_wsl2()?;

    let tar_path = find_tar_path(app)
        .ok_or("loopat-wsl.tar.gz not found".to_string())?;
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
fn find_server_binary() -> Option<std::path::PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();

    // Inside a macOS .app bundle: binary is in MacOS/, resources in Resources/
    // Tauri v2 preserves relative resource paths, so binaries may be nested under
    // a subdirectory (e.g. Resources/dist-macos-x64/loopat).
    let resource_dir = exe_dir.parent()?.join("Resources");

    // Search Resources/ recursively (Tauri may preserve resource subdirectory structure)
    if resource_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&resource_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    for name in &["loopat-server", "loopat"] {
                        let candidate = path.join(name);
                        if candidate.exists() {
                            return Some(candidate);
                        }
                    }
                }
            }
        }
    }

    for name in &["loopat-server", "loopat"] {
        // Bundled .app resource (flat path)
        let candidate = resource_dir.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
        // Same directory as the Tauri binary (dev / non-bundle builds)
        let candidate = exe_dir.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    // Dev mode: lookup relative to project root
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let base = manifest.parent()?;
    for name in &["loopat-server", "loopat"] {
        for dir in &["dist-macos-x64", "dist-macos-arm64", "dist"] {
            let candidate = base.join(dir).join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    eprintln!("loopat server binary not found");
    None
}
