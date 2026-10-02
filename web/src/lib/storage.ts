/** sessionStorage can throw or be absent (private windows, blocked site data); callers must work without it. */
export function readStored(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Remembering the tab is a convenience only.
  }
}
