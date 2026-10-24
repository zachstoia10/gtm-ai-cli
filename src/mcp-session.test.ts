import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SdkHttpError, SdkErrorCode } from '@modelcontextprotocol/client';

const connect = vi.fn();
const callTool = vi.fn();
const close = vi.fn();
vi.mock('@modelcontextprotocol/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Client: class { connect = connect; callTool = callTool; close = close; },
  StreamableHTTPClientTransport: class {},
}));

// The refresh policy is tested in credentials.test.ts; here withSession just runs the request.
vi.mock('./credentials.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withSession: async (request: (creds: { access_token: string }) => Promise<unknown>) => request({ access_token: 'token' }),
}));

const ok = { content: [{ type: 'text', text: '{"ok":true}' }] };

// mcp.ts caches its client per process, so import it fresh per test.
async function load() {
  vi.resetModules();
  return { ...(await import('./mcp.js')), ...(await import('./credentials.js')) };
}

beforeEach(() => {
  for (const fn of [connect, callTool, close]) fn.mockReset();
});

describe('mcpCall session handling', () => {
  it('reports a rejected token to the session handler', async () => {
    connect.mockRejectedValue(new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Error POSTing to endpoint: invalid token', { status: 401 }));
    const { mcpCall, SessionRejected } = await load();
    await expect(mcpCall('search_companies', {})).rejects.toBeInstanceOf(SessionRejected);
  });

  it('passes other errors through', async () => {
    connect.mockRejectedValue(new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Bad gateway', { status: 502 }));
    const { mcpCall } = await load();
    await expect(mcpCall('search_companies', {})).rejects.toThrow(/Bad gateway/);
  });

  it('allows tool calls more than the SDK default 60s', async () => {
    callTool.mockResolvedValue(ok);
    const { mcpCall } = await load();
    await expect(mcpCall('account_research', {})).resolves.toEqual({ ok: true });
    expect(callTool.mock.calls[0][1].timeout).toBeGreaterThan(60_000);
  });
});
