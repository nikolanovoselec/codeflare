export const CODEFLARE_RUNTIME_ROOT = process.env.CODEFLARE_RUNTIME_ROOT ?? '/run/codeflare';
export const SYNC_RUNTIME_DIR = `${CODEFLARE_RUNTIME_ROOT}/sync`;
export const SERVICES_RUNTIME_DIR = `${CODEFLARE_RUNTIME_ROOT}/services`;
export const OPENVSCODE_RUNTIME_DIR = `${CODEFLARE_RUNTIME_ROOT}/openvscode`;

export const SYNC_DAEMON_PID_FILE = `${SYNC_RUNTIME_DIR}/sync-daemon.pid`;
export const SYNC_STATUS_FILE = `${SYNC_RUNTIME_DIR}/sync-status.json`;
export const SYNC_LOG_FILE = `${SYNC_RUNTIME_DIR}/sync.log`;
export const OPENVSCODE_REQUEST_TRIGGER = `${OPENVSCODE_RUNTIME_DIR}/requested`;
