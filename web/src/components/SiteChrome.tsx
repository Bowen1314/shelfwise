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
    <header className={`site-header${narrow ? " site-header--narrow" : ""}`}>
      <div className="site-header__inner">
        <LogoMark className="logo" />
        <div className="site-header__text">
          <h1 className="wordmark">Shelfwise</h1>
          <p className="tagline">Readers’ advisory and collection ideas from what your community already loves</p>
        </div>
      </div>
      <p className="limits-strip">
        <Icon name="info" />
        <span>{LIMITS_LINE}</span>
      </p>
    </header>
  );
}

export function Footer({ narrow }: { narrow: boolean }) {
  return (
    <footer className={`site-footer${narrow ? " site-footer--narrow" : ""}`}>
      <p>{LIMITS_LINE}</p>
      <p>Built with Qloo’s taste graph and an NVIDIA Nemotron model on Nebius Token Factory.</p>
      <p>Aggregate affinities, not claims about individuals.</p>
    </footer>
  );
}
