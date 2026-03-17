/**
 * Moltbot + Cloudflare Sandbox
 *
 * This Worker runs Moltbot personal AI assistant in a Cloudflare Sandbox container.
 * It proxies all requests to the Moltbot Gateway's web UI and WebSocket endpoint.
 *
 * Features:
 * - Web UI (Control Dashboard + WebChat) at /
 * - WebSocket support for real-time communication
 * - Admin UI at /_admin/ for device management
 * - Configuration via environment secrets
 *
 * Required secrets (set via `wrangler secret put`):
 * - ANTHROPIC_API_KEY: Your Anthropic API key
 *
 * Optional secrets:
 * - MOLTBOT_GATEWAY_TOKEN: Token to protect gateway access
 * - TELEGRAM_BOT_TOKEN: Telegram bot token
 * - DISCORD_BOT_TOKEN: Discord bot token
 * - SLACK_BOT_TOKEN + SLACK_APP_TOKEN: Slack tokens
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { AppEnv, MoltbotEnv } from './types';
import { MOLTBOT_PORT } from './config';
import { createAccessMiddleware } from './auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess, syncToR2 } from './gateway';
import { publicRoutes, api, adminUi, debug, cdp } from './routes';
import { redactSensitiveParams } from './utils/logging';
import loadingPageHtml from './assets/loading.html';
import configErrorHtml from './assets/config-error.html';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }

  if (message.includes('pairing required')) {
    return `Pairing required. Visit https://${host}/_admin/`;
  }

  return message;
}

export { Sandbox };

/**
 * Validate required environment variables.
 * Returns an array of missing variable descriptions, or empty array if all are set.
 */
function validateRequiredEnv(env: MoltbotEnv): string[] {
  const missing: string[] = [];
  const isTestMode = env.DEV_MODE === 'true' || env.E2E_TEST_MODE === 'true';

  if (!env.MOLTBOT_GATEWAY_TOKEN) {
    missing.push('MOLTBOT_GATEWAY_TOKEN');
  }

  // CF Access vars not required in dev/test mode since auth is skipped
  if (!isTestMode) {
    if (!env.CF_ACCESS_TEAM_DOMAIN) {
      missing.push('CF_ACCESS_TEAM_DOMAIN');
    }

    if (!env.CF_ACCESS_AUD) {
      missing.push('CF_ACCESS_AUD');
    }
  }

  // Check for AI provider configuration (at least one must be set)
  const hasCloudflareGateway = !!(
    env.CLOUDFLARE_AI_GATEWAY_API_KEY &&
    env.CF_AI_GATEWAY_ACCOUNT_ID &&
    env.CF_AI_GATEWAY_GATEWAY_ID
  );
  const hasLegacyGateway = !!(env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL);
  const hasAnthropicKey = !!env.ANTHROPIC_API_KEY;
  const hasOpenAIKey = !!env.OPENAI_API_KEY;

  if (!hasCloudflareGateway && !hasLegacyGateway && !hasAnthropicKey && !hasOpenAIKey) {
    missing.push(
      'ANTHROPIC_API_KEY, OPENAI_API_KEY, or CLOUDFLARE_AI_GATEWAY_API_KEY + CF_AI_GATEWAY_ACCOUNT_ID + CF_AI_GATEWAY_GATEWAY_ID',
    );
  }

  return missing;
}

/**
 * Build sandbox options based on environment configuration.
 *
 * SANDBOX_SLEEP_AFTER controls how long the container stays alive after inactivity:
 * - 'never' (default): Container stays alive indefinitely (recommended due to long cold starts)
 * - Duration string: e.g., '10m', '1h', '30s' - container sleeps after this period of inactivity
 *
 * To reduce costs at the expense of cold start latency, set SANDBOX_SLEEP_AFTER to a duration:
 *   npx wrangler secret put SANDBOX_SLEEP_AFTER
 *   # Enter: 10m (or 1h, 30m, etc.)
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';

  // 'never' means keep the container alive indefinitely
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }

  // Otherwise, use the specified duration
  return { sleepAfter };
}

// Main app
const app = new Hono<AppEnv>();

// =============================================================================
// MIDDLEWARE: Applied to ALL routes
// =============================================================================

// Middleware: Log every request
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const redactedSearch = redactSensitiveParams(url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${redactedSearch}`);
  console.log(`[REQ] Has ANTHROPIC_API_KEY: ${!!c.env.ANTHROPIC_API_KEY}`);
  console.log(`[REQ] DEV_MODE: ${c.env.DEV_MODE}`);
  console.log(`[REQ] DEBUG_ROUTES: ${c.env.DEBUG_ROUTES}`);
  await next();
});

// Middleware: Initialize sandbox for all requests
app.use('*', async (c, next) => {
  const options = buildSandboxOptions(c.env);
  const sandbox = getSandbox(c.env.Sandbox, 'moltbot', options);
  c.set('sandbox', sandbox);
  await next();
});

// =============================================================================
// PUBLIC ROUTES: No Cloudflare Access authentication required
// =============================================================================

// Mount public routes first (before auth middleware)
// Includes: /sandbox-health, /logo.png, /logo-small.png, /api/status, /_admin/assets/*
app.route('/', publicRoutes);

// Mount CDP routes (uses shared secret auth via query param, not CF Access)
app.route('/cdp', cdp);

// =============================================================================
// PROTECTED ROUTES: Cloudflare Access authentication required
// =============================================================================

// Middleware: Validate required environment variables (skip in dev mode and for debug routes)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);

  // Skip validation for debug routes (they have their own enable check)
  if (url.pathname.startsWith('/debug')) {
    return next();
  }

  // Skip validation in dev mode
  if (c.env.DEV_MODE === 'true') {
    return next();
  }

  const missingVars = validateRequiredEnv(c.env);
  if (missingVars.length > 0) {
    console.error('[CONFIG] Missing required environment variables:', missingVars.join(', '));

    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      // Return a user-friendly HTML error page
      const html = configErrorHtml.replace('{{MISSING_VARS}}', missingVars.join(', '));
      return c.html(html, 503);
    }

    // Return JSON error for API requests
    return c.json(
      {
        error: 'Configuration error',
        message: 'Required environment variables are not configured',
        missing: missingVars,
        hint: 'Set these using: wrangler secret put <VARIABLE_NAME>',
      },
      503,
    );
  }

  return next();
});

// Middleware: Cloudflare Access authentication for protected routes
app.use('*', async (c, next) => {
  // Determine response type based on Accept header
  const acceptsHtml = c.req.header('Accept')?.includes('text/html');
  const middleware = createAccessMiddleware({
    type: acceptsHtml ? 'html' : 'json',
    redirectOnMissing: acceptsHtml,
  });

  return middleware(c, next);
});

// Mount API routes (protected by Cloudflare Access)
app.route('/api', api);

// Mount Admin UI routes (protected by Cloudflare Access)
app.route('/_admin', adminUi);

// Mount debug routes (protected by Cloudflare Access, only when DEBUG_ROUTES is enabled)
app.use('/debug/*', async (c, next) => {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }
  return next();
});
app.route('/debug', debug);

// =============================================================================
// CATCH-ALL: Proxy to Moltbot gateway
// =============================================================================

app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  const request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname);

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  // For browser requests (non-WebSocket, non-API), show loading page if gateway isn't ready
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');

  if (!isGatewayReady && !isWebSocketRequest && acceptsHtml) {
    console.log('[PROXY] Gateway not ready, serving loading page');

    // Start the gateway in the background (don't await)
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).catch((err: Error) => {
        console.error('[PROXY] Background gateway start failed:', err);
      }),
    );

    // Return the loading page immediately
    return c.html(loadingPageHtml);
  }

  // Ensure moltbot is running (this will wait for startup)
  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('[PROXY] Failed to start Moltbot:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    let hint = 'Check worker logs with: wrangler tail';
    if (!c.env.ANTHROPIC_API_KEY) {
      hint = 'ANTHROPIC_API_KEY is not set. Run: wrangler secret put ANTHROPIC_API_KEY';
    } else if (errorMessage.includes('heap out of memory') || errorMessage.includes('OOM')) {
      hint = 'Gateway ran out of memory. Try again or check for memory leaks.';
    }

    return c.json(
      {
        error: 'Moltbot gateway failed to start',
        details: errorMessage,
        hint,
      },
      503,
    );
  }

  // Proxy to Moltbot with WebSocket message interception
  if (isWebSocketRequest) {
    const debugLogs = c.env.DEBUG_ROUTES === 'true';
    const redactedSearch = redactSensitiveParams(url);

    console.log('[WS] Proxying WebSocket connection to Moltbot');
    if (debugLogs) {
      console.log('[WS] URL:', url.pathname + redactedSearch);
    }

    // Convert ?token= query param to Authorization: Bearer header.
    // ZeroClaw expects Authorization: Bearer <token>, not a query param.
    // Also handles CF Access redirects that strip query params — fall back to MOLTBOT_GATEWAY_TOKEN.
    const wsToken = url.searchParams.get('token') || c.env.MOLTBOT_GATEWAY_TOKEN;
    const wsHeaders = new Headers(request.headers);
    if (wsToken) {
      wsHeaders.set('Authorization', `Bearer ${wsToken}`);
    }
    // Build container-local URL — wsConnect needs the path/query, not the external hostname.
    // Using the external hostname could cause wsConnect to connect externally instead of to the container.
    const containerUrl = new URL(`http://localhost:${MOLTBOT_PORT}${url.pathname}${url.search}`);
    containerUrl.searchParams.delete('token');
    const wsRequest = new Request(containerUrl.toString(), { headers: wsHeaders, method: request.method });
    if (debugLogs) {
      console.log('[WS] Container URL:', containerUrl.toString());
    }

    // Get WebSocket connection to the container.
    // wsConnect is designed for WebSocket upgrades and returns response.webSocket.
    // containerFetch does NOT support WebSocket upgrades (returns plain HTTP Response).
    // ZeroClaw gateway binds directly on 0.0.0.0:42617 (configured in config.toml).
    const containerResponse = await sandbox.wsConnect(wsRequest, MOLTBOT_PORT);
    console.log('[WS] wsConnect response status:', containerResponse.status);
    console.log('[WS] wsConnect response headers:', JSON.stringify(Object.fromEntries(containerResponse.headers.entries())));

    // Get the container-side WebSocket
    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      // Log the response body to understand why upgrade failed
      try {
        const body = await containerResponse.clone().text();
        console.error('[WS] No WebSocket in container response. Body preview:', body.slice(0, 500));
      } catch (e) {
        console.error('[WS] No WebSocket in container response, could not read body');
      }
      console.error('[WS] Falling back to direct proxy');
      return containerResponse;
    }

    if (debugLogs) {
      console.log('[WS] Got container WebSocket, setting up interception');
    }

    // Create a WebSocket pair for the client
    const [clientWs, serverWs] = Object.values(new WebSocketPair());

    // IMPORTANT: Attach event listeners BEFORE accept() to avoid losing early messages.
    // ZeroClaw may send messages immediately after upgrade (e.g., handshake, initial state).

    let wsMessageCount = 0;

    // Relay messages from client to container
    serverWs.addEventListener('message', (event) => {
      if (debugLogs || wsMessageCount < 3) {
        console.log(
          '[WS] Client -> Container:',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)',
        );
      }
      try {
        containerWs.send(event.data);
      } catch (e) {
        console.error('[WS] Failed to send to container:', e);
      }
    });

    // Relay messages from container to client, with error transformation
    containerWs.addEventListener('message', (event) => {
      wsMessageCount++;
      if (debugLogs || wsMessageCount <= 3) {
        console.log(
          '[WS] Container -> Client:',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 500) : '(binary)',
        );
      }
      let data = event.data;

      // Try to intercept and transform error messages
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error?.message) {
            parsed.error.message = transformErrorMessage(parsed.error.message, url.host);
            data = JSON.stringify(parsed);
          }
        } catch {
          // Not JSON, pass through as-is
        }
      }

      try {
        serverWs.send(data);
      } catch (e) {
        console.error('[WS] Failed to send to client:', e);
      }
    });

    // Handle close events
    serverWs.addEventListener('close', (event) => {
      console.log('[WS] Client closed:', event.code, event.reason);
      containerWs.close(event.code, event.reason);
    });

    containerWs.addEventListener('close', (event) => {
      console.log('[WS] Container closed:', event.code, event.reason);
      let reason = transformErrorMessage(event.reason, url.host);
      if (reason.length > 123) {
        reason = reason.slice(0, 120) + '...';
      }
      serverWs.close(event.code, reason);
    });

    // Handle errors
    serverWs.addEventListener('error', (event) => {
      console.error('[WS] Client error:', event);
      containerWs.close(1011, 'Client error');
    });

    containerWs.addEventListener('error', (event) => {
      console.error('[WS] Container error:', event);
      serverWs.close(1011, 'Container error');
    });

    // Accept AFTER listeners are attached — this starts message delivery
    serverWs.accept();
    containerWs.accept();
    console.log('[WS] WebSocket relay established for', url.pathname);

    if (debugLogs) {
      console.log('[WS] Returning intercepted WebSocket response');
    }

    // Forward WebSocket response headers from the container (especially Sec-WebSocket-Protocol).
    // If the browser requested a subprotocol (e.g., "zeroclaw.v1") and we don't echo it back,
    // the browser will reject the upgrade per RFC 6455.
    const wsResponseHeaders = new Headers();
    const subprotocol = containerResponse.headers.get('sec-websocket-protocol');
    if (subprotocol) {
      wsResponseHeaders.set('sec-websocket-protocol', subprotocol);
      if (debugLogs) {
        console.log('[WS] Forwarding subprotocol:', subprotocol);
      }
    }

    return new Response(null, {
      status: 101,
      webSocket: clientWs,
      headers: wsResponseHeaders,
    });
  }

  console.log('[HTTP] Proxying:', url.pathname + url.search);
  const httpResponse = await sandbox.containerFetch(request, MOLTBOT_PORT);
  console.log('[HTTP] Response status:', httpResponse.status);

  const contentType = httpResponse.headers.get('content-type') || '';
  const isSSE = contentType.includes('text/event-stream');

  if (isSSE) {
    console.log('[SSE] Detected event-stream response for', url.pathname);
  }

  // Add debug header to verify worker handled the request
  const newHeaders = new Headers(httpResponse.headers);
  newHeaders.set('X-Worker-Debug', 'proxy-to-moltbot');
  newHeaders.set('X-Debug-Path', url.pathname);

  // For SSE responses, ensure proper streaming headers to prevent edge buffering
  if (isSSE) {
    newHeaders.set('Cache-Control', 'no-cache, no-transform');
    newHeaders.set('X-Accel-Buffering', 'no');
    newHeaders.delete('Content-Length');
    newHeaders.delete('Content-Encoding');

    // Pipe through a TransformStream to ensure chunked streaming delivery.
    // Without this, containerFetch may buffer the entire SSE response.
    if (httpResponse.body) {
      const { readable, writable } = new TransformStream();
      httpResponse.body.pipeTo(writable).catch((err) => {
        console.error('[SSE] Stream pipe error:', err);
      });
      return new Response(readable, {
        status: httpResponse.status,
        statusText: httpResponse.statusText,
        headers: newHeaders,
      });
    }
  }

  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: newHeaders,
  });
});

export default {
  fetch: app.fetch,
  /**
   * Cloudflare Worker Scheduled Event (Cron Trigger)
   *
   * This handler is called whenever a Cron Trigger fires.
   * It wakes up the Sandbox container and ensures the ZeroClaw gateway is running.
   * This is necessary because the container sleeps when idle, which prevents
   * internal ZeroClaw cron jobs and background processes from firing.
   */
  async scheduled(event: ScheduledEvent, env: MoltbotEnv, _ctx: ExecutionContext) {
    console.log(`[CRON] Scheduled event fired: ${event.cron}`);

    // Build sandbox options (honoring SANDBOX_SLEEP_AFTER)
    const options = buildSandboxOptions(env);

    // Get the sandbox instance
    const sandbox = getSandbox(env.Sandbox, 'moltbot', options);

    // Ensure the gateway is running (this wakes up the container if it's sleeping)
    try {
      console.log('[CRON] Ensuring ZeroClaw gateway is running...');
      await ensureMoltbotGateway(sandbox, env);
      console.log('[CRON] ZeroClaw gateway is ready, container is awake.');

      // Also trigger a sync to R2 to ensure persistence
      console.log('[CRON] Triggering periodic sync to R2...');
      const syncResult = await syncToR2(sandbox, env);
      if (syncResult.success) {
        console.log(`[CRON] Periodic sync complete. Last sync: ${syncResult.lastSync}`);
      } else {
        console.warn(`[CRON] Periodic sync skipped or failed: ${syncResult.error}`);
      }
    } catch (error) {
      console.error('[CRON] Scheduled task failed:', error);
    }
  },
};
