// The clarity.js version pinned by default (PinnedCdn). The canary auto-PRs bumps to this.
export const DEFAULT_CLARITY_VERSION = "0.8.65";

// Fixed virtual-time origin (2023-11-14T22:13:20Z). Used by VirtualClock AND by deterministic
// timezone-offset computation so the realm's clock and its reported getTimezoneOffset agree.
export const CLOCK_ORIGIN = 1_700_000_000_000;
