// Web modules are written for the browser. Tests load them in Node, so give them the little of
// `window` they touch while loading (api.ts listens for session changes from other tabs).
(globalThis as { window?: unknown }).window ??= { addEventListener() {} };
