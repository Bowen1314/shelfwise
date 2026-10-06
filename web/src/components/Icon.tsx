import type { ReactNode } from "react";

const ICONS = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  dash: <path d="M6 12h12" />,
  circle: <circle cx="12" cy="12" r="8" />,
  half: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
    </>
  ),
  alert: <path d="M12 4.5l9 15.5H3L12 4.5zM12 10v4.2M12 17.2v.01" />,
  "x-circle": (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.7 9.6a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.9-1.1 1.6M12 16.8v.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8v.01" />
    </>
  ),
  "arrow-up-right": <path d="M7 17L17 7M9 7h8v8" />,
  "arrow-down-right": <path d="M7 7l10 10M17 9v8H9" />,
  "arrow-right": <path d="M5 12h14M13 6l6 6-6 6" />,
  chevron: <path d="M6 9l6 6 6-6" />,
  printer: (
    <path d="M7 9V4h10v5M7 17H5.5A1.5 1.5 0 0 1 4 15.5v-4A2.5 2.5 0 0 1 6.5 9h11a2.5 2.5 0 0 1 2.5 2.5v4a1.5 1.5 0 0 1-1.5 1.5H17M7 14h10v6H7z" />
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5.5 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v.5" />
    </>
  ),
  download: <path d="M12 4v11M7.5 11L12 15.5 16.5 11M5 19.5h14" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  refresh: <path d="M19.5 11a7.5 7.5 0 1 0-2.2 5.3M19.5 4.5V11H13" />,
  flask: <path d="M9.5 3.5h5M10.5 3.5v5.8L5.6 17.6A2 2 0 0 0 7.3 20.5h9.4a2 2 0 0 0 1.7-2.9l-4.9-8.3V3.5M8 15h8" />,
  trail: <path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5v.01M4.5 12v.01M4.5 17.5v.01" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  list: <path d="M9 6.5h10M9 12h10M9 17.5h10M5 6.5v.01M5 12v.01M5 17.5v.01" />,
  send: <path d="M5 12h14M13 6l6 6-6 6" />,
  sliders: <path d="M5 8h9M18 8h1M5 16h1M10 16h9M14 6v4M6 14v4" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v2M12 19.5v2M4.8 4.8l1.4 1.4M17.8 17.8l1.4 1.4M2.5 12h2M19.5 12h2M4.8 19.2l1.4-1.4M17.8 6.2l1.4-1.4" />
    </>
  ),
  moon: <path d="M20.2 15.4A8.3 8.3 0 0 1 8.6 3.8 8.5 8.5 0 1 0 20.2 15.4z" />,
  shelf: <path d="M3.5 20h17M6 20V7h3.5v13M9.5 20V5H13v15M15 19.5l-.4-11.6 3.4-.5 1.6 12" />,
  trash: <path d="M5 7h14M10 4h4M7 7l.8 12.2a1 1 0 0 0 1 .8h6.4a1 1 0 0 0 1-.8L17 7M10.5 11v5M13.5 11v5" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

interface IconProps {
  name: IconName;
  className?: string;
}

/** Decorative inline icon (24x24, stroke follows currentColor). Meaning is always carried by adjacent text. */
export function Icon({ name, className = "" }: IconProps) {
  return (
    <svg
      className={`icon ${className}`.trim()}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

/** A busy indicator: three-quarter ring that turns. */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`icon icon--spin ${className}`.trim()}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5" />
    </svg>
  );
}

export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" width="36" height="36" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" className="logo__tile" />
      <rect x="7" y="7" width="5" height="18" rx="1" className="logo__spine-a" />
      <rect x="14" y="9" width="5" height="16" rx="1" className="logo__spine-b" />
      <rect x="21" y="6" width="4" height="19" rx="1" className="logo__spine-a" />
    </svg>
  );
}
