/// VM manager: creates and monitors a Linux VM using Apple's Virtualization.framework
/// natively (no external vfkit binary needed).
///
/// Architecture:
/// - A Linux VM is created directly via Virtualization.framework (ObjC bridge)
/// - The VM shares ~/.loopat from the host via virtiofs (tag: loopat-home)
/// - NAT networking exposes the VM to the host network (192.168.64.x range)
/// - VM console output is captured via a pipe and written to a log file,
///   then polled by the host for the ready signal
/// - On first run the compressed disk image is decompressed to app data dir
use std::ffi::{CStr, CString};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// Opaque context type from the ObjC bridge
type VmCtx = *mut std::ffi::c_void;

extern "C" {
    fn vm_create(
        kernel_path: *const std::ffi::c_char,
        initrd_path: *const std::ffi::c_char,
        cmdline: *const std::ffi::c_char,
        rootfs_path: *const std::ffi::c_char,
        cpus: u32,
        memory_mb: u64,
        log_path: *const std::ffi::c_char,
    ) -> VmCtx;

    fn vm_add_shared_dir(ctx: VmCtx, host_path: *const std::ffi::c_char, tag: *const std::ffi::c_char) -> i32;
    fn vm_start(ctx: VmCtx) -> i32;
    fn vm_is_running(ctx: VmCtx) -> bool;
    fn vm_stop(ctx: VmCtx) -> i32;
    fn vm_get_error(ctx: VmCtx) -> *const std::ffi::c_char;
    fn vm_create_error() -> *const std::ffi::c_char;
    fn vm_destroy(ctx: VmCtx);
}

/// How many CPU cores and RAM (MiB) to give the VM.
const VM_CPUS: u32 = 2;
const VM_MEMORY_MIB: u32 = 2048;

pub struct VmManager {
    ctx: Option<VmCtx>,
    log_path: PathBuf,
    log_offset: u64,
}

unsafe impl Send for VmManager {}

impl VmManager {
    pub fn new() -> Self {
        Self {
            ctx: None,
            log_path: std::env::temp_dir().join("loopat-vm.log"),
            log_offset: 0,
        }
    }

    pub fn prepare(&self, resources_dir: &Path) -> Result<PathBuf, String> {
        prepare_data_dir(resources_dir)
    }

    pub fn start(&mut self, _resources_dir: &Path, data_dir: PathBuf, loopat_home: PathBuf) -> Result<(), String> {
        let kernel = data_dir.join("vmlinuz");
        let initrd = data_dir.join("initrd");
        let rootfs = data_dir.join("rootfs.img");

        for (name, path) in [("kernel", &kernel), ("initrd", &initrd), ("rootfs", &rootfs)] {
            if !path.exists() {
                return Err(format!(
                    "VM resource '{name}' not found at {}. Run `scripts/vm/build-image.sh` first.",
                    path.display()
                ));
            }
        }

        if let Err(e) = fs::create_dir_all(&loopat_home) {
            return Err(format!("Cannot create loopat home {}: {e}", loopat_home.display()));
        }

        // Clear previous log
        let _ = fs::write(&self.log_path, "");

        let kernel_c = CString::new(kernel.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        let initrd_c = CString::new(initrd.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        let cmdline_c = CString::new("root=/dev/vda rw console=hvc0 loglevel=8 earlyprintk init=/usr/local/bin/loopat-init.sh").map_err(|e| e.to_string())?;
        let rootfs_c = CString::new(rootfs.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        let log_c = CString::new(self.log_path.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;

        eprintln!("[vm] calling vm_create ...");
        let ctx = unsafe {
            vm_create(
                kernel_c.as_ptr(),
                initrd_c.as_ptr(),
                cmdline_c.as_ptr(),
                rootfs_c.as_ptr(),
                VM_CPUS,
                VM_MEMORY_MIB as u64,
                log_c.as_ptr(),
            )
        };
        eprintln!("[vm] vm_create done (null={})", ctx.is_null());

        if ctx.is_null() {
            let reason = unsafe {
                let p = vm_create_error();
                if p.is_null() || *p == 0 {
                    "unknown error".to_string()
                } else {
                    CStr::from_ptr(p).to_string_lossy().into_owned()
                }
            };
            return Err(format!("VM creation failed: {reason}"));
        }

        // Add shared directory
        eprintln!("[vm] calling vm_add_shared_dir ...");
        let home_c = CString::new(loopat_home.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        let tag_c = CString::new("loopat-home").map_err(|e| e.to_string())?;

        let ret = unsafe { vm_add_shared_dir(ctx, home_c.as_ptr(), tag_c.as_ptr()) };
        eprintln!("[vm] vm_add_shared_dir done (ret={ret})");
        if ret != 0 {
            let err = unsafe {
                let p = vm_get_error(ctx);
                if p.is_null() { "Unknown error".to_string() } else { CStr::from_ptr(p).to_string_lossy().into_owned() }
            };
            unsafe { vm_destroy(ctx) };
            return Err(format!("Failed to add shared directory: {err}"));
        }

        // Start VM
        eprintln!("[vm] calling vm_start ...");
        let ret = unsafe { vm_start(ctx) };
        eprintln!("[vm] vm_start done (ret={ret})");
        if ret != 0 {
            let err = unsafe {
                let p = vm_get_error(ctx);
                if p.is_null() { "Unknown error".to_string() } else { CStr::from_ptr(p).to_string_lossy().into_owned() }
            };
            unsafe { vm_destroy(ctx) };
            return Err(format!("VM start failed: {err}"));
        }

        self.ctx = Some(ctx);
        self.log_offset = 0;
        log::info!("Native VM created and start requested");
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(ctx) = self.ctx.take() {
            unsafe {
                vm_stop(ctx);
                vm_destroy(ctx);
            }
        }
    }

    pub fn is_running(&mut self) -> bool {
        match self.ctx {
            Some(ctx) => unsafe { vm_is_running(ctx) },
            None => false,
        }
    }

    pub fn drain_new_logs(&mut self) -> Vec<String> {
        let path = &self.log_path;
        if !path.exists() {
            return vec![];
        }
        let Ok(file) = fs::File::open(path) else { return vec![] };
        let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);

        if file_len <= self.log_offset {
            return vec![];
        }

        use std::io::Seek;
        let mut reader = BufReader::new(file);
        if let Err(e) = reader.seek(std::io::SeekFrom::Start(self.log_offset)) {
            log::warn!("log seek failed: {e}");
            return vec![];
        }

        let mut lines = vec![];
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    self.log_offset += l.len() as u64 + 1;
                    lines.push(l);
                }
                Err(_) => break,
            }
        }

        lines
    }
}

impl Drop for VmManager {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Ensure VM data directory is ready. On first run (or when app is updated),
/// decompress rootfs.img.gz from app resources into the user data directory.
/// Staleness is detected by comparing the mtime of rootfs.img.gz vs rootfs.img.
///
/// Resources can be at either:
///   <resources_dir>/vmlinuz           — development build / direct cargo run
///   <resources_dir>/resources/vmlinuz — Tauri-bundled .app (resources/* glob)
fn prepare_data_dir(resources_dir: &Path) -> Result<PathBuf, String> {
    let data_dir = dirs::data_dir()
        .ok_or_else(|| "Cannot determine app data dir".to_string())?
        .join("com.loopat.app")
        .join("vm");

    fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Cannot create VM data dir: {e}"))?;

    // Try both possible resource locations
    let candidates = [
        resources_dir.to_path_buf(),
        resources_dir.join("resources"),
    ];

    let src_dir = candidates.iter().find(|d| d.join("vmlinuz").exists()).cloned()
        .ok_or_else(|| {
            let paths: Vec<_> = candidates.iter().map(|d| d.join("vmlinuz").display().to_string()).collect();
            format!(
                "Kernel not found. Tried:\n  {}\n\n\
                 Run `scripts/vm/build-image.sh` first to generate VM image files.",
                paths.join("\n  ")
            )
        })?;

    // If rootfs.img exists directly (development build), use resources in place
    if src_dir.join("rootfs.img").exists() {
        return Ok(src_dir);
    }

    // Copy / decompress into app data directory
    let kernel_dst = data_dir.join("vmlinuz");
    let initrd_dst = data_dir.join("initrd");
    let rootfs_dst = data_dir.join("rootfs.img");
    let rootfs_gz  = src_dir.join("rootfs.img.gz");

    // Always refresh kernel and initrd — they are small and cheap to copy.
    fs::copy(&src_dir.join("vmlinuz"), &kernel_dst)
        .map_err(|e| format!("Failed to copy kernel: {e}"))?;
    fs::copy(&src_dir.join("initrd"), &initrd_dst)
        .map_err(|e| format!("Failed to copy initrd: {e}"))?;

    // Decompress rootfs only when needed: either it doesn't exist yet, or the
    // bundled rootfs.img.gz is newer than the cached rootfs.img (i.e. app was updated).
    let needs_decompress = if !rootfs_dst.exists() {
        true
    } else if let (Ok(src_meta), Ok(dst_meta)) = (rootfs_gz.metadata(), rootfs_dst.metadata()) {
        src_meta.modified().ok() > dst_meta.modified().ok()
    } else {
        false
    };

    if needs_decompress {
        if rootfs_gz.exists() {
            log::info!("Decompressing rootfs (new or updated bundle)…");
            decompress_gzip(&rootfs_gz, &rootfs_dst)
                .map_err(|e| format!("Failed to decompress rootfs: {e}"))?;
        } else {
            return Err(format!(
                "Neither rootfs.img nor rootfs.img.gz found in {}",
                src_dir.display()
            ));
        }
    }

    Ok(data_dir)
}

/// Decompress a gzip file using the system `gunzip`.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vm_lifecycle() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let res = manifest_dir.join("resources");

        let kernel = res.join("vmlinuz");
        let initrd = res.join("initrd");
        let rootfs_gz = res.join("rootfs.img.gz");
        assert!(kernel.exists(), "kernel not found");
        assert!(initrd.exists(), "initrd not found");
        assert!(rootfs_gz.exists(), "rootfs.img.gz not found");

        eprintln!("[test] preparing data dir …");
        let data_dir = VmManager::new().prepare(&res).expect("prepare data dir");

        eprintln!("[test] starting VM …");
        let mut mgr = VmManager::new();
        let loopat_home = std::env::temp_dir().join("loopat-test-home");
        fs::create_dir_all(&loopat_home).ok();

        mgr.start(&res, data_dir.clone(), loopat_home).expect("VM start");

        // Wait for VM to reach running state (up to 20s)
        eprintln!("[test] polling is_running …");
        let mut vm_running = false;
        for i in 0..10 {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let running = mgr.is_running();
            eprintln!("  [{}s] running={running}", (i + 1) * 2);
            if running {
                vm_running = true;
                eprintln!("[test] VM is running — waiting for LOOPAT_SERVER_READY …");
                break;
            }
        }

        if !vm_running {
            eprintln!("[test] VM never reached running state");
        }

        // Poll serial log for up to 120s, looking for LOOPAT_SERVER_READY
        let mut server_ready = false;
        for i in 0..60 {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let logs = mgr.drain_new_logs();
            for l in &logs {
                eprintln!("  [+{}s] > {l}", (i + 1) * 2);
                if l.contains("LOOPAT_SERVER_READY") {
                    server_ready = true;
                }
            }
            if server_ready {
                eprintln!("[test] ✓ LOOPAT_SERVER_READY received");
                break;
            }
        }

        if !server_ready {
            eprintln!("[test] LOOPAT_SERVER_READY not received within 120s");
        }

        eprintln!("[test] stopping …");
        mgr.stop();
        eprintln!("[test] done");
    }
}

fn decompress_gzip(src: &Path, dst: &Path) -> std::io::Result<()> {
    log::info!("Decompressing {} -> {}", src.display(), dst.display());
    let status = std::process::Command::new("gunzip")
        .arg("--keep")
        .arg("--stdout")
        .arg(src)
        .stdout(fs::File::create(dst)?)
        .status()?;
    if !status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "gunzip failed",
        ));
    }
    Ok(())
}
