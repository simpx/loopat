#import "include/bridge.h"
#import <Virtualization/Virtualization.h>
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <string.h>
#import <stdlib.h>
#import <unistd.h>
#import <stdarg.h>
#import <fcntl.h>
#import <util.h>   // openpty

// Debug logging: writes directly to stderr (no buffering issues with pipe)
#define DBG(fmt, ...) do { \
    dprintf(STDERR_FILENO, "[bridge] " fmt "\n", ##__VA_ARGS__); \
} while(0)

// ── ARC-managed container for all ObjC objects ──────────────────────────────
@interface VMContainer : NSObject
@property (strong) VZVirtualMachine* vm;
@property (strong) VZVirtualMachineConfiguration* config;
@property (assign) int masterFd;           // PTY master fd (host reads VM output)
@property (assign) int logFd;              // log file fd
@property (strong) NSFileHandle* slaveFH;  // PTY slave fd handle (kept alive for VZ attachment)
@property (assign) dispatch_source_t readSource; // dispatch source monitoring masterFd
@property (strong) NSMutableArray* pendingSharedDirs;
@property (strong) dispatch_semaphore_t stopSem;
@property (assign) bool running;
@property (assign) bool started;
@property (assign) bool startRequested;
- (const char*)errorString;
- (void)setError:(const char*)msg;
@end

@implementation VMContainer {
    char _errorBuffer[1024];
}
- (instancetype)init {
    if ((self = [super init])) {
        _errorBuffer[0] = '\0';
        _stopSem = dispatch_semaphore_create(0);
        _pendingSharedDirs = [NSMutableArray array];
        _masterFd = -1;
        _logFd = -1;
        _readSource = NULL;
        _running = false;
        _started = false;
        _startRequested = false;
    }
    return self;
}
- (void)dealloc {
    if (_vm) {
        _vm.delegate = nil;
    }
    if (_readSource) { dispatch_source_cancel(_readSource); _readSource = NULL; }
    [_slaveFH closeFile];
    if (_masterFd >= 0) { close(_masterFd); _masterFd = -1; }
    if (_logFd >= 0)    { close(_logFd);    _logFd = -1; }
}
- (const char*)errorString {
    return _errorBuffer;
}
- (void)setError:(const char*)msg {
    if (msg) strlcpy(_errorBuffer, msg, sizeof(_errorBuffer));
    else _errorBuffer[0] = '\0';
}
@end

// ── Delegate class ──────────────────────────────────────────────────────────
@interface VMDelegate : NSObject
@property (weak) VMContainer* container;
@end

@implementation VMDelegate
- (void)guestDidStopVirtualMachine:(VZVirtualMachine *)virtualMachine {
    self.container.running = false;
}
- (void)virtualMachine:(VZVirtualMachine *)virtualMachine
      didStopWithError:(NSError *)error {
    self.container.running = false;
    if (error && error.localizedDescription) {
        [self.container setError:error.localizedDescription.UTF8String];
    }
}
@end

// ── Static error buffer for vm_create failures ──────────────────────────────
// vm_create returns NULL on failure; since there is no ctx to hold the error,
// we stash it here so the caller can retrieve it via vm_create_error().
static char s_create_error[1024] = "";

static void set_create_error(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(s_create_error, sizeof(s_create_error), fmt, ap);
    va_end(ap);
    dprintf(STDERR_FILENO, "[bridge] vm_create error: %s\n", s_create_error);
}

const char* vm_create_error(void) {
    return s_create_error;
}

// ── Private serial queue for all VZ operations ──────────────────────────────
// Using a dedicated queue instead of the main queue avoids deadlocks in CLI
// binaries (e.g. cargo test) where the main thread has no active run loop.
// VZ framework on macOS 12+ only requires a consistent serial queue, not main.
static dispatch_queue_t vz_queue(void) {
    static dispatch_queue_t q;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        q = dispatch_queue_create("com.loopat.vm", DISPATCH_QUEUE_SERIAL);
    });
    return q;
}

// ── C API ───────────────────────────────────────────────────────────────────

vm_ctx_t* vm_create(
    const char* kernel_path,
    const char* initrd_path,
    const char* cmdline,
    const char* rootfs_path,
    uint32_t cpus,
    uint64_t memory_mb,
    const char* log_path
) {
    s_create_error[0] = '\0';
    if (!kernel_path || !initrd_path || !rootfs_path || !log_path) {
        set_create_error("NULL parameter passed to vm_create");
        return NULL;
    }

    DBG("vm_create: kernel=%s initrd=%s rootfs=%s", kernel_path, initrd_path, rootfs_path);

    VMContainer* c = [[VMContainer alloc] init];
    if (!c) { set_create_error("VMContainer alloc failed"); return NULL; }

    @autoreleasepool {
        NSError* error = nil;

        // Boot loader
        NSURL* kernelURL = [NSURL fileURLWithPath:@(kernel_path)];
        NSURL* initrdURL = [NSURL fileURLWithPath:@(initrd_path)];
        NSString* cmdlineStr = cmdline ? @(cmdline) : @"";

        VZLinuxBootLoader* bootLoader = [[VZLinuxBootLoader alloc] initWithKernelURL:kernelURL];
        bootLoader.initialRamdiskURL = initrdURL;
        bootLoader.commandLine = cmdlineStr;

        // Platform (required for Linux boot loader on macOS 12+)
        VZGenericPlatformConfiguration* platform =
            [[VZGenericPlatformConfiguration alloc] init];

        // Storage (rootfs)
        NSURL* diskURL = [NSURL fileURLWithPath:@(rootfs_path)];
        VZDiskImageStorageDeviceAttachment* diskAttachment =
            [[VZDiskImageStorageDeviceAttachment alloc] initWithURL:diskURL
                                                          readOnly:NO
                                                             error:&error];
        if (error) {
            set_create_error("disk attachment failed for %s: %s", rootfs_path,
                             error.localizedDescription.UTF8String ?: "?");
            return NULL;
        }
        VZVirtioBlockDeviceConfiguration* storage =
            [[VZVirtioBlockDeviceConfiguration alloc] initWithAttachment:diskAttachment];

        // Serial console — PTY gives unbuffered output from the VM.
        // slave fd → given to VZ framework (VM's serial device)
        // master fd → monitored on host side via dispatch_source
        int masterFd = -1, slaveFd = -1;
        if (openpty(&masterFd, &slaveFd, NULL, NULL, NULL) != 0) {
            set_create_error("openpty failed: %s", strerror(errno));
            return NULL;
        }
        // Master non-blocking so reads never block the dispatch queue
        fcntl(masterFd, F_SETFL, fcntl(masterFd, F_GETFL) | O_NONBLOCK);

        // Keep the slave fd alive in an NSFileHandle for the VZ attachment lifetime
        NSFileHandle* slaveFH = [[NSFileHandle alloc] initWithFileDescriptor:slaveFd
                                                              closeOnDealloc:YES];
        VZFileHandleSerialPortAttachment* serialAttachment =
            [[VZFileHandleSerialPortAttachment alloc]
                initWithFileHandleForReading:slaveFH
                         fileHandleForWriting:slaveFH];

        VZVirtioConsoleDeviceSerialPortConfiguration* serial =
            [[VZVirtioConsoleDeviceSerialPortConfiguration alloc] init];
        serial.attachment = serialAttachment;

        // Open log file (raw fd for use inside dispatch_source block)
        int logFd = open(log_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (logFd < 0) {
            set_create_error("failed to open log file %s: %s", log_path, strerror(errno));
            close(masterFd);
            return NULL;
        }

        // dispatch_source monitors the PTY master fd for readability;
        // plain read()/write() syscalls avoid all NSFileHandle buffering quirks.
        dispatch_source_t src = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ,
                                                       (uintptr_t)masterFd, 0,
                                                       dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
        dispatch_source_set_event_handler(src, ^{
            char buf[4096];
            ssize_t n;
            while ((n = read(masterFd, buf, sizeof(buf))) > 0) {
                DBG("dispatch_source read: %zd bytes", n);
                write(logFd, buf, (size_t)n);
            }
            if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) {
                DBG("dispatch_source: EOF/error (errno=%d), cancelling", errno);
                dispatch_source_cancel(src);
            }
        });
        dispatch_source_set_cancel_handler(src, ^{
            DBG("dispatch_source: cancel handler fired");
        });
        DBG("vm_create: dispatch_source resumed on masterFd=%d", masterFd);
        dispatch_resume(src);

        // Entropy (required for Linux boot on macOS 14+)
        VZVirtioEntropyDeviceConfiguration* entropy =
            [[VZVirtioEntropyDeviceConfiguration alloc] init];

        // Network (NAT)
        VZVirtioNetworkDeviceConfiguration* network =
            [[VZVirtioNetworkDeviceConfiguration alloc] init];
        VZNATNetworkDeviceAttachment* nat =
            [[VZNATNetworkDeviceAttachment alloc] init];
        network.attachment = nat;

        // Build configuration
        VZVirtualMachineConfiguration* config =
            [[VZVirtualMachineConfiguration alloc] init];
        config.bootLoader = bootLoader;
        config.platform = platform;
        config.CPUCount = cpus;
        config.memorySize = memory_mb * 1024 * 1024;
        config.storageDevices = @[storage];
        config.serialPorts = @[serial];
        config.networkDevices = @[network];
        config.entropyDevices = @[entropy];

        // Validate (without directory sharing — added later via vm_add_shared_dir)
        NSError* validationError = nil;
        if (![config validateWithError:&validationError]) {
            set_create_error("config validation failed: %s",
                validationError.localizedDescription.UTF8String ?: "?");
            return NULL;
        }

        c.config = config;
        c.masterFd = masterFd;
        c.logFd = logFd;
        c.slaveFH = slaveFH;
        c.readSource = src;
    }

    return (__bridge_retained void*)c;
}

int vm_add_shared_dir(vm_ctx_t* ctx, const char* host_path, const char* tag) {
    if (!ctx || !host_path || !tag) return -1;
    VMContainer* c = (__bridge VMContainer*)ctx;
    if (c.startRequested) {
        DBG("vm_add_shared_dir: cannot add after start requested");
        return -1;
    }

    @autoreleasepool {
        NSURL* dirURL = [NSURL fileURLWithPath:@(host_path)];
        VZSharedDirectory* sharedDir =
            [[VZSharedDirectory alloc] initWithURL:dirURL readOnly:NO];
        VZSingleDirectoryShare* share =
            [[VZSingleDirectoryShare alloc] initWithDirectory:sharedDir];

        VZVirtioFileSystemDeviceConfiguration* fsConfig =
            [[VZVirtioFileSystemDeviceConfiguration alloc] initWithTag:@(tag)];
        fsConfig.share = share;

        [c.pendingSharedDirs addObject:fsConfig];
    }

    return 0;
}

int vm_start(vm_ctx_t* ctx) {
    DBG("vm_start entered");
    if (!ctx) { DBG("vm_start: NULL ctx"); return -1; }
    VMContainer* c = (__bridge VMContainer*)ctx;
    if (c.startRequested) { DBG("vm_start: already started"); return -1; }
    c.startRequested = true;

    @autoreleasepool {
        // 1. Add pending shared directories to config (any thread is fine)
        if (c.pendingSharedDirs.count > 0) {
            NSMutableArray* dirDevices = [c.config.directorySharingDevices mutableCopy];
            if (!dirDevices) dirDevices = [NSMutableArray array];
            [dirDevices addObjectsFromArray:c.pendingSharedDirs];
            c.config.directorySharingDevices = dirDevices;

            // Re-validate with directory sharing
            NSError* validationError = nil;
            if (![c.config validateWithError:&validationError]) {
                DBG("vm_start: config validation failed with shared dirs: %s",
                    validationError.localizedDescription.UTF8String ?: "?");
                c.startRequested = false;
                return -1;
            }
        }

        // 2. Create VM and start it on vz_queue. VZ framework (macOS 12+) requires
        //    that a VM is created and used on the same serial queue; vz_queue serves
        //    this role without needing the main thread's run loop.
        __weak VMContainer* weakC = c;
        dispatch_sync(vz_queue(), ^{
            VMDelegate* delegate = [[VMDelegate alloc] init];
            delegate.container = weakC;
            DBG("vm_start: calling initWithConfiguration:queue: ...");
            VZVirtualMachine* vm = [[VZVirtualMachine alloc]
                initWithConfiguration:weakC.config queue:vz_queue()];
            DBG("vm_start: initWithConfiguration: done, vm=%p", (__bridge void*)vm);
            vm.delegate = (id)delegate;
            weakC.vm = vm;
            weakC.config = nil;

            [vm startWithCompletionHandler:^(NSError* _Nullable startError) {
                VMContainer* strongC = weakC;
                if (!strongC) return;
                if (startError) {
                    DBG("vm_start: VM start failed: %s",
                        startError.localizedDescription.UTF8String ?: "?");
                    strongC.running = false;
                } else {
                    strongC.running = true;
                    strongC.started = true;
                }
            }];
        });
    }

    return 0;
}

bool vm_is_running(vm_ctx_t* ctx) {
    if (!ctx) return false;
    VMContainer* c = (__bridge VMContainer*)ctx;
    return c.running;
}

int vm_stop(vm_ctx_t* ctx) {
    if (!ctx) return -1;
    VMContainer* c = (__bridge VMContainer*)ctx;

    if (!c.vm) return 0;

    c.started = false;
    c.running = false;

    // Cancel dispatch_source and close PTY/log fds
    if (c.readSource) { dispatch_source_cancel(c.readSource); c.readSource = NULL; }
    [c.slaveFH closeFile];
    if (c.masterFd >= 0) { close(c.masterFd); c.masterFd = -1; }
    if (c.logFd >= 0)    { close(c.logFd);    c.logFd = -1; }

    // stopWithCompletionHandler: must be called on vz_queue (same queue the VM was created on).
    dispatch_semaphore_t sem = c.stopSem;
    dispatch_async(vz_queue(), ^{
        [c.vm stopWithCompletionHandler:^(NSError* _Nullable stopError) {
            if (stopError) {
                DBG("vm_stop: VM stop failed: %s",
                    stopError.localizedDescription.UTF8String ?: "?");
            }
            dispatch_semaphore_signal(sem);
        }];
    });

    long result = dispatch_semaphore_wait(sem,
        dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
    if (result != 0) {
        DBG("vm_stop: timed out after 30s");
        return -1;
    }

    return 0;
}

const char* vm_get_error(vm_ctx_t* ctx) {
    if (!ctx) return "";
    VMContainer* c = (__bridge VMContainer*)ctx;
    return [c errorString];
}

void vm_destroy(vm_ctx_t* ctx) {
    if (!ctx) return;
    VMContainer* c = (__bridge_transfer VMContainer*)ctx;
    if (c.vm) {
        c.vm.delegate = nil;
    }
    if (c.readSource) { dispatch_source_cancel(c.readSource); c.readSource = NULL; }
    [c.slaveFH closeFile];
    if (c.masterFd >= 0) { close(c.masterFd); c.masterFd = -1; }
    if (c.logFd >= 0)    { close(c.logFd);    c.logFd = -1; }
}
