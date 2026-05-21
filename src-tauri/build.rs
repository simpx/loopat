fn main() {
    tauri_build::build();

    // Set deployment target for both cc-rs (ObjC compilation) and rustc.
    // Required: 12.0+ for VZGenericPlatformConfiguration, directory sharing, etc.
    std::env::set_var("MACOSX_DEPLOYMENT_TARGET", "12.0");
    println!("cargo:rustc-env=MACOSX_DEPLOYMENT_TARGET=12.0");

    // Re-run this build script whenever the ObjC bridge source changes.
    println!("cargo:rerun-if-changed=vm-bridge/bridge.m");
    println!("cargo:rerun-if-changed=vm-bridge/include/bridge.h");

    // Compile the native ObjC VM bridge (replaces vfkit).
    // Uses Apple's Virtualization.framework directly via C FFI.
    // Framework headers are found via the system SDK path automatically.
    cc::Build::new()
        .file("vm-bridge/bridge.m")
        .flag("-fobjc-arc")
        .compile("vmbridge");

    // Link frameworks for the final binary
    println!("cargo:rustc-link-lib=framework=Virtualization");
    println!("cargo:rustc-link-lib=framework=Foundation");
}
