// api/lib/sentry.js — Error monitoring wrapper (Sentry)
// Usage: import { captureException } from './lib/sentry.js';
//        captureException(err, { action: 'pre-meeting', lead_id });
//
// Requires env var: SENTRY_DSN
// No-op when SENTRY_DSN is absent (dev / missing setup).

import * as Sentry from '@sentry/node';

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn:               process.env.SENTRY_DSN,
    tracesSampleRate:  0,   // traces off — errors only
    environment:       process.env.VERCEL_ENV || 'production',
  });
}

export function captureException(err, context = {}) {
  init();
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope(scope => {
    Object.entries(context).forEach(([k, v]) => scope.setExtra(k, v));
    Sentry.captureException(err);
  });
}
