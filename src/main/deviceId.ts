'use strict';
/**
 * src/main/deviceId.ts
 *
 * Returns a stable UUID that uniquely identifies this installation.
 * Generated once on first launch, then persisted in electron-store
 * (which lives in %APPDATA%\smartdesk-ai\ — per-user, per-machine).
 *
 * Every DB record is tagged with this ID so you can isolate data
 * by device in Supabase queries.
 */

import Store from 'electron-store';
import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';

const store = new Store<{ deviceId: string }>();

let _deviceId: string | null = null;

/**
 * Returns the device_id for this machine.
 * Lazily initialised — safe to call before app.ready.
 */
export function getDeviceId(): string {
  if (_deviceId) return _deviceId;

  const stored = store.get('deviceId') as string | undefined;
  if (stored) {
    _deviceId = stored;
    return _deviceId;
  }

  // Generate a new UUID and persist it
  const newId = uuidv4();
  store.set('deviceId', newId);
  _deviceId = newId;
  return _deviceId;
}

/**
 * Returns a human-readable label for this device.
 * Stored separately so it can be displayed in the UI.
 */
export function getDeviceLabel(): string {
  const stored = store.get('deviceLabel') as string | undefined;
  if (stored) return stored;

  const label = `${os.hostname()} (${os.platform()})`;
  store.set('deviceLabel', label);
  return label;
}
