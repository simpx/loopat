use crate::AppState;
use serde::Serialize;
use tauri::{Manager, State};

#[derive(Serialize)]
pub struct VmStatus {
    pub running: bool,
    pub server_url: Option<String>,
    pub log_count: usize,
}

/// Return all captured VM log lines.
#[tauri::command]
pub async fn get_logs(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let buf = state.log_buffer.lock().map_err(|e| e.to_string())?;
    Ok(buf.clone())
}

/// Return current VM status.
#[tauri::command]
pub async fn get_vm_status(state: State<'_, AppState>) -> Result<VmStatus, String> {
    let running = {
        let mut vm = state.vm.lock().map_err(|e| e.to_string())?;
        vm.is_running()
    };
    let server_url = state.server_url.lock().map_err(|e| e.to_string())?.clone();
    let log_count = state.log_buffer.lock().map_err(|e| e.to_string())?.len();
    Ok(VmStatus { running, server_url, log_count })
}

/// Kill and restart the VM.
#[tauri::command]
pub async fn restart_vm(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Stop existing VM
    state.vm.lock().map_err(|e| e.to_string())?.stop();
    *state.server_url.lock().map_err(|e| e.to_string())? = None;
    state.log_buffer.lock().map_err(|e| e.to_string())?.clear();

    // Navigate main window back to loading screen
    if let Some(window) = app.get_webview_window("main") {
        // tauri://localhost/loading.html — uses the app protocol in prod
        if let Ok(u) = url::Url::parse("tauri://localhost/loading.html") {
            let _ = window.navigate(u);
        }
    }

    // Restart
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::start_vm_and_navigate(app2).await;
    });

    Ok(())
}
