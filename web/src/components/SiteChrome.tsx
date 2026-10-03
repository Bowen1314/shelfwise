import { useEffect, useState } from "react";
import { type HealthResponse, LIMITS_LINE, SAMPLE_DATA_LABEL } from "@shared/types";
import { sampleBannerDetail, sampleBannerPlanner } from "../lib/banner";
import { Icon, LogoMark } from "./Icon";

/** Persistent strip shown whenever the server runs on sample (fixture) data. */
export function SampleBanner({ llm }: { llm?: HealthResponse["llm"] | undefined }) {
  return (
    <div className="sample-banner" role="note" aria-label="Data source">
      <div className="sample-banner__inner">
        <Icon name="flask" />
        <strong>{SAMPLE_DATA_LABEL}</strong>
        {sampleBannerPlanner(llm) && <strong className="sample-banner__planner">{sampleBannerPlanner(llm)}</strong>}
        <span className="sample-banner__detail">{sampleBannerDetail(llm)}</span>
      </div>
    </div>
  );
}

export function Header({ narrow }: { narrow: boolean }) {
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
        <nav className="sidebar-nav" aria-label="Workspace sections">
          <span className="sidebar-nav__item sidebar-nav__item--active"><span className="sidebar-nav__dot" aria-hidden="true" />Build a shelf</span>
          <span className="sidebar-nav__item">Recent runs</span>
          <span className="sidebar-nav__item">Print desk</span>
        </nav>
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
          <div className="content-topbar__crumb"><span>Workspace</span><span aria-hidden="true">/</span><strong>{narrow ? "New shelf" : "Shelf report"}</strong></div>
          <div className="content-topbar__actions">
            <div className="content-topbar__meta">Qloo taste graph <span aria-hidden="true">·</span> grounded recommendations</div>
            <ThemeToggle />
          </div>
        </div>
        <p className="limits-strip">
          <Icon name="info" />
          <span>{LIMITS_LINE}</span>
        </p>
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
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      <Icon name={dark ? "sun" : "moon"} />
      <span className="theme-toggle__label">{dark ? "Light" : "Dark"}</span>
    </button>
  );
}

export function Footer({ narrow }: { narrow: boolean }) {
  return (
    <footer className={`site-footer${narrow ? " site-footer--narrow" : ""}`}>
      <p><span className="footer__code">SW/01</span> {LIMITS_LINE}</p>
      <p>Built with Qloo’s taste graph and an NVIDIA Nemotron model on Nebius Token Factory.</p>
      <p>Aggregate affinities, not claims about individuals.</p>
    </footer>
  );
}
