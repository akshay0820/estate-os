// The Estate OS lockup: a gradient tile with a house whose door is a flame (BlazeReach), the wordmark with an "OS" tag,
// and the "by BlazeReach" line. Rendered as siblings so the sidebar's collapse rules can hide the text and keep the mark.
export function Brand() {
  return (
    <>
      <span className="sb-logo" aria-hidden>
        <svg width="18" height="18" viewBox="0 0 24 24">
          <defs>
            <linearGradient id="brand-flame" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffe3a3" />
              <stop offset="1" stopColor="#ffb547" />
            </linearGradient>
          </defs>
          <path d="M3 10.4 12 3.3l9 7.1v9.9a.7.7 0 0 1-.7.7H3.7a.7.7 0 0 1-.7-.7z" fill="#160a05" />
          <path d="M12 10.6c.45 1.9-.7 2.9-1.7 3.95-.65.7-1.2 1.45-1.2 2.6A2.9 2.9 0 0 0 12 20.05a2.9 2.9 0 0 0 2.9-2.9c0-1.2-.55-2.05-1.2-2.7 0 .85-.35 1.5-.9 1.85.1-1.95-.3-3.85-.8-5.7z" fill="url(#brand-flame)" />
        </svg>
      </span>
      <div className="sb-name">
        <span className="brand-word">
          Estate<span className="brand-os">OS</span>
        </span>
        <small>by BlazeReach</small>
      </div>
    </>
  );
}
