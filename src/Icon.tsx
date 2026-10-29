type Name =
  | "menu"
  | "refresh"
  | "theater"
  | "eye"
  | "eye-off"
  | "settings"
  | "plus"
  | "check"
  | "play"
  | "close"
  | "list"
  | "arrow"
  | "grip"
  | "trash"
  | "previous"
  | "next"
  | "pause"
  | "back-10"
  | "forward-10";
const paths: Record<Name, string> = {
  menu: "M4 6h16M4 12h16M4 18h16",
  refresh: "M20 8a8 8 0 1 0 0 8M20 3v5h-5",
  theater: "M4 4h16v12H4V4ZM8 20h8M12 16v4M8 8h8M8 12h5",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  "eye-off":
    "M3 3l18 18M9.9 5.2A12 12 0 0 1 12 5c6 0 10 7 10 7a18 18 0 0 1-3 3.8M6.3 6.3A22 22 0 0 0 2 12s4 7 10 7a12 12 0 0 0 5.7-1.7M9.9 9.9a3 3 0 0 0 4.2 4.2",
  settings:
    "m9.5 2-.6 2.4-1.4.8L5.1 4.5 2.6 8.8l1.8 1.7v1.6l-1.8 1.7 2.5 4.3 2.4-.7 1.4.8.6 2.4h5l.6-2.4 1.4-.8 2.4.7 2.5-4.3-1.8-1.7v-1.6l1.8-1.7L18.9 4.5l-2.4.7-1.4-.8L14.5 2h-5ZM15 11.3a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  plus: "M12 5v14M5 12h14",
  check: "m5 12 4 4L19 6",
  play: "m8 4 12 8-12 8V4Z",
  close: "m6 6 12 12M6 18 18 6",
  list: "M9 5h12M9 12h12M9 19h12M3 5h.1M3 12h.1M3 19h.1",
  arrow: "m9 5 7 7-7 7",
  grip: "M9 5h.1M15 5h.1M9 12h.1M15 12h.1M9 19h.1M15 19h.1",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  previous: "M19 5 9 12l10 7V5ZM5 5v14",
  next: "M5 5l10 7-10 7V5ZM19 5v14",
  pause: "M8 5h3v14H8V5Zm5 0h3v14h-3V5Z",
  "back-10": "M9 5H4v5M4.8 9A8 8 0 1 1 4 15",
  "forward-10": "M15 5h5v5M19.2 9A8 8 0 1 0 20 15",
};

export function Icon({ name, size = 20 }: { name: Name; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
      {(name === "back-10" || name === "forward-10") && (
        <text
          x="12"
          y="15"
          fill="currentColor"
          stroke="none"
          fontSize="7"
          fontWeight="700"
          textAnchor="middle"
        >
          10
        </text>
      )}
    </svg>
  );
}
