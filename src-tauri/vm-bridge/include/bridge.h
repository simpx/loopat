#ifndef VM_BRIDGE_H
#define VM_BRIDGE_H

#include <stdint.h>
#include <stdbool.h>

/// Opaque pointer to a native VM context.
/// Created by vm_create(), destroyed by vm_destroy().
typedef void vm_ctx_t;

/// Create a VM context with the given configuration.
/// kernel_path, initrd_path, rootfs_path, log_path: required
/// cmdline: optional kernel command line (can be NULL)
/// Returns an opaque context pointer, or NULL on failure.
/// Call vm_get_error() to get the error message.
vm_ctx_t* vm_create(
    const char* kernel_path,
    const char* initrd_path,
    const char* cmdline,
    const char* rootfs_path,
    uint32_t cpus,
    uint64_t memory_mb,
    const char* log_path
);

/// Add a shared directory via virtiofs. Must be called before vm_start().
/// host_path: path on the host to share into the VM
/// tag: mount tag used inside the VM (e.g. "loopat-home")
/// Returns 0 on success, -1 on failure.
int vm_add_shared_dir(vm_ctx_t* ctx, const char* host_path, const char* tag);

/// Start the VM asynchronously. Returns 0 on success, -1 on failure.
int vm_start(vm_ctx_t* ctx);

/// Returns true if the VM is running.
bool vm_is_running(vm_ctx_t* ctx);

/// Stop the VM (synchronous, blocks until stopped).
/// Returns 0 on success, -1 on failure.
int vm_stop(vm_ctx_t* ctx);

/// Get the last error from a failed vm_create() call.
/// Only valid to call after vm_create() returns NULL.
const char* vm_create_error(void);

/// Get the last error message. Returns an empty string if no error.
/// The returned pointer is valid until the next vm_* call on the same context.
const char* vm_get_error(vm_ctx_t* ctx);

/// Destroy the VM context and free all resources.
void vm_destroy(vm_ctx_t* ctx);

#endif // VM_BRIDGE_H
