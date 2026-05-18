#[cfg(target_os = "linux")]
mod sandbox {
    use super::{Op, parse_args};
    use std::fs;
    use std::io::{Read, Write};
    use std::os::fd::{IntoRawFd, RawFd};
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    use std::thread;

    use libc::{prctl, PR_SET_PDEATHSIG, SIGKILL};
    use nix::mount::{mount, MsFlags};
    use nix::sched::{unshare, CloneFlags};
    use nix::sys::wait::{waitpid, WaitStatus};
    use nix::unistd::{chdir, close, dup2, pipe, ForkResult};

    pub fn run_sandboxed(args: &[String]) {
        let (ops, cmd) = parse_args(args);
        if cmd.is_empty() {
            eprintln!("loopat-sandbox: no command specified");
            std::process::exit(1);
        }

        let (stdin_r, stdin_w) = fd_pair();
        let (stdout_r, stdout_w) = fd_pair();
        let (stderr_r, stderr_w) = fd_pair();

        match unsafe { nix::unistd::fork() } {
            Err(e) => {
                eprintln!("loopat-sandbox: fork failed: {e}");
                std::process::exit(1);
            }
            Ok(ForkResult::Child) => {
                let _ = close(stdin_w);
                let _ = close(stdout_r);
                let _ = close(stderr_r);
                unsafe { prctl(PR_SET_PDEATHSIG, SIGKILL); }
                unshare(CloneFlags::CLONE_NEWNS).expect("unshare CLONE_NEWNS failed");
                mount(
                    None::<&str>, "/", None::<&str>,
                    MsFlags::MS_REC | MsFlags::MS_PRIVATE, None::<&str>,
                ).expect("make / private failed");
                let has_pid_ns = ops.iter().any(|o| matches!(o, Op::UnsharePid));
                if has_pid_ns {
                    unshare(CloneFlags::CLONE_NEWPID).expect("unshare CLONE_NEWPID failed");
                }
                for op in &ops {
                    apply_op(op).unwrap_or_else(|e| {
                        eprintln!("loopat-sandbox: {e}");
                        std::process::exit(1);
                    });
                }
                let _ = dup2(stdin_r, 0);
                let _ = dup2(stdout_w, 1);
                let _ = dup2(stderr_w, 2);
                let _ = close(stdin_r);
                let _ = close(stdout_w);
                let _ = close(stderr_w);
                let mut extra_env = Vec::new();
                let mut chdir_path: Option<String> = None;
                for op in &ops {
                    match op {
                        Op::Setenv(k, v) => extra_env.push((k.clone(), v.clone())),
                        Op::Chdir(path) => chdir_path = Some(path.clone()),
                        _ => {}
                    }
                }
                for (k, v) in &extra_env {
                    std::env::set_var(k, v);
                }
                if let Some(path) = &chdir_path {
                    chdir(path.as_str()).unwrap_or_else(|e| {
                        eprintln!("loopat-sandbox: chdir {path} failed: {e}");
                        std::process::exit(1);
                    });
                    std::env::set_var("PWD", path);
                }
                let mut cmd_exec = Command::new(&cmd[0]);
                cmd_exec.args(&cmd[1..]);
                for (k, v) in &extra_env {
                    cmd_exec.env(k, v);
                }
                let err = cmd_exec.exec();
                eprintln!("loopat-sandbox: exec {} failed: {err}", cmd[0]);
                std::process::exit(1);
            }
            Ok(ForkResult::Parent { child }) => {
                let _ = close(stdin_r);
                let _ = close(stdout_w);
                let _ = close(stderr_w);
                thread::spawn(move || proxy_stdin(stdin_w));
                thread::spawn(move || proxy_stdout(stdout_r));
                thread::spawn(move || proxy_stderr(stderr_r));
                match waitpid(child, None) {
                    Ok(WaitStatus::Exited(_, code)) => std::process::exit(code),
                    Ok(WaitStatus::Signaled(_, sig, _)) => std::process::exit(128 + sig as i32),
                    _ => std::process::exit(1),
                }
            }
        }
    }

    fn fd_pair() -> (RawFd, RawFd) {
        let (r, w) = pipe().unwrap();
        (r.into_raw_fd(), w.into_raw_fd())
    }

    fn proxy_stdin(w: RawFd) {
        let mut buf = [0u8; 65536];
        let stdin = std::io::stdin();
        let mut stdin_lock = stdin.lock();
        loop {
            match stdin_lock.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if unsafe { libc::write(w, buf.as_ptr() as *const _, n) } < 0 { break; }
                }
            }
        }
        let _ = close(w);
    }

    fn proxy_stdout(r: RawFd) {
        let mut buf = [0u8; 65536];
        let stdout = std::io::stdout();
        let mut stdout_lock = stdout.lock();
        loop {
            let n = unsafe { libc::read(r, buf.as_mut_ptr() as *mut _, buf.len()) };
            if n <= 0 { break; }
            stdout_lock.write_all(&buf[..n as usize]).ok();
            stdout_lock.flush().ok();
        }
        let _ = close(r);
    }

    fn proxy_stderr(r: RawFd) {
        let mut buf = [0u8; 65536];
        let stderr = std::io::stderr();
        let mut stderr_lock = stderr.lock();
        loop {
            let n = unsafe { libc::read(r, buf.as_mut_ptr() as *mut _, buf.len()) };
            if n <= 0 { break; }
            stderr_lock.write_all(&buf[..n as usize]).ok();
            stderr_lock.flush().ok();
        }
        let _ = close(r);
    }

    fn apply_op(op: &Op) -> Result<(), String> {
        match op {
            Op::Bind { src, dst, readonly, optional } => {
                if *optional && !std::path::Path::new(src).exists() { return Ok(()); }
                fs::create_dir_all(dst).map_err(|e| format!("mkdir {dst}: {e}"))?;
                mount(Some(src.as_str()), dst.as_str(), None::<&str>, MsFlags::MS_BIND, None::<&str>)
                    .map_err(|e| format!("bind {src} -> {dst}: {e}"))?;
                if *readonly {
                    mount(Some(dst.as_str()), dst.as_str(), None::<&str>,
                        MsFlags::MS_BIND | MsFlags::MS_REMOUNT | MsFlags::MS_RDONLY, None::<&str>)
                        .map_err(|e| format!("remount ro {dst}: {e}"))?;
                }
                Ok(())
            }
            Op::Tmpfs(dst) => {
                fs::create_dir_all(dst).map_err(|e| format!("mkdir {dst}: {e}"))?;
                mount(None::<&str>, dst.as_str(), Some("tmpfs"), MsFlags::empty(), None::<&str>)
                    .map_err(|e| format!("tmpfs {dst}: {e}"))
            }
            Op::Proc => {
                fs::create_dir_all("/proc").ok();
                mount(None::<&str>, "/proc", Some("proc"), MsFlags::empty(), None::<&str>)
                    .map_err(|e| format!("mount /proc: {e}"))
            }
            Op::Dev => {
                fs::create_dir_all("/dev").ok();
                mount(None::<&str>, "/dev", Some("devtmpfs"), MsFlags::empty(), None::<&str>)
                    .map_err(|e| format!("mount /dev: {e}"))
            }
            Op::Chdir(_) | Op::Setenv(_, _) | Op::UnsharePid => Ok(()),
        }
    }
}

#[cfg(target_os = "windows")]
mod sandbox {
    use super::{Op, parse_args};
    use std::process::{Command, Stdio};

    pub fn run_sandboxed(args: &[String]) {
        let (ops, cmd) = parse_args(args);
        if cmd.is_empty() {
            eprintln!("loopat-sandbox: no command specified");
            std::process::exit(1);
        }

        let mut extra_env: Vec<(String, String)> = Vec::new();
        for op in &ops {
            if let Op::Setenv(k, v) = op {
                extra_env.push((k.clone(), v.clone()));
            }
        }

        let mut child = Command::new(&cmd[0]);
        child.args(&cmd[1..]);
        child.stdin(Stdio::inherit());
        child.stdout(Stdio::inherit());
        child.stderr(Stdio::inherit());
        for (k, v) in &extra_env {
            child.env(k, v);
        }

        match child.spawn() {
            Err(e) => {
                eprintln!("loopat-sandbox: spawn {} failed: {e}", cmd[0]);
                let mut fallback = Command::new(&cmd[0]);
                fallback.args(&cmd[1..]);
                fallback.stdin(Stdio::inherit());
                fallback.stdout(Stdio::inherit());
                fallback.stderr(Stdio::inherit());
                match fallback.spawn() {
                    Err(e2) => {
                        eprintln!("loopat-sandbox: fallback also failed: {e2}");
                        std::process::exit(1);
                    }
                    Ok(mut c) => {
                        let exit_code = c.wait().unwrap_or_else(|e| {
                            eprintln!("loopat-sandbox: wait failed: {e}");
                            std::process::exit(1);
                        });
                        std::process::exit(exit_code.code().unwrap_or(1));
                    }
                }
            }
            Ok(mut c) => {
                let exit_code = c.wait().unwrap_or_else(|e| {
                    eprintln!("loopat-sandbox: wait failed: {e}");
                    std::process::exit(1);
                });
                std::process::exit(exit_code.code().unwrap_or(1));
            }
        }
    }
}

// macOS: use the platform sandbox-exec launcher when available. It is
// deprecated, but ai-jail has validated that this path handles interactive
// shells and developer tooling more reliably than calling sandbox_init(3)
// inside our wrapper and then exec'ing a fresh shell. Keep sandbox_init as a
// fallback for systems where sandbox-exec is absent.
#[cfg(target_os = "macos")]
mod sandbox {
    use super::{Op, parse_args};
    use std::collections::BTreeSet;
    use std::ffi::CString;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::os::unix::process::ExitStatusExt;
    use std::path::{Path, PathBuf};
    use std::process::{self, Command, Stdio};

    /// macOS system paths that must always be readable for any process to
    /// function (dynamic linker, system frameworks, temp dirs, etc.).
    const MACOS_SYSTEM_PATHS: &[&str] = &[
        "/System",
        "/Library",
        "/Applications",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/dev",
        "/private/etc",
        "/private/tmp",
        "/private/var/tmp",
        "/private/var/folders",
        "/private/var/db",
    ];

    extern "C" {
        fn sandbox_init(
            profile: *const libc::c_char,
            flags: u64,
            errorbuf: *mut *mut libc::c_char,
        ) -> libc::c_int;
        fn sandbox_free_error(errorbuf: *mut libc::c_char);
    }

    pub fn run_sandboxed(args: &[String]) {
        let (ops, cmd) = parse_args(args);
        if cmd.is_empty() {
            eprintln!("loopat-sandbox: no command specified");
            process::exit(1);
        }

        let debug = std::env::var("LOOPAT_DEBUG").is_ok();

        // Build dst→src mapping from Bind ops for path remapping.
        let mut path_map: Vec<(String, String)> = Vec::new();
        for op in &ops {
            if let Op::Bind { src, dst, .. } = op {
                if dst != src && Path::new(src).exists() {
                    path_map.push((dst.clone(), src.clone()));
                }
            }
        }
        path_map.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        if debug {
            eprintln!("[loopat-sandbox] path_map ({}) entries:", path_map.len());
            for (dst, src) in &path_map {
                eprintln!("  {dst} -> {src}");
            }
        }
        let virtual_paths_ready = prepare_virtual_paths(&path_map, debug);

        let remap = |val: &str| -> String {
            if virtual_paths_ready && Path::new(val).exists() {
                return val.to_string();
            }
            let mut v = val.to_string();
            for (dst, src) in &path_map {
                if v == *dst || v.starts_with(&format!("{dst}/")) {
                    v = src.to_string() + &v[dst.len()..];
                    break;
                }
            }
            v
        };

        // Resolve chdir with remapping.
        let chdir_resolved: Option<String> = ops.iter().find_map(|op| {
            if let Op::Chdir(path) = op {
                let resolved = remap(path);
                if Path::new(&resolved).exists() {
                    Some(resolved)
                } else {
                    None
                }
            } else {
                None
            }
        });
        if debug {
            if let Some(ref p) = chdir_resolved {
                eprintln!("[loopat-sandbox] chdir -> {p}");
            }
        }

        // Collect env vars (remapped).
        let mut envs: Vec<(String, String)> = Vec::new();
        for op in &ops {
            if let Op::Setenv(k, v) = op {
                let remapped = remap(v);
                if debug {
                    eprintln!("[loopat-sandbox] setenv {k} = {remapped}");
                }
                envs.push((k.clone(), remapped));
            }
        }

        // Generate SBPL profile.
        let profile = generate_sbpl_profile(&ops, debug);
        if debug {
            eprintln!("[loopat-sandbox] SBPL profile:\n{profile}");
        }

        if Path::new("/usr/bin/sandbox-exec").is_file() {
            run_with_sandbox_exec(&profile, &cmd, chdir_resolved.as_deref(), &envs, debug);
        }

        // ── fork ──
        match unsafe { nix::unistd::fork() } {
            Err(e) => {
                eprintln!("loopat-sandbox: fork failed: {e}");
                process::exit(1);
            }
            Ok(nix::unistd::ForkResult::Child) => {
                // ── child ──
                // Chdir
                if let Some(ref path) = chdir_resolved {
                    if let Err(e) = std::env::set_current_dir(path) {
                        eprintln!("loopat-sandbox: chdir {path} failed: {e}");
                        process::exit(1);
                    }
                }

                // Env vars
                for (k, v) in &envs {
                    std::env::set_var(k, v);
                }

                // Apply the sandbox only in the child that will exec the target.
                // The wrapper parent stays unsandboxed so waitpid/PTY plumbing
                // does not trip macOS sandbox internals and abort before exec.
                let sandbox_applied = apply_sandbox(&profile);
                if debug {
                    eprintln!("[loopat-sandbox] sandbox_init -> {sandbox_applied}");
                }
                if !sandbox_applied {
                    process::exit(1);
                }

                if debug {
                    eprintln!("[loopat-sandbox] exec -> {} {:?}", cmd[0], &cmd[1..]);
                }
                exec_direct(&cmd);
            }
            Ok(nix::unistd::ForkResult::Parent { child }) => {
                // ── parent ──
                match nix::sys::wait::waitpid(child, None) {
                    Ok(nix::sys::wait::WaitStatus::Exited(_, code)) => {
                        process::exit(code);
                    }
                    Ok(nix::sys::wait::WaitStatus::Signaled(_, sig, _)) => {
                        if std::env::var("LOOPAT_DEBUG").is_ok() {
                            eprintln!("[loopat-sandbox] child signaled: {sig}");
                        }
                        process::exit(128 + sig as i32);
                    }
                    _ => process::exit(1),
                }
            }
        }
    }

    /// Apply the SBPL sandbox profile to the current process via the
    /// macOS Sandbox kernel API (sandbox_init). Returns true if the
    /// sandbox was applied successfully, false otherwise.
    fn apply_sandbox(profile: &str) -> bool {
        let c_profile = match CString::new(profile.as_bytes()) {
            Ok(p) => p,
            Err(_) => {
                eprintln!("loopat-sandbox: SBPL profile contains null byte");
                return false;
            }
        };
        let mut error: *mut libc::c_char = std::ptr::null_mut();
        let result = unsafe {
            sandbox_init(c_profile.as_ptr(), 0, &mut error)
        };
        if result == 0 {
            return true;
        }
        let msg = if !error.is_null() {
            let s = unsafe { std::ffi::CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned();
            unsafe { sandbox_free_error(error) };
            s
        } else {
            format!("errno={}", unsafe { *libc::__error() })
        };
        eprintln!("loopat-sandbox: sandbox_init failed ({msg}) — refusing to run without isolation");
        false
    }

    fn exec_direct(cmd: &[String]) -> ! {
        let mut cstrings = Vec::with_capacity(cmd.len());
        for part in cmd {
            match CString::new(part.as_bytes()) {
                Ok(c) => cstrings.push(c),
                Err(_) => {
                    eprintln!("loopat-sandbox: exec argument contains null byte");
                    process::exit(1);
                }
            }
        }
        let mut argv: Vec<*const libc::c_char> = cstrings.iter().map(|s| s.as_ptr()).collect();
        argv.push(std::ptr::null());
        unsafe {
            libc::execvp(cstrings[0].as_ptr(), argv.as_ptr());
        }
        eprintln!(
            "loopat-sandbox: exec {} failed: {}",
            cmd[0],
            std::io::Error::last_os_error()
        );
        process::exit(1);
    }

    fn run_with_sandbox_exec(
        profile: &str,
        cmd: &[String],
        chdir: Option<&str>,
        envs: &[(String, String)],
        debug: bool,
    ) -> ! {
        if debug {
            eprintln!("[loopat-sandbox] backend -> sandbox-exec");
            eprintln!("[loopat-sandbox] exec -> {} {:?}", cmd[0], &cmd[1..]);
        }
        let mut child = Command::new("/usr/bin/sandbox-exec");
        child.arg("-p").arg(profile).arg("--");
        child.arg(&cmd[0]);
        child.args(&cmd[1..]);
        child.stdin(Stdio::inherit());
        child.stdout(Stdio::inherit());
        child.stderr(Stdio::inherit());
        if let Some(dir) = chdir {
            child.current_dir(dir);
        }
        for (k, v) in envs {
            child.env(k, v);
        }
        let mut child = match child.spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("loopat-sandbox: sandbox-exec spawn failed: {e}");
                process::exit(1);
            }
        };
        let status = match child.wait() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("loopat-sandbox: sandbox-exec wait failed: {e}");
                process::exit(1);
            }
        };
        if let Some(code) = status.code() {
            process::exit(code);
        }
        if let Some(sig) = status.signal() {
            if debug {
                eprintln!("[loopat-sandbox] sandbox-exec child signaled: {sig}");
            }
            process::exit(128 + sig);
        }
        process::exit(1);
    }

    // ── SBPL profile generation ──

    fn generate_sbpl_profile(ops: &[Op], debug: bool) -> String {
        let mut profile = String::new();
        profile.push_str("(version 1)\n");
        profile.push_str("(deny default)\n\n");

        push_static_sections(&mut profile);
        push_network_section(&mut profile);

        // Always allow reading the loopat-sandbox binary's own directory for
        // the sandbox_init fallback.
        let mut self_exe_rule = String::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                push_path_rule(&mut self_exe_rule, "allow", "file-read*", parent);
            }
        }

        push_file_access_sections(&mut profile, ops, debug);

        profile.push_str(&self_exe_rule);

        profile
    }

    /// Static sections: process, IPC, PTY, devices, IOKit.
    /// These are always allowed regardless of the sandbox config.
    fn push_static_sections(profile: &mut String) {
        profile.push_str("; Process operations\n");
        profile.push_str("(allow process-exec)\n");
        profile.push_str("(allow process-fork)\n");
        profile.push_str("(allow process-info* (target same-sandbox))\n");
        profile.push_str("(allow signal)\n");
        profile.push_str("(allow sysctl-read)\n\n");

        profile.push_str("; IPC and Mach\n");
        profile.push_str("(allow mach-lookup)\n");
        profile.push_str("(allow mach-register)\n");
        profile.push_str("(allow mach-host*)\n");
        profile.push_str("(allow ipc-posix-shm-read-data)\n");
        profile.push_str("(allow ipc-posix-shm-write-data)\n");
        profile.push_str("(allow ipc-posix-shm-read-metadata)\n");
        profile.push_str("(allow ipc-posix-shm-write-create)\n");
        profile.push_str("(allow ipc-posix-sem)\n\n");

        profile.push_str("; Pseudo-terminal and ioctl\n");
        profile.push_str("(allow pseudo-tty)\n");
        profile.push_str("(allow file-ioctl)\n");
        profile.push_str("(allow file-read* file-write* (literal \"/dev/ptmx\"))\n");
        profile.push_str("(allow file-read* file-write* (regex #\"^/dev/tty[pqrstuvwxyzPQRST][0-9a-fA-F]$\"))\n");
        profile.push_str("(allow file-read* file-write* (regex #\"^/dev/pty[pqrstuvwxyzPQRST][0-9a-fA-F]$\"))\n");
        profile.push_str("(allow file-read* file-write* (regex #\"^/dev/ttys[0-9A-Za-z]+$\"))\n\n");

        profile.push_str("; Standard devices\n");
        profile.push_str("(allow file-read* file-write* (literal \"/dev/null\"))\n");
        profile.push_str("(allow file-read* file-write* (literal \"/dev/zero\"))\n");
        profile.push_str("(allow file-read* file-write* (literal \"/dev/random\"))\n");
        profile.push_str("(allow file-read* file-write* (literal \"/dev/urandom\"))\n");
        profile.push_str("(allow file-read* file-write* (literal \"/dev/tty\"))\n");
        profile.push_str("(allow file-read* file-write* (literal \"/dev/autofs_nowait\"))\n\n");

        profile.push_str("; IOKit\n");
        profile.push_str("(allow iokit-open)\n\n");
    }

    /// Network: allow outbound, inbound, and bind.
    fn push_network_section(profile: &mut String) {
        profile.push_str("; Network\n");
        profile.push_str("(allow network-outbound)\n");
        profile.push_str("(allow network-inbound)\n");
        profile.push_str("(allow network-bind)\n");
        profile.push_str("(allow system-socket)\n\n");
    }

    /// File access sections derived from the bwrap ops.
    ///
    /// Uses a restricted allow-list approach: only paths explicitly
    /// bound via `--bind` / `--ro-bind` ops (plus essential macOS
    /// system paths) are readable/writable. Everything else is denied.
    fn push_file_access_sections(profile: &mut String, ops: &[Op], debug: bool) {
        let mut read_paths: Vec<PathBuf> = Vec::new();
        let mut write_paths: Vec<PathBuf> = Vec::new();

        // Collect paths from bwrap ops (use source path since sandbox-exec
        // shares the host filesystem — there is no mount namespace).
        for op in ops {
            if let Op::Bind {
                src,
                readonly,
                optional,
                ..
            } = op
            {
                if *optional && !Path::new(src).exists() {
                    if debug {
                        eprintln!("[loopat-sandbox] skip optional bind src \"{src}\" (not found)");
                    }
                    continue;
                }
                let p = PathBuf::from(src);
                if debug {
                    eprintln!("[loopat-sandbox] bind src \"{src}\" ro={readonly} opt={optional}");
                }
                if !read_paths.contains(&p) {
                    read_paths.push(p.clone());
                }
                if !*readonly && !write_paths.contains(&p) {
                    write_paths.push(p);
                }
            }
        }

        // Add macOS system paths as read-only (always needed).
        for p in MACOS_SYSTEM_PATHS {
            let pb = PathBuf::from(p);
            if pb.exists() && !read_paths.contains(&pb) {
                read_paths.push(pb);
            }
        }
        let virtual_root = PathBuf::from("/loopat");
        if virtual_root.exists() && !read_paths.contains(&virtual_root) {
            read_paths.push(virtual_root);
        }

        // Resolve symlinks for all paths — macOS /tmp → /private/tmp, etc.
        // Without this, a write-allow for "/tmp" is ignored by the kernel when
        // the file is actually at "/private/tmp/...", causing silent EPERM.
        let original_read_paths = read_paths.clone();
        let original_write_paths = write_paths.clone();
        let mut extra_read: Vec<PathBuf> = Vec::new();
        let mut extra_write: Vec<PathBuf> = Vec::new();
        for p in &read_paths {
            if let Ok(resolved) = p.canonicalize() {
                if resolved != *p && !read_paths.contains(&resolved) {
                    extra_read.push(resolved);
                }
            }
        }
        for p in &write_paths {
            if let Ok(resolved) = p.canonicalize() {
                if resolved != *p && !extra_write.contains(&resolved) && !write_paths.contains(&resolved) {
                    extra_write.push(resolved);
                }
            }
        }
        read_paths.extend(extra_read);
        write_paths.extend(extra_write);

        // File reads: allow-list.  Reject "/" explicitly — it would
        // defeat the entire sandbox by granting access to everything.
        profile.push_str("; File reads\n");
        push_metadata_rules(profile, &read_paths);
        push_metadata_rules(profile, &original_read_paths);
        // Bash on macOS reads the root directory during startup/path setup.
        // Allow only the root directory object itself, never `(subpath "/")`.
        push_literal_path_rule(profile, "allow", "file-read-data", Path::new("/"));
        if Path::new("/loopat").exists() {
            push_raw_path_rule(profile, "allow", "file-read*", Path::new("/loopat"));
        }
        if read_paths.is_empty() {
            profile.push('\n');
        } else {
            for path in &read_paths {
                if path == Path::new("/") {
                    eprintln!("loopat-sandbox: WARNING skipping bind src \"/\" in SBPL profile (would void isolation)");
                    continue;
                }
                push_path_rule(profile, "allow", "file-read*", path);
            }
            push_raw_symlink_rules(profile, "allow", "file-read*", &original_read_paths);
            profile.push('\n');
        }

        profile.push_str("; Executable mappings\n");
        for path in &read_paths {
            if path == Path::new("/") {
                continue;
            }
            push_path_rule(profile, "allow", "file-map-executable", path);
        }
        profile.push('\n');

        // File writes: allow-list (also guards "/").
        profile.push_str("; File writes\n");
        for path in &write_paths {
            if path == Path::new("/") {
                eprintln!("loopat-sandbox: WARNING skipping write src \"/\" in SBPL profile");
                continue;
            }
            push_path_rule(profile, "allow", "file-write*", path);
        }
        push_raw_symlink_rules(profile, "allow", "file-write*", &original_write_paths);
        profile.push('\n');

        // Debug: dump all bind src paths to help identify where "/" comes from.
        if std::env::var("LOOPAT_DEBUG").is_ok() {
            eprintln!("[loopat-sandbox] all bind src paths for SBPL:");
            for p in &read_paths {
                eprintln!("  {} (read{})", p.display(), if p == Path::new("/") { " ← ROOT!" } else { "" });
            }
        }
    }

    fn prepare_virtual_paths(path_map: &[(String, String)], debug: bool) -> bool {
        let root = Path::new("/loopat");
        if !root.exists() {
            if let Err(e) = fs::create_dir(root) {
                if debug {
                    eprintln!("[loopat-sandbox] virtual /loopat unavailable: {e}; using host paths");
                }
                return false;
            }
        }
        let mut ok = true;
        for (dst, src) in path_map {
            if !dst.starts_with("/loopat/") {
                continue;
            }
            if !ensure_virtual_symlink(Path::new(src), Path::new(dst), debug) {
                ok = false;
            }
        }
        if debug {
            eprintln!("[loopat-sandbox] virtual paths -> {ok}");
        }
        ok
    }

    fn ensure_virtual_symlink(src: &Path, dst: &Path, debug: bool) -> bool {
        if let Some(parent) = dst.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                if debug {
                    eprintln!("[loopat-sandbox] mkdir {} failed: {e}", parent.display());
                }
                return false;
            }
        }
        match fs::symlink_metadata(dst) {
            Ok(meta) if meta.file_type().is_symlink() => match fs::read_link(dst) {
                Ok(existing) if existing == src => true,
                Ok(existing) => {
                    if debug {
                        eprintln!(
                            "[loopat-sandbox] stale virtual link {} -> {}, expected {}",
                            dst.display(),
                            existing.display(),
                            src.display()
                        );
                    }
                    if let Err(e) = fs::remove_file(dst) {
                        if debug {
                            eprintln!("[loopat-sandbox] remove {} failed: {e}", dst.display());
                        }
                        return false;
                    }
                    create_virtual_symlink(src, dst, debug)
                }
                Err(e) => {
                    if debug {
                        eprintln!("[loopat-sandbox] readlink {} failed: {e}", dst.display());
                    }
                    false
                }
            },
            Ok(_) => {
                if debug {
                    eprintln!("[loopat-sandbox] virtual path {} exists and is not a symlink", dst.display());
                }
                dst.exists()
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => create_virtual_symlink(src, dst, debug),
            Err(e) => {
                if debug {
                    eprintln!("[loopat-sandbox] stat {} failed: {e}", dst.display());
                }
                false
            }
        }
    }

    fn create_virtual_symlink(src: &Path, dst: &Path, debug: bool) -> bool {
        match symlink(src, dst) {
            Ok(()) => {
                if debug {
                    eprintln!("[loopat-sandbox] virtual link {} -> {}", dst.display(), src.display());
                }
                true
            }
            Err(e) => {
                if debug {
                    eprintln!("[loopat-sandbox] symlink {} -> {} failed: {e}", dst.display(), src.display());
                }
                false
            }
        }
    }

    fn push_metadata_rules(profile: &mut String, paths: &[PathBuf]) {
        let mut ancestors = BTreeSet::<PathBuf>::new();
        for path in paths {
            let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            for ancestor in canonical.ancestors() {
                ancestors.insert(ancestor.to_path_buf());
            }
        }
        for path in ancestors {
            push_literal_path_rule(profile, "allow", "file-read-metadata", &path);
        }
    }

    fn push_raw_symlink_rules(profile: &mut String, verb: &str, action: &str, paths: &[PathBuf]) {
        for path in paths {
            if path == Path::new("/") {
                continue;
            }
            if let Ok(canonical) = std::fs::canonicalize(path) {
                if canonical != *path {
                    push_literal_path_rule(profile, verb, action, path);
                }
            }
        }
    }

    /// Emit a single SBPL allow or deny rule for a path.
    /// Uses `subpath` for directories or non-existent paths, `literal` for files.
    fn push_path_rule(profile: &mut String, verb: &str, action: &str, path: &Path) {
        let canonical =
            std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if canonical == Path::new("/") {
            eprintln!("loopat-sandbox: WARNING skipping canonical path \"/\" in SBPL profile (would void isolation)");
            return;
        }
        let escaped = sbpl_escape(canonical.to_string_lossy().as_ref());
        let pattern = if canonical.is_dir() || !canonical.exists() {
            "subpath"
        } else {
            "literal"
        };
        profile.push_str(&format!(
            "({verb} {action} ({pattern} \"{escaped}\"))\n"
        ));
    }

    fn push_literal_path_rule(profile: &mut String, verb: &str, action: &str, path: &Path) {
        let escaped = sbpl_escape(path.to_string_lossy().as_ref());
        profile.push_str(&format!(
            "({verb} {action} (literal \"{escaped}\"))\n"
        ));
    }

    fn push_raw_path_rule(profile: &mut String, verb: &str, action: &str, path: &Path) {
        let escaped = sbpl_escape(path.to_string_lossy().as_ref());
        profile.push_str(&format!(
            "({verb} {action} (subpath \"{escaped}\"))\n"
        ));
    }

    /// Escape a string for SBPL (backslash, quote, control chars).
    fn sbpl_escape(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        for c in input.chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                _ => out.push(c),
            }
        }
        out
    }
}

// ── shared arg parsing ──

#[derive(Debug)]
enum Op {
    Bind { src: String, dst: String, readonly: bool, optional: bool },
    Tmpfs(String),
    Proc,
    Dev,
    Chdir(String),
    Setenv(String, String),
    UnsharePid,
}

fn parse_args(args: &[String]) -> (Vec<Op>, Vec<String>) {
    let mut ops = Vec::new();
    let mut cmd: Vec<String> = Vec::new();
    let mut i = 0;
    let mut after_dash = false;

    while i < args.len() {
        let a = &args[i];
        if after_dash {
            cmd.push(a.clone());
            i += 1;
            continue;
        }
        match a.as_str() {
            "--" => { after_dash = true; i += 1; }
            "--bind" | "--bind-try" => {
                let src = args.get(i + 1).cloned().unwrap_or_default();
                let dst = args.get(i + 2).cloned().unwrap_or_default();
                ops.push(Op::Bind { src, dst, readonly: false, optional: a == "--bind-try" });
                i += 3;
            }
            "--ro-bind" | "--ro-bind-try" => {
                let src = args.get(i + 1).cloned().unwrap_or_default();
                let dst = args.get(i + 2).cloned().unwrap_or_default();
                ops.push(Op::Bind { src, dst, readonly: true, optional: a == "--ro-bind-try" });
                i += 3;
            }
            "--tmpfs" => {
                let dst = args.get(i + 1).cloned().unwrap_or_default();
                ops.push(Op::Tmpfs(dst));
                i += 2;
            }
            "--proc" => { ops.push(Op::Proc); i += 2; }
            "--dev" => { ops.push(Op::Dev); i += 2; }
            "--chdir" => {
                let dir = args.get(i + 1).cloned().unwrap_or_default();
                ops.push(Op::Chdir(dir));
                i += 2;
            }
            "--setenv" => {
                let k = args.get(i + 1).cloned().unwrap_or_default();
                let v = args.get(i + 2).cloned().unwrap_or_default();
                ops.push(Op::Setenv(k, v));
                i += 3;
            }
            "--unshare-pid" => { ops.push(Op::UnsharePid); i += 1; }
            "--new-session" | "--die-with-parent" => { i += 1; }
            "--version" => {
                println!("loopat-sandbox {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            _ => {
                cmd.push(a.clone());
                i += 1;
                break;
            }
        }
    }
    while i < args.len() {
        cmd.push(args[i].clone());
        i += 1;
    }
    (ops, cmd)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    sandbox::run_sandboxed(&args[1..]);
}
