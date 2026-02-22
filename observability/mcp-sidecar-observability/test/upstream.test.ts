/**
 * Unit tests for UpstreamConnector retry logic
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamConnector } from '../src/upstream.js';

const MOCK_REQUEST = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/list',
};

function makeResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function make5xxResponse(): Response {
  return new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' });
}

function make4xxResponse(): Response {
  return new Response('Not Found', { status: 404, statusText: 'Not Found' });
}

test('UpstreamConnector: succeeds on first attempt', async () => {
  const connector = new UpstreamConnector({ url: 'http://localhost:9999', timeoutMs: 5000 });
  const mockResult = { jsonrpc: '2.0', id: 1, result: { tools: [] } };

  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    return makeResponse(mockResult);
  };

  try {
    const result = await connector.forwardRequest(MOCK_REQUEST);
    assert.equal(callCount, 1);
    assert.deepEqual(result, mockResult);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UpstreamConnector: succeeds on second attempt after transient 5xx', async () => {
  const connector = new UpstreamConnector({ url: 'http://localhost:9999', timeoutMs: 5000 });
  const mockResult = { jsonrpc: '2.0', id: 1, result: { tools: [] } };

  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) return make5xxResponse();
    return makeResponse(mockResult);
  };

  try {
    const result = await connector.forwardRequest(MOCK_REQUEST);
    assert.equal(callCount, 2);
    assert.deepEqual(result, mockResult);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UpstreamConnector: exhausts all retries on repeated 5xx and returns error response', async () => {
  const connector = new UpstreamConnector({ url: 'http://localhost:9999', timeoutMs: 5000 });

  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    return make5xxResponse();
  };

  try {
    const result = await connector.forwardRequest(MOCK_REQUEST);
    // 1 initial + 3 retries = 4 calls
    assert.equal(callCount, 4);
    assert.ok(result.error, 'expected error response');
    assert.equal(result.error!.code, -32603);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UpstreamConnector: does not retry on 4xx (permanent error)', async () => {
  const connector = new UpstreamConnector({ url: 'http://localhost:9999', timeoutMs: 5000 });

  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    return make4xxResponse();
  };

  try {
    const result = await connector.forwardRequest(MOCK_REQUEST);
    assert.equal(callCount, 1, 'should not retry 4xx');
    assert.ok(result.error, 'expected error response');
    assert.equal(result.error!.code, -32603);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UpstreamConnector: retries on connection error (fetch throws)', async () => {
  const connector = new UpstreamConnector({ url: 'http://localhost:9999', timeoutMs: 5000 });
  const mockResult = { jsonrpc: '2.0', id: 1, result: { tools: [] } };

  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    callCount++;
    if (callCount < 3) throw new Error('ECONNREFUSED');
    return makeResponse(mockResult);
  };

  try {
    const result = await connector.forwardRequest(MOCK_REQUEST);
    assert.equal(callCount, 3);
    assert.deepEqual(result, mockResult);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
