import { BrowserWindow } from 'electron';

export function createOrchestrateWindow(): Promise<BrowserWindow>;
export function getOrchestrateWindow(): BrowserWindow | null;
export function waitForReady(): Promise<void>;
export function signalReady(): void;
export function destroyOrchestrateWindow(): void;
