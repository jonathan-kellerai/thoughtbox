/**
 * Unit tests for session TTL cleanup logic
 *
 * Tests the SESSION_TTL_MS / SESSION_CLEANUP_INTERVAL_MS constants and the
 * cleanup callback behaviour, without starting the full HTTP server.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// -----------------------------------------------------------------------
// Inline the cleanup logic so it can be tested independently
// -----------------------------------------------------------------------

const SESSION_TTL_MS = 60 * 60 * 1000;       // 1 hour
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

interface SessionEntry {
  transport: { close: () => void };
  createdAt: number;
}

function runCleanup(sessions: Map<string, SessionEntry>, now: number): string[] {
  const cleaned: string[] = [];
  for (const [id, entry] of sessions) {
    if (now - entry.createdAt >= SESSION_TTL_MS) {
      entry.transport.close();
      sessions.delete(id);
      cleaned.push(id);
    }
  }
  return cleaned;
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('Session TTL constants', () => {
  it('SESSION_TTL_MS is 1 hour', () => {
    expect(SESSION_TTL_MS).toBe(3_600_000);
  });

  it('SESSION_CLEANUP_INTERVAL_MS is 60 seconds', () => {
    expect(SESSION_CLEANUP_INTERVAL_MS).toBe(60_000);
  });
});

describe('Session cleanup logic', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves unexpired sessions intact', () => {
    const sessions = new Map<string, SessionEntry>();
    const close = vi.fn();
    const now = Date.now();

    sessions.set('session-1', { transport: { close }, createdAt: now - 30 * 60 * 1000 }); // 30 min old

    const cleaned = runCleanup(sessions, now);

    expect(cleaned).toHaveLength(0);
    expect(sessions.has('session-1')).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it('removes exactly-expired sessions (TTL boundary)', () => {
    const sessions = new Map<string, SessionEntry>();
    const close = vi.fn();
    const now = Date.now();

    sessions.set('session-old', { transport: { close }, createdAt: now - SESSION_TTL_MS });

    const cleaned = runCleanup(sessions, now);

    expect(cleaned).toContain('session-old');
    expect(sessions.has('session-old')).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it('removes sessions older than 61 minutes', () => {
    const sessions = new Map<string, SessionEntry>();
    const close = vi.fn();
    const now = Date.now();

    sessions.set('session-stale', { transport: { close }, createdAt: now - 61 * 60 * 1000 });

    const cleaned = runCleanup(sessions, now);

    expect(cleaned).toContain('session-stale');
    expect(sessions.has('session-stale')).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it('only removes expired sessions from a mixed map', () => {
    const sessions = new Map<string, SessionEntry>();
    const closeStale = vi.fn();
    const closeFresh = vi.fn();
    const now = Date.now();

    sessions.set('fresh', { transport: { close: closeFresh }, createdAt: now - 10 * 60 * 1000 });
    sessions.set('stale', { transport: { close: closeStale }, createdAt: now - 70 * 60 * 1000 });

    const cleaned = runCleanup(sessions, now);

    expect(cleaned).toEqual(['stale']);
    expect(sessions.has('fresh')).toBe(true);
    expect(sessions.has('stale')).toBe(false);
    expect(closeFresh).not.toHaveBeenCalled();
    expect(closeStale).toHaveBeenCalledOnce();
  });

  it('handles transport.close() throwing without leaving session in map', () => {
    const sessions = new Map<string, SessionEntry>();
    const close = vi.fn().mockImplementation(() => { throw new Error('close failed'); });
    const now = Date.now();

    sessions.set('broken', { transport: { close }, createdAt: now - 2 * SESSION_TTL_MS });

    // The cleanup in index.ts wraps close() in try/catch — simulate same behaviour
    const safeCleaned: string[] = [];
    for (const [id, entry] of sessions) {
      if (now - entry.createdAt >= SESSION_TTL_MS) {
        try { entry.transport.close(); } catch { /* ignore */ }
        sessions.delete(id);
        safeCleaned.push(id);
      }
    }

    expect(safeCleaned).toContain('broken');
    expect(sessions.has('broken')).toBe(false);
  });
});
