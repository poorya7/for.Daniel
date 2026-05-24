/**
 * Tiny debug-log helper. Calls fall through to console.log only when the
 * page URL has `?debug=1` (or any non-empty value for `debug`). Otherwise
 * they're silent — keeps the production browser console clean while
 * letting devs flip a switch when they need the diagnostic firehose back.
 *
 * Usage:
 *   import { debugLog } from '../core/debug-log.js';
 *   debugLog('[MORPH] starting at', t);
 */

const _DEBUG = (() => {
  try {
    if (typeof window === 'undefined') return false;
    const v = new URLSearchParams(window.location.search).get('debug');
    return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  } catch (_) {
    return false;
  }
})();

export function debugLog(...args) {
  if (_DEBUG && typeof console !== 'undefined' && console.log) {
    console.log(...args);
  }
}
