const paths: Record<string, string[]> = {
  compass: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20",
    "m16.5 7.5-3 6-6 3 3-6 6-3",
  ],
  grid: ["M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"],
  map: ["m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6", "M9 3v15M15 6v15"],
  pin: [
    "M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0",
    "M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  ],
  album: [
    "M4 3h14a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V3",
    "M4 17h16M9 3v7l2-2 2 2V3",
  ],
  tag: ["m20 13-7 7a2 2 0 0 1-3 0l-8-8V3h9l9 7a2 2 0 0 1 0 3", "M7 7h.01"],
  search: ["M21 21l-5-5", "M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0"],
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  expand: ["M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"],
  shrink: ["M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3"],
  close: ["m6 6 12 12M6 18 18 6"],
  arrow: ["M5 12h14m-6-6 6 6-6 6"],
  left: ["m15 18-6-6 6-6"],
  right: ["m9 6 6 6-6 6"],
  check: ["m5 12 4 4L19 6"],
  refresh: ["M20 7v5h-5M4 17v-5h5", "M6 6a8 8 0 0 1 13 2M18 18A8 8 0 0 1 5 16"],
  image: ["M3 3h18v18H3z", "m3 16 5-5 4 4 3-3 6 6", "M8 7h.01"],
  folder: ["M3 5h6l2 2h10v13H3V5"],
  sliders: ["M4 7h16M4 17h16M8 4v6M16 14v6"],
  split: ["M3 4h18v16H3zM13 4v16"],
  download: ["M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"],
  alert: ["m12 3 10 18H2L12 3", "M12 9v5m0 3h.01"],
  stop: ["M6 6h12v12H6z"],
  edit: ["m16 3 5 5-12 12-6 1 1-6L16 3", "m14 5 5 5"],
  trash: ["M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"],
  globe: [
    "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    "M2 12h20M12 2c6 6 6 14 0 20-6-6-6-14 0-20",
  ],
};
export function Icon({
  name,
  size = 20,
  ...props
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {(paths[name] || paths.image).map((d, i) => (
        <path d={d} key={i} />
      ))}
    </svg>
  );
}
