import { useEffect, useRef, useState } from "react";
import { type HealthResponse, SAMPLE_DATA_LABEL } from "@shared/types";
import { sampleBannerDetail, sampleBannerPlanner } from "../lib/banner";
import { startThemeFade } from "../lib/themeFade";
import { Icon, LogoMark, type IconName } from "./Icon";

/** Persistent strip shown whenever the server runs on sample (fixture) data. */
export function SampleBanner({ llm }: { llm?: HealthResponse["llm"] | undefined }) {
  // The sticky sidebar and evidence trail sit below the banner (--banner-h in redesign.css). The banner wraps on
  // narrower screens, so its height is measured rather than assumed.
  const banner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = banner.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => root.style.setProperty("--banner-h", `${el.offsetHeight}px`));
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--banner-h");
    };
  }, []);

  return (
    <div className="sample-banner" role="note" aria-label="Data source" ref={banner}>
      <div className="sample-banner__inner">
        <Icon name="flask" />
        <strong>{SAMPLE_DATA_LABEL}</strong>
        {sampleBannerPlanner(llm) && <strong className="sample-banner__planner">{sampleBannerPlanner(llm)}</strong>}
        <span className="sample-banner__detail">{sampleBannerDetail(llm)}</span>
      </div>
    </div>
  );
}

/** The workspace views. The app has no router: App holds the current one. */
export type View = "build" | "recent" | "print";

const NAV_ITEMS: { id: View; label: string; short: string; icon: IconName }[] = [
  { id: "build", label: "Build a shelf", short: "Build", icon: "shelf" },
  { id: "recent", label: "Recent runs", short: "Recent", icon: "clock" },
  { id: "print", label: "Print desk", short: "Print", icon: "printer" },
];

interface HeaderProps {
  narrow: boolean;
  view: View;
  onNavigate: (view: View) => void;
  /** Last part of the breadcrumb, e.g. "New shelf". */
  crumb: string;
}

/**
 * Workspace navigation. Each item keeps its full name as text: the rail (below 1024px) and the top bar (720px and
 * below) hide it visually but not from assistive technology, and show an icon and a short word instead.
 */
function WorkspaceNav({ view, onNavigate }: Pick<HeaderProps, "view" | "onNavigate">) {
  return (
    <nav className="sidebar-nav" aria-label="Workspace sections">
      {NAV_ITEMS.map((item) => {
        const active = item.id === view;
        return (
          <button
            key={item.id}
            type="button"
            className={`sidebar-nav__item${active ? " sidebar-nav__item--active" : ""}`}
            aria-current={active ? "page" : undefined}
            title={item.label}
            onClick={() => onNavigate(item.id)}
          >
            {active && <span className="sidebar-nav__dot" aria-hidden="true" />}
            <Icon name={item.icon} className="sidebar-nav__icon" />
            <span className="sidebar-nav__label">{item.label}</span>
            <span className="sidebar-nav__short" aria-hidden="true">
              {item.short}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export function Header({ narrow, view, onNavigate, crumb }: HeaderProps) {
  return (
    <>
      <aside className="workspace-sidebar" aria-label="Shelfwise workspace">
        <div className="sidebar-brand">
          <div className="brand-mark">
            <LogoMark className="logo" />
            <span className="brand-mark__code">SW/01</span>
          </div>
          <div>
            <p className="brand-kicker">Collection studio</p>
            <h1 className="wordmark">Shelfwise</h1>
          </div>
        </div>
        <p className="sidebar-label">Workspace</p>
        <WorkspaceNav view={view} onNavigate={onNavigate} />
        <div className="sidebar-footer">
          <div className="header-signal" aria-label="Shelfwise is ready">
            <span className="header-signal__dot" aria-hidden="true" />
            <span>System ready</span>
          </div>
          <p>Grounded recommendations for libraries and independent bookshops.</p>
        </div>
      </aside>
      <header className={`site-header${narrow ? " site-header--narrow" : ""}`}>
        <div className="content-topbar">
          <div className="content-topbar__crumb"><span>Workspace</span><span aria-hidden="true">/</span><strong>{crumb}</strong></div>
          <div className="content-topbar__actions">
            <ThemeToggle />
          </div>
        </div>
      </header>
    </>
  );
}

type Theme = "light" | "dark";
const THEME_KEY = "shelfwise-theme";

function initialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Private browsing can reject localStorage; system preference still works.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const endFade = useRef<(() => void) | null>(null);
  useEffect(() => () => endFade.current?.(), []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // The toggle remains usable when persistence is unavailable.
    }
  }, [theme]);

  const dark = theme === "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={dark}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => {
        // Colours cross-fade only for this switch; the first render and hover states are not animated.
        endFade.current?.();
        endFade.current = startThemeFade(document.documentElement.classList);
        setTheme(dark ? "light" : "dark");
      }}
    >
      <Icon name={dark ? "sun" : "moon"} />
      <span className="theme-toggle__label">{dark ? "Light" : "Dark"}</span>
    </button>
  );
}
