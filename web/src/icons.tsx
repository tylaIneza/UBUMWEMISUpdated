/** Small outline icon set drawn inline (no icon library is installed, and none is needed). */
const PATHS = {
  dashboard: 'M4 4h7v7H4z M13 4h7v4h-7z M13 11h7v9h-7z M4 14h7v6H4z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7.5V12l3 2',
  building: 'M5 21V4h9v17 M14 9h5v12 M3 21h18 M8 8h3 M8 12h3 M8 16h3',
  layers: 'M12 3l9 5-9 5-9-5z M3 12.5l9 5 9-5 M3 17l9 5 9-5',
  door: 'M6 21V3h11v18 M4 21h16 M13.5 12v.01',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21a7 7 0 0 1 14 0 M17 3.5a4 4 0 0 1 0 7.5 M22 21a7 7 0 0 0-4-6.3',
  file: 'M7 3h7l5 5v13H7z M14 3v5h5 M10 13h6 M10 17h6',
  wrench: 'M15 4.5a4.5 4.5 0 0 0 4.6 5.9L10 20a2.1 2.1 0 0 1-3-3l9.6-9.6A4.5 4.5 0 0 1 15 4.5z',
  calendar: 'M5 6h14v14H5z M5 10h14 M9 3v4 M15 3v4',
  wallet: 'M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4z M4 7V5h12v2 M16 13.5h.01',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  card: 'M3 6h18v12H3z M3 10h18 M7 15h3',
  check: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M8 12.5l3 3 5-6',
  chart: 'M4 20V4 M4 20h16 M8 16v-5 M12 16V8 M16 16v-3',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z M10 21h4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  sliders: 'M4 6h10 M18 6h2 M4 12h4 M12 12h8 M4 18h12 M14 4v4 M8 10v4 M16 16v4',
  list: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4-4',
  coin: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M9.5 15h4a2 2 0 0 0 0-4h-3a2 2 0 0 1 0-4h4 M12 5.5V7 M12 17v1.5',
  alert: 'M12 8v5 M12 16.5v.01 M12 3l9.5 17h-19z',
  trend: 'M3 17l6-6 4 4 8-8 M15 7h6v6',
  logout: 'M10 4H5v16h5 M15 8l4 4-4 4 M19 12H9',
  half: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 3v18',
  key: 'M14 10a4 4 0 1 0-3.5 4L7 17.5V20h3v-2h2v-2h1.5l1-1A4 4 0 0 0 14 10z M16.5 7.5h.01',
} as const;

export type IconName = keyof typeof PATHS;

export function I({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
