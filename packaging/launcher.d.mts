// launcher.mjs の型(テストから読むため)
export function defaultDataDir(platform?: string, env?: Record<string, string | undefined>, home?: string): string;
export function pickApp(dataDir: string, appDir: string, log?: (s: string) => void): string;
