use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};

// ── Config ───────────────────────────────────────────────────────
static SERVE_PORT: LazyLock<u16> =
    LazyLock::new(|| std::env::var("LOOPAT_SERVE_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(7788));
const SERVE_HOST: &str = "0.0.0.0";

fn loops_dir() -> PathBuf {
    PathBuf::from(
        std::env::var("LOOPAT_LOOPS_DIR").unwrap_or_else(|_| "/loopat/loops".into()),
    )
}

fn workspace() -> String {
    std::env::var("LOOPAT_WORKSPACE").unwrap_or_else(|_| "loopat".into())
}

fn container_name(loop_id: &str) -> String {
    format!("loopat-{}-{}", workspace(), loop_id)
}

// ── Blocked paths ─────────────────────────────────────────────────
const BLOCKED: &[&str] = &[
    ".git", ".ssh", ".env", "node_modules", ".DS_Store", ".bun", ".claude", ".vscode",
    ".idea",
];

fn is_blocked(path: &str) -> bool {
    path.split('/').any(|p| BLOCKED.contains(&p) || p.starts_with(".env"))
}

// ── MIME ──────────────────────────────────────────────────────────
fn mime_type(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    match ext {
        "html" => "text/html",
        "css" => "text/css",
        "js" => "application/javascript",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "eot" => "application/vnd.ms-fontobject",
        "otf" => "font/otf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "tar" => "application/x-tar",
        "gz" => "application/gzip",
        "wasm" => "application/wasm",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "csv" => "text/csv",
        "yaml" | "yml" => "text/yaml",
        "toml" => "text/toml",
        _ => "application/octet-stream",
    }
}

// ── Loop metadata ─────────────────────────────────────────────────
#[derive(Deserialize)]
struct LoopMeta {
    #[serde(default)]
    #[allow(dead_code)]
    title: String,
    #[serde(rename = "shareEnabled", default)]
    share_enabled: bool,
    #[serde(rename = "shareMode", default)]
    share_mode: String,
    #[serde(rename = "shareAlias", default)]
    share_alias: Option<String>,
    #[serde(rename = "sharePort")]
    share_port: Option<u16>,
}

fn load_meta(loop_id: &str) -> Option<LoopMeta> {
    let p = loops_dir().join(loop_id).join("meta.json");
    let bytes = fs::read(p).ok()?;
    serde_json::from_slice(&bytes).ok()
}

// ── Alias cache ───────────────────────────────────────────────────
struct Cache {
    aliases: HashMap<String, String>,
    last_rebuild: Instant,
}

impl Cache {
    fn new() -> Self {
        let mut c = Self { aliases: HashMap::new(), last_rebuild: Instant::now() };
        c.rebuild();
        c
    }

    fn rebuild(&mut self) {
        self.aliases.clear();
        let dir = loops_dir();
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let loop_id = entry.file_name().to_string_lossy().to_string();
            if let Some(meta) = load_meta(&loop_id) {
                if meta.share_enabled {
                    if let Some(ref alias) = meta.share_alias {
                        self.aliases.insert(alias.clone(), loop_id.clone());
                    }
                }
            }
        }
        self.last_rebuild = Instant::now();
    }

    fn maybe_rebuild(&mut self) {
        if self.last_rebuild.elapsed() > Duration::from_secs(30) {
            self.rebuild();
        }
    }

    fn resolve(&mut self, subdomain: &str) -> Option<String> {
        // Check alias cache
        if let Some(id) = self.aliases.get(subdomain).cloned() {
            let meta = load_meta(&id);
            if meta.map_or(false, |m| m.share_enabled) {
                return Some(id);
            }
            self.aliases.remove(subdomain);
        }

        // Scan loops
        let dir = loops_dir();
        for entry in fs::read_dir(&dir).ok()?.flatten() {
            let loop_id = entry.file_name().to_string_lossy().to_string();
            let short_id = &loop_id[..loop_id.len().min(8)];
            if short_id != subdomain {
                continue;
            }
            let meta = load_meta(&loop_id)?;
            if !meta.share_enabled {
                return None;
            }
            if let Some(ref alias) = meta.share_alias {
                self.aliases.insert(alias.clone(), loop_id.clone());
            }
            return Some(loop_id);
        }
        // Fallback: scan by alias
        for entry in fs::read_dir(&dir).ok()?.flatten() {
            let loop_id = entry.file_name().to_string_lossy().to_string();
            let meta = load_meta(&loop_id)?;
            if !meta.share_enabled {
                continue;
            }
            if meta.share_alias.as_deref() == Some(subdomain) {
                self.aliases.insert(subdomain.to_string(), loop_id.clone());
                return Some(loop_id);
            }
        }
        None
    }
}

type CacheRef = Arc<Mutex<Cache>>;

// ── HTTP response helpers ─────────────────────────────────────────

/// HTML error page with inline styles — works in any browser, no external deps.
fn error_page(code: u16, title: &str, detail: &str) -> String {
    let color = if code >= 500 { "#dc2626" } else { "#d97706" };
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{code} — {title}</title>
<style>
  * {{ margin:0; padding:0; box-sizing:border-box }}
  body {{ font-family: system-ui,-apple-system,sans-serif; background:#fafafa; color:#1f2937; display:flex; align-items:center; justify-content:center; min-height:100vh }}
  .card {{ background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:40px 48px; max-width:520px; width:90%; text-align:center; box-shadow:0 1px 3px rgba(0,0,0,.04) }}
  .code {{ font-size:64px; font-weight:800; color:{color}; line-height:1; margin-bottom:8px }}
  .title {{ font-size:18px; font-weight:600; margin-bottom:12px }}
  .detail {{ font-size:14px; color:#6b7280; line-height:1.6 }}
  .hint {{ font-size:12px; color:#9ca3af; margin-top:20px; padding-top:16px; border-top:1px solid #f3f4f6 }}
  .hint code {{ font-size:11px; background:#f3f4f6; padding:2px 6px; border-radius:4px }}
</style>
</head>
<body>
<div class="card">
  <div class="code">{code}</div>
  <div class="title">{title}</div>
  <div class="detail">{detail}</div>
  <div class="hint">loopat workspace serve</div>
</div>
</body>
</html>"#
    )
}

fn reply_html(stream: &mut dyn Write, code: u16, reason: &str, html: &str) {
    let _ = write!(stream, "HTTP/1.1 {code} {reason}\r\n");
    let _ = write!(stream, "Content-Type: text/html; charset=utf-8\r\n");
    let _ = write!(stream, "Content-Length: {}\r\n", html.len());
    let _ = write!(stream, "Connection: close\r\n\r\n");
    let _ = stream.write_all(html.as_bytes());
}

fn reply_error(stream: &mut dyn Write, code: u16, reason: &str, title: &str, detail: &str) {
    let html = error_page(code, title, detail);
    reply_html(stream, code, reason, &html);
}

// ── Static file serving ───────────────────────────────────────────
fn serve_static(stream: &mut dyn Write, workdir: &Path, url_path: &str) {
    let rel = url_path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };

    let full = workdir.join(rel);
    let canonical = match full.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let with_index = full.join("index.html");
            if with_index.exists() {
                return serve_static(stream, workdir, &format!("/{rel}/index.html"));
            }
            return reply_error(stream, 404, "Not Found", "File not found", "The requested path does not exist in this workspace.");
        }
    };
    let canonical_workdir = match workdir.canonicalize() {
        Ok(c) => c,
        Err(_) => return reply_error(stream, 500, "Internal Server Error", "Workdir error", "Cannot resolve the workspace directory."),
    };
    if !canonical.starts_with(&canonical_workdir) {
        return reply_error(stream, 403, "Forbidden", "Access denied", "Path traversal is not allowed.");
    }

    if is_blocked(rel) {
        return reply_error(stream, 403, "Forbidden", "Access denied", "This path is blocked for security reasons.");
    }

    if canonical.is_dir() {
        let index = canonical.join("index.html");
        if index.exists() {
            return serve_static(stream, workdir, &format!("/{rel}/index.html"));
        }
        return reply_error(stream, 403, "Forbidden", "Directory listing disabled", "Directory listings are not allowed. Append /index.html if the file exists.");
    }

    let data = match fs::read(&canonical) {
        Ok(d) => d,
        Err(_) => return reply_error(stream, 500, "Internal Server Error", "Read error", "Failed to read the requested file."),
    };
    let mime = mime_type(rel);

    let _ = write!(stream, "HTTP/1.1 200 OK\r\n");
    let _ = write!(stream, "Content-Type: {mime}\r\n");
    let _ = write!(stream, "Content-Length: {}\r\n", data.len());
    let _ = write!(stream, "Cache-Control: no-cache\r\n");
    let _ = write!(stream, "Connection: close\r\n\r\n");
    let _ = stream.write_all(&data);
}

// ── HTTP proxy ────────────────────────────────────────────────────
fn apply_headers<B>(
    mut req: ureq::RequestBuilder<B>,
    headers: &[(String, String)],
    target: &str,
    port: u16,
) -> ureq::RequestBuilder<B> {
    for (key, value) in headers {
        match key.to_lowercase().as_str() {
            "host" | "connection" | "keep-alive" | "transfer-encoding" | "te"
            | "trailer" | "upgrade" => continue,
            _ => {
                req = req.header(key, value);
            }
        }
    }
    req = req.header("host", &format!("{target}:{port}"));
    req = req.header("x-forwarded-proto", "http");
    req
}

fn proxy_to_port(
    stream: &mut dyn Write,
    loop_id: &str,
    port: u16,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: Option<&[u8]>,
) {
    let target = container_name(loop_id);
    let url = format!("http://{target}:{port}{path}");
    eprintln!("[serve] proxy → {target}:{port}{path}");

    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .proxy(None)
            .timeout_per_call(Some(Duration::from_secs(30)))
            .build(),
    );

    let has_body = body.map_or(false, |b| !b.is_empty());

    let result = match (method, has_body) {
        ("GET", _) | ("HEAD", _) | ("OPTIONS", _) | ("DELETE", _) => {
            let req = match method {
                "GET" => agent.get(&url),
                "HEAD" => agent.head(&url),
                "OPTIONS" => agent.options(&url),
                "DELETE" => agent.delete(&url),
                _ => agent.get(&url),
            };
            apply_headers(req, headers, &target, port).call()
        }
        _ => {
            let req = match method {
                "POST" => agent.post(&url),
                "PUT" => agent.put(&url),
                "PATCH" => agent.patch(&url),
                _ => agent.post(&url),
            };
            let b = body.unwrap_or(&[]);
            apply_headers(req, headers, &target, port).send(b)
        }
    };

    let resp = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[serve] proxy error → {target}:{port}: {e}");
            let detail = format!("The service on port {port} is not responding. Make sure your app is running inside the sandbox.");
            return reply_error(stream, 502, "Bad Gateway", "Service not reachable", &detail);
        }
    };

    let status = resp.status().as_u16();
    let reason = resp.status().canonical_reason().unwrap_or("Unknown");

    let _ = write!(stream, "HTTP/1.1 {status} {reason}\r\n");

    let skip: HashSet<&str> = [
        "connection", "keep-alive", "transfer-encoding", "content-encoding",
        "content-length",
    ]
    .into();

    for (key, value) in resp.headers().iter() {
        let key_str = key.as_str();
        if !skip.contains(key_str.to_lowercase().as_str()) {
            let v = value.to_str().unwrap_or("");
            let _ = write!(stream, "{key_str}: {v}\r\n");
        }
    }

    let resp_body = resp.into_body().read_to_vec().unwrap_or_default();
    let _ = write!(stream, "Content-Length: {}\r\n", resp_body.len());
    let _ = write!(stream, "Connection: close\r\n\r\n");
    let _ = stream.write_all(&resp_body);
}

// ── Request parsing ───────────────────────────────────────────────
struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
}

fn parse_request(stream: &mut dyn Read) -> Option<Request> {
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).ok()?;
    if n == 0 {
        return None;
    }
    let raw = String::from_utf8_lossy(&buf[..n]);

    let parts: Vec<&str> = raw.split("\r\n\r\n").collect();
    let header_section = parts.first()?;
    let body_offset = header_section.len() + 4;

    let mut lines = header_section.lines();
    let first_line = lines.next()?;
    let mut fl_parts = first_line.split_whitespace();
    let method = fl_parts.next()?.to_string();
    let path = fl_parts.next()?.to_string();

    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(": ") {
            headers.push((k.to_string(), v.to_string()));
        }
    }

    let body = headers
        .iter()
        .find(|(k, _)| k.to_lowercase() == "content-length")
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .and_then(|len| {
            if raw.len() >= body_offset + len {
                Some(raw[body_offset..body_offset + len].as_bytes().to_vec())
            } else {
                None
            }
        });

    Some(Request { method, path, headers, body })
}

// ── Request handler ───────────────────────────────────────────────
fn handle(stream: &mut dyn Write, req: &Request, cache: &CacheRef) {
    let host = req
        .headers
        .iter()
        .find(|(k, _)| k.to_lowercase() == "host")
        .map(|(_, v)| v.as_str())
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase();

    let subdomain = host.split('.').next().unwrap_or("");

    let mut cache = cache.lock().unwrap();
    cache.maybe_rebuild();
    let resolved = cache.resolve(subdomain);
    drop(cache);

    let loop_id = match resolved {
        Some(id) => id,
        None => {
            eprintln!("[serve] 404 host={host} — no matching loop");
            return reply_error(stream, 404, "Not Found", "No workspace found",
                "No shared workspace matches this domain. Check the URL or make sure sharing is enabled for this loop.");
        }
    };

    let meta = match load_meta(&loop_id) {
        Some(m) => m,
        None => return reply_error(stream, 404, "Not Found", "Loop not found", "The workspace metadata is missing. The loop may have been deleted."),
    };

    if !meta.share_enabled {
        return reply_error(stream, 403, "Forbidden", "Sharing disabled", "Sharing is currently turned off for this workspace. Enable it in the Share Artifact dialog.");
    }

    let workdir = loops_dir().join(&loop_id).join("workdir");
    if !workdir.is_dir() {
        return reply_error(stream, 404, "Not Found", "Workdir not found", "The workspace workdir does not exist. Try sending a message to initialize it.");
    }

    let mode = meta.share_mode.as_str();
    eprintln!("[serve] {host} → {:.8} mode={mode} path={}", loop_id, req.path);

    if mode == "port" {
        if let Some(port) = meta.share_port {
            if port < 1024 {
                return reply_error(stream, 400, "Bad Request", "Invalid port", "Port must be 1024 or higher. Update the port in the Share Artifact dialog.");
            }
            proxy_to_port(
                stream,
                &loop_id,
                port,
                &req.method,
                &req.path,
                &req.headers,
                req.body.as_deref(),
            );
            return;
        }
    }
    serve_static(stream, &workdir, &req.path);
}

// ── Main ──────────────────────────────────────────────────────────
fn main() {
    let cache: CacheRef = Arc::new(Mutex::new(Cache::new()));

    let addr = format!("{SERVE_HOST}:{}", *SERVE_PORT);
    let listener = TcpListener::bind(&addr).unwrap_or_else(|e| {
        eprintln!("[serve] failed to bind {addr}: {e}");
        std::process::exit(1);
    });
    eprintln!("[serve] listening on http://{addr}");

    for conn in listener.incoming() {
        let cache = cache.clone();
        thread::spawn(move || {
            let mut stream = match conn {
                Ok(s) => s,
                Err(_) => return,
            };
            stream.set_read_timeout(Some(Duration::from_secs(30))).ok();

            let req = match parse_request(&mut &stream) {
                Some(r) => r,
                None => return,
            };

            eprintln!(
                "[serve] {} - \"{} {}\"",
                stream.peer_addr().map(|a| a.to_string()).unwrap_or_default(),
                req.method,
                req.path
            );

            let mut buf = Vec::new();
            handle(&mut buf, &req, &cache);
            let _ = stream.write_all(&buf);
        });
    }
}
