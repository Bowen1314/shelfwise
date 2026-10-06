/** Class on <html> that turns on the colour cross-fade between themes (see redesign.css). */
export const THEME_FADE_CLASS = "theme-fading";
/** A little longer than the .32s transitions, so the class never cuts a fade short. */
export const THEME_FADE_MS = 350;

export interface ClassListLike {
  add(token: string): void;
  remove(token: string): void;
}

export interface FadeTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: FadeTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Turns the theme cross-fade on for one fade. Call it on a theme change only, never on mount: outside the fade the
 * surfaces keep their short hover transitions. Returns a function that ends the fade at once (for a second toggle
 * before the first fade is over, or on unmount).
 */
export function startThemeFade(classList: ClassListLike, timers: FadeTimers = defaultTimers, ms = THEME_FADE_MS): () => void {
  classList.add(THEME_FADE_CLASS);
  const handle = timers.setTimeout(() => classList.remove(THEME_FADE_CLASS), ms);
  return () => {
    timers.clearTimeout(handle);
    classList.remove(THEME_FADE_CLASS);
  };
}
