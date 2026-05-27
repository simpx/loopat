use notify::{EventKind, RecursiveMode, Watcher};
use serde::Deserialize;
use std::collections::HashMap;
use std::io;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

// ── Config ───────────────────────────────────────────────────────
fn loops_dir() -> PathBuf {
    PathBuf::from(std::env::var("LOOPAT_LOOPS_DIR").unwrap_or_else(|_| "/loopat/loops".into()))
}

fn workspace() -> String {
    std::env::var("LOOPAT_WORKSPACE").unwrap_or_else(|_| "loopat".into())
}

fn container_name(loop_id: &str) -> String {
    format!("loopat-{}-{}", workspace(), loop_id)
}

// ── Loop metadata ─────────────────────────────────────────────────
#[derive(Deserialize, Debug, Clone)]
struct LoopMeta {
    #[serde(rename = "shareEnabled", default)]
    share_enabled: bool,
    #[serde(rename = "sharePort")]
    share_port: Option<u16>,
    #[serde(rename = "shareExternalPort")]
    share_external_port: Option<u16>,
    #[serde(rename = "shareProtocol", default)]
    share_protocol: String,
}

fn load_meta(loop_id: &str) -> Option<LoopMeta> {
    let p = loops_dir().join(loop_id).join("meta.json");
    let bytes = std::fs::read(p).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// ── Port mapping ──────────────────────────────────────────────────
#[derive(Debug, Clone, PartialEq, Eq)]
struct PortMapping {
    external_port: u16,
    loop_id: String,
    container: String,
    internal_port: u16,
    protocol: String,
}

fn collect_mappings() -> Vec<PortMapping> {
    let dir = loops_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let loop_id = entry.file_name().to_string_lossy().to_string();
        if let Some(meta) = load_meta(&loop_id) {
            if meta.share_enabled {
                if let (Some(ext), Some(int)) = (meta.share_external_port, meta.share_port) {
                    let proto = match meta.share_protocol.as_str() {
                        "udp" => "udp",
                        "static" => "static",
                        _ => "tcp",
                    };
                    out.push(PortMapping {
                        external_port: ext,
                        loop_id: loop_id.clone(),
                        container: container_name(&loop_id),
                        internal_port: int,
                        protocol: proto.to_string(),
                    });
                }
            }
        }
    }
    out.sort_by_key(|m| m.external_port);
    out
}

// ── TCP relay ─────────────────────────────────────────────────────
fn spawn_tcp_relay(port: u16, container: String, internal_port: u16) {
    thread::spawn(move || {
        let addr = format!("0.0.0.0:{port}");
        let listener = match TcpListener::bind(&addr) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[port-proxy] TCP bind {addr} failed: {e}");
                return;
            }
        };
        eprintln!("[port-proxy] TCP {port} → {container}:{internal_port}");

        for conn in listener.incoming() {
            let mut client = match conn {
                Ok(c) => c,
                Err(_) => continue,
            };
            let peer = client.peer_addr().map(|a| a.to_string()).unwrap_or_default();
            eprintln!("[port-proxy] TCP {port} connect from {peer}");
            let target = format!("{container}:{internal_port}");
            let mut upstream = match TcpStream::connect(&target) {
                Ok(u) => u,
                Err(e) => {
                    eprintln!("[port-proxy] TCP {port} connect upstream {target} failed: {e}");
                    continue;
                }
            };
            let mut c2 = client.try_clone().unwrap();
            let mut u2 = upstream.try_clone().unwrap();
            let t1 = thread::spawn(move || { let n = io::copy(&mut client, &mut upstream).unwrap_or(0); eprintln!("[port-proxy] TCP {port} client→upstream {n}B"); });
            let t2 = thread::spawn(move || { let n = io::copy(&mut u2, &mut c2).unwrap_or(0); eprintln!("[port-proxy] TCP {port} upstream→client {n}B"); });
            t1.join().ok();
            t2.join().ok();
            eprintln!("[port-proxy] TCP {port} disconnect {peer}");
        }
    });
}

// ── UDP relay ─────────────────────────────────────────────────────
fn spawn_udp_relay(port: u16, container: String, internal_port: u16) {
    thread::spawn(move || {
        let addr = format!("0.0.0.0:{port}");
        let sock = match UdpSocket::bind(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[port-proxy] UDP bind {addr} failed: {e}");
                return;
            }
        };
        let target = format!("{container}:{internal_port}");
        eprintln!("[port-proxy] UDP {port} → {target}");
        sock.set_read_timeout(Some(Duration::from_secs(1))).ok();
        let mut buf = [0u8; 65536];
        loop {
            match sock.recv_from(&mut buf) {
                Ok((n, src)) => {
                    if let Ok(upstream) = UdpSocket::bind("0.0.0.0:0") {
                        upstream.set_read_timeout(Some(Duration::from_millis(500))).ok();
                        if let Ok(_) = upstream.send_to(&buf[..n], &target) {
                            let mut rbuf = [0u8; 65536];
                            if let Ok((rn, _)) = upstream.recv_from(&mut rbuf) {
                                sock.send_to(&rbuf[..rn], src).ok();
                            }
                        }
                    }
                }
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => continue,
                Err(_) => break,
            }
        }
    });
}

// ── Static file server ─────────────────────────────────────────────
fn spawn_static_server(port: u16, loop_id: String) {
    thread::spawn(move || {
        let addr = format!("0.0.0.0:{port}");
        let listener = match TcpListener::bind(&addr) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[port-proxy] static bind {addr} failed: {e}");
                return;
            }
        };
        let workdir = loops_dir().join(&loop_id).join("workdir");
        eprintln!("[port-proxy] static {port} → {loop_id}");

        for conn in listener.incoming() {
            let mut stream = match conn {
                Ok(c) => c,
                Err(_) => continue,
            };
            stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
            let mut reader = BufReader::new(stream.try_clone().unwrap());

            let mut line = String::new();
            if reader.read_line(&mut line).is_err() { continue; }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 2 { continue; }
            let path = parts[1];

            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).is_err() { break; }
                if h.trim().is_empty() { break; }
            }

            let rel = path.trim_start_matches('/');
            let rel = if rel.is_empty() { "index.html" } else { rel };
            let full = workdir.join(rel);
            let canonical = match full.canonicalize() {
                Ok(c) => c,
                Err(_) => { respond(&mut stream, 404, "Not Found", b"Not found"); continue; }
            };
            let canonical_wd = match workdir.canonicalize() {
                Ok(c) => c,
                Err(_) => { respond(&mut stream, 500, "Internal Server Error", b"Workdir error"); continue; }
            };
            if !canonical.starts_with(&canonical_wd) {
                respond(&mut stream, 403, "Forbidden", b"Forbidden"); continue;
            }
            if canonical.is_dir() {
                let index = canonical.join("index.html");
                if index.is_file() {
                    match std::fs::read(&index) {
                        Ok(data) => respond(&mut stream, 200, "OK", &data),
                        Err(_) => respond(&mut stream, 500, "Internal Server Error", b"Read error"),
                    }
                } else {
                    respond(&mut stream, 403, "Forbidden", b"Directory listing not allowed");
                }
                continue;
            }
            match std::fs::read(&canonical) {
                Ok(data) => respond(&mut stream, 200, "OK", &data),
                Err(_) => respond(&mut stream, 500, "Internal Server Error", b"Read error"),
            }
        }
    });
}

fn respond(stream: &mut TcpStream, code: u16, reason: &str, body: &[u8]) {
    let _ = write!(stream, "HTTP/1.1 {code} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(body);
}

// ── Listener lifecycle ────────────────────────────────────────────
type ListenerMap = Arc<Mutex<HashMap<u16, thread::JoinHandle<()>>>>;

fn sync_listeners(listeners: &ListenerMap, mappings: &[PortMapping]) {
    let mut guard = listeners.lock().unwrap();
    let desired: HashMap<u16, &PortMapping> = mappings.iter().map(|m| (m.external_port, m)).collect();

    let before = guard.len();
    guard.retain(|port, _handle| {
        if desired.contains_key(port) {
            true
        } else {
            eprintln!("[port-proxy] removing listener on port {port}");
            false
        }
    });

    for m in mappings {
        if guard.contains_key(&m.external_port) {
            continue;
        }
        let handle = match m.protocol.as_str() {
            "udp" => {
                let (port, container, internal) = (m.external_port, m.container.clone(), m.internal_port);
                thread::spawn(move || spawn_udp_relay(port, container, internal))
            }
            "static" => {
                let (port, loop_id) = (m.external_port, m.loop_id.clone());
                thread::spawn(move || spawn_static_server(port, loop_id))
            }
            _ => {
                let (port, container, internal) = (m.external_port, m.container.clone(), m.internal_port);
                thread::spawn(move || spawn_tcp_relay(port, container, internal))
            }
        };
        guard.insert(m.external_port, handle);
    }

    let after = guard.len();
    if before != after || !mappings.is_empty() {
        let active: Vec<u16> = guard.keys().copied().collect();
        eprintln!("[port-proxy] sync {before}→{after} listeners: {active:?}");
    }
}

// ── File watcher ──────────────────────────────────────────────────
fn watch_loops(listeners: ListenerMap) -> notify::Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx)?;
    // NonRecursive avoids permission errors from workdir subdirectories.
    // Catches: loop dir create/delete, plus .port-proxy-trigger touches.
    watcher.watch(&loops_dir(), RecursiveMode::NonRecursive)?;

    eprintln!("[port-proxy] watching {}", loops_dir().display());

    // Initial sync
    sync_listeners(&listeners, &collect_mappings());

    for event in rx {
        let Ok(event) = event else { continue };
        match event.kind {
            EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_) => {
                // Trigger on: loop dir create/remove, .port-proxy-trigger touched,
                // or any change directly inside the watched loops dir.
                let relevant = event.paths.iter().any(|p| {
                    *p == loops_dir() || p.parent().map_or(false, |par| par == loops_dir())
                });
                if relevant {
                    eprintln!("[port-proxy] trigger: {}", event.paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", "));
                    thread::sleep(Duration::from_millis(200));
                    sync_listeners(&listeners, &collect_mappings());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

// ── Main ──────────────────────────────────────────────────────────
fn main() {
    eprintln!("[port-proxy] starting");
    let listeners: ListenerMap = Arc::new(Mutex::new(HashMap::new()));
    if let Err(e) = watch_loops(listeners) {
        eprintln!("[port-proxy] watcher error: {e}");
    }
}
