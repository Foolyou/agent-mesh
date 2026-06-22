// #6 — minimal stroke-based SVG icon set for the /bnw console, replacing emoji so icons match
// the design system and inherit theme color via `currentColor` (visible in dark/light/eye-care).
// 24-unit grid, configurable size. Decorative by default (aria-hidden); when an icon is the only
// label, pass `title` (renders <title> + role="img") or put the accessible name on the host.
// v2 semantic tokens only (color comes from the host's text color / currentColor).
import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "bell" | "compass" | "alert" | "gear" | "key" | "arrow-up" | "broadcast" | "package"
  | "activity" | "message" | "message-circle" | "plus" | "play" | "columns" | "menu"
  | "refresh" | "search" | "tag" | "maximize" | "minimize" | "ban" | "wrench" | "mail"
  | "clipboard" | "paperclip" | "check-circle" | "pin";

// Path/shape data per icon (lucide-style geometry). Stroke + round joins are set on the <svg>.
const SHAPES: Record<IconName, ReactNode> = {
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="m16.2 7.8-2.9 6.5-6.5 2.9 2.9-6.5z" /></>,
  alert: <><path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
  key: <><circle cx="7.5" cy="15.5" r="4.5" /><path d="m13 11 8-8" /><path d="m16 6 3 3" /><path d="m10.5 12.5 5.5-5.5" /></>,
  "arrow-up": <><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>,
  broadcast: <><path d="M4 11a9 9 0 0 1 9 9" /><path d="M4 4a16 16 0 0 1 16 16" /><circle cx="5" cy="19" r="1" /></>,
  package: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>,
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  "message-circle": <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  play: <path d="M6 3v18l15-9z" />,
  columns: <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M9 4v16" /><path d="M15 4v16" /></>,
  menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
  refresh: <><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" /><path d="M3 21v-5h5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  tag: <><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" /><path d="M7.5 7.5h.01" /></>,
  maximize: <><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></>,
  minimize: <><path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>,
  wrench: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />,
  mail: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 7L2 7" /></>,
  clipboard: <><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 12h6" /><path d="M9 16h4" /></>,
  paperclip: <path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6A4 4 0 0 1 18 8.8l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5" />,
  "check-circle": <><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 5-5" /></>,
  pin: <><path d="M12 17v5" /><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></>,
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** px (square). Default 16 to sit on a text line. */
  size?: number;
  /** When set, the icon is meaningful on its own → renders <title> + role="img"; otherwise decorative. */
  title?: string;
}

export function Icon({ name, size = 16, title, className = "", ...rest }: IconProps) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
      role={title ? "img" : undefined} aria-hidden={title ? undefined : true}
      className={`inline-block shrink-0 ${className}`}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {SHAPES[name]}
    </svg>
  );
}
