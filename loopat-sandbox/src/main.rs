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

        let mut chdir_path: Option<String> = None;
        let mut extra_env: Vec<(String, String)> = Vec::new();
        for op in &ops {
            match op {
                Op::Setenv(k, v) => extra_env.push((k.clone(), v.clone())),
                Op::Chdir(path) => chdir_path = Some(path.clone()),
                _ => {}
            }
        }

        eprintln!("[loopat-sandbox] cmd[0]={}", cmd[0]);
        eprintln!("[loopat-sandbox] cmd.len={}", cmd.len());
        eprintln!("[loopat-sandbox] extra_env.len={}", extra_env.len());
        eprintln!("[loopat-sandbox] chdir={:?}", chdir_path);

        let mut child = Command::new(&cmd[0]);
        child.args(&cmd[1..]);
        child.stdin(Stdio::inherit());
        child.stdout(Stdio::inherit());
        child.stderr(Stdio::inherit());
        for (k, v) in &extra_env {
            child.env(k, v);
        }
        // Windows: no bwrap sandbox, chdir paths like /loopat/loop/... are
        // Linux-virtual paths that don't exist here — skip unconditionally.
        #[cfg(not(target_os = "windows"))]
        if let Some(path) = &chdir_path {
            child.current_dir(path);
        }

        match child.spawn() {
            Err(e) => {
                eprintln!("loopat-sandbox: spawn {} failed: {e}", cmd[0]);
                // Retry without env overrides in case an env value is causing issues
                eprintln!("[loopat-sandbox] retrying without extra env vars...");
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
