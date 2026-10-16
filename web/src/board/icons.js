const stroke = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 4h4v16h-4zM13.5 4h4v16h-4z"/></svg>',
  muted: stroke('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>'),
  sound: stroke('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
  download: stroke('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  music: stroke('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  cube: stroke('<path d="M21 16V8l-9-5-9 5v8l9 5z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>'),
  ghost: '<svg viewBox="0 0 24 28"><path d="M12 1C6.5 1 3 5 3 10.5V26l3-2.2 3 2.2 3-2.2 3 2.2 3-2.2 3 2.2V10.5C21 5 17.5 1 12 1z"/><circle cx="9" cy="11" r="1.7"/><circle cx="15" cy="11" r="1.7"/></svg>',
};
