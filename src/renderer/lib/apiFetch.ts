/**
 * src/renderer/lib/apiFetch.ts
 *
 * Thin wrapper around fetch() that automatically injects the
 * `x-device-id` header on every request to the local Express backend.
 *
 * The device_id is read once via Electron IPC and cached for the
 * lifetime of the renderer process.
 */

export const API_BASE = 'http://localhost:3001';

// ── device_id cache ───────────────────────────────────────────────────────────
let _cachedDeviceId: string | null = null;
let _initPromise: Promise<string> | null = null;

/**
 * Try to read the device_id from Electron IPC, with retries.
 * The preload/IPC may not be ready on the very first render tick.
 */
async function resolveDeviceId(): Promise<string> {
  // Retry up to 10 times with 300ms gap — covers the case where
  // the renderer mounts before electronAPI is fully wired
  for (let i = 0; i < 10; i++) {
    try {
      const id = await window.electronAPI?.getDeviceId?.();
      if (id && id !== 'unknown' && id.length > 8) {
        return id;
      }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  // Last resort: try to read from electron-store via the store IPC
  try {
    const stored = await window.electronAPI?.store?.get('deviceId') as string | undefined;
    if (stored && stored.length > 8) return stored;
  } catch { /* ignore */ }
  return 'unknown';
}

/**
 * Returns the stable device UUID for this installation.
 * Cached after the first successful resolution.
 */
export async function getDeviceId(): Promise<string> {
  if (_cachedDeviceId && _cachedDeviceId !== 'unknown') return _cachedDeviceId;

  if (!_initPromise) {
    _initPromise = resolveDeviceId().then(id => {
      _cachedDeviceId = id;
      _initPromise = null;
      return id;
    });
  }

  return _initPromise;
}

/**
 * Eagerly start resolving the device_id in the background.
 * Call this once from App.tsx so it's ready before the first data fetch.
 */
export function prewarmDeviceId(): void {
  getDeviceId().catch(() => {});
}

/**
 * Drop-in replacement for fetch() for all backend API calls.
 * Automatically adds `x-device-id` and merges caller-supplied headers.
 *
 * @param path   e.g. '/api/stats'
 * @param init   Standard RequestInit
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const deviceId = await getDeviceId();

  const mergedHeaders = new Headers(init.headers ?? {});
  mergedHeaders.set('x-device-id', deviceId);

  if (
    init.body &&
    typeof init.body === 'string' &&
    !mergedHeaders.has('Content-Type')
  ) {
    mergedHeaders.set('Content-Type', 'application/json');
  }

  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: mergedHeaders,
  });
}
