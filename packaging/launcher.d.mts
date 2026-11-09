// launcher.mjs の型(テストから読むため)
export function defaultDataDir(platform?: string, env?: Record<string, string | undefined>, home?: string): string;
export function pickApp(dataDir: string, appDir: string, log?: (s: string) => void): string;
export function startTray(o: { url: string; dataDir: string; icon: string; onQuit: () => void; log?: (s: string) => void; platform?: string; here?: string }): import("node:child_process").ChildProcess | null;
