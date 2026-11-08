'use strict';
// Bounded retry for a USER-INITIATED connection attempt. This retries only the
// single connect the user explicitly asked for — a radio still booting, a
// momentary network blip, a serial port briefly busy — with backoff before
// giving up. It deliberately does NOT silently auto-reconnect a dropped live
// session; reconnecting after a drop stays an explicit, opt-in user action.
const TRANSIENT_CODES = ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE', 'EAGAIN', 'EBUSY'];
function isTransient(error) {
  if (!error) return false;
  if (error.code && TRANSIENT_CODES.includes(error.code)) return true;
  return /timed out|temporarily unavailable|resource busy|cannot open/i.test(String(error.message || ''));
}
function backoffMs(attempt, { baseMs = 400, maxMs = 3000 } = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer');
  return Math.min(maxMs, baseMs * 2 ** (attempt - 1));
}
// open() performs one connection attempt and resolves/rejects. Non-retryable
// errors (bad host, invalid port, permission denied) reject immediately; only
// transient failures are retried, up to `attempts` times total.
async function connectWithRetry(open, { attempts = 3, baseMs = 400, maxMs = 3000, isRetryable = isTransient, delay = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (typeof open !== 'function') throw new TypeError('open function required');
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts must be a positive integer');
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await open();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryable(error)) throw error;
      await delay(backoffMs(attempt, { baseMs, maxMs }));
    }
  }
  throw lastError;
}
module.exports = { isTransient, backoffMs, connectWithRetry };
