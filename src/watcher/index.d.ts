export function setupWatcher(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onDetected: (payload: any) => void,
  initialFolders?: string[],
  deviceId?: string
): void;

export function updateWatchedFolders(folders: string[]): void;

export function closeWatcher(): Promise<void>;
