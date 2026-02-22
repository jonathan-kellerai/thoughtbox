/**
 * Upstream MCP server connector
 * Handles HTTP+SSE communication with upstream MCP servers
 */

import type { JSONRPCRequest, JSONRPCResponse } from './instrumentation.js';

export interface UpstreamConfig {
  url: string;
  timeoutMs: number;
}

/** Delays (ms) for retry attempts 1, 2, 3. */
const RETRY_DELAYS_MS = [100, 200, 400] as const;
const MAX_RETRIES = RETRY_DELAYS_MS.length;

/** Returns true for errors that are worth retrying (transient). */
function isTransient(status: number | null, err: any): boolean {
  if (err?.name === 'AbortError') return false; // timeout — do not retry
  if (status !== null) return status >= 500;     // 5xx transient, 4xx permanent
  return true;                                   // network/connection errors are transient
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Connector for upstream HTTP+SSE MCP servers
 */
export class UpstreamConnector {
  constructor(private config: UpstreamConfig) {}

  /**
   * Attempt a single HTTP POST to the upstream server.
   * Returns [response, null] on success or [null, Error] on failure.
   */
  private async _attempt(
    request: JSONRPCRequest,
  ): Promise<[JSONRPCResponse, null] | [null, { status: number | null; err: any }]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        return [null, { status: response.status, err: new Error(`Upstream responded with ${response.status}: ${response.statusText}`) }];
      }

      const data = await response.json();
      return [data as JSONRPCResponse, null];
    } catch (err: any) {
      return [null, { status: null, err }];
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Forward a JSON-RPC request to the upstream server with exponential backoff retry.
   * Transient errors (connection errors, 5xx responses) are retried up to 3 times
   * with delays of 100ms, 200ms, and 400ms.  Permanent errors (4xx, timeout) fail
   * immediately without retrying.
   */
  async forwardRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    let lastErr: any = null;
    let lastStatus: number | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        console.log(`[upstream] retry attempt ${attempt}/${MAX_RETRIES} after ${delay}ms`);
        await sleep(delay);
      }

      const [result, failure] = await this._attempt(request);

      if (result !== null) {
        return result;
      }

      lastErr = failure!.err;
      lastStatus = failure!.status;

      if (!isTransient(lastStatus, lastErr)) {
        break; // permanent error — do not retry
      }

      if (attempt < MAX_RETRIES) {
        console.log(`[upstream] transient error on attempt ${attempt + 1}: ${lastErr.message}`);
      }
    }

    // All attempts exhausted (or permanent error)
    if (lastErr?.name === 'AbortError') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32603,
          message: `Upstream timeout after ${this.config.timeoutMs}ms`,
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: `Upstream error: ${lastErr?.message ?? 'unknown'}`,
      },
    };
  }
  
  /**
   * Health check the upstream server
   */
  async healthCheck(): Promise<boolean> {
    try {
      const healthUrl = this.config.url.replace(/\/mcp\/?$/, '/health');
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
