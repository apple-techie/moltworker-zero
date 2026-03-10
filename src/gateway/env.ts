import type { MoltbotEnv } from '../types';

/**
 * Build environment variables to pass to the ZeroClaw container process
 *
 * @param env - Worker environment bindings
 * @returns Environment variables record
 */
export function buildEnvVars(env: MoltbotEnv): Record<string, string> {
  const envVars: Record<string, string> = {};

  // Cloudflare AI Gateway configuration (new native provider)
  if (env.CLOUDFLARE_AI_GATEWAY_API_KEY) {
    envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  }
  if (env.CF_AI_GATEWAY_ACCOUNT_ID) {
    envVars.CF_AI_GATEWAY_ACCOUNT_ID = env.CF_AI_GATEWAY_ACCOUNT_ID;
  }
  if (env.CF_AI_GATEWAY_GATEWAY_ID) {
    envVars.CF_AI_GATEWAY_GATEWAY_ID = env.CF_AI_GATEWAY_GATEWAY_ID;
  }

  // Direct provider keys
  if (env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = env.OPENAI_API_KEY;

  // Legacy AI Gateway support: AI_GATEWAY_BASE_URL + AI_GATEWAY_API_KEY
  // When set, these override direct keys for backward compatibility
  if (env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL) {
    const normalizedBaseUrl = env.AI_GATEWAY_BASE_URL.replace(/\/+$/, '');
    envVars.AI_GATEWAY_BASE_URL = normalizedBaseUrl;
    // Legacy path routes through Anthropic base URL
    envVars.ANTHROPIC_BASE_URL = normalizedBaseUrl;
    envVars.ANTHROPIC_API_KEY = env.AI_GATEWAY_API_KEY;
  } else if (env.ANTHROPIC_BASE_URL) {
    envVars.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  }

  // Map MOLTBOT_GATEWAY_TOKEN to ZEROCLAW_GATEWAY_TOKEN (container expects this name)
  // TODO: confirm ZEROCLAW_GATEWAY_TOKEN is the correct env var name for zeroclaw
  if (env.MOLTBOT_GATEWAY_TOKEN) envVars.ZEROCLAW_GATEWAY_TOKEN = env.MOLTBOT_GATEWAY_TOKEN;
  if (env.DEV_MODE) envVars.ZEROCLAW_DEV_MODE = env.DEV_MODE;

  // Cloudflare Workers AI direct access (no AI Gateway intermediary)
  if (env.CLOUDFLARE_AUTH_TOKEN) envVars.CLOUDFLARE_AUTH_TOKEN = env.CLOUDFLARE_AUTH_TOKEN;
  if (env.WORKERS_AI_MODEL) envVars.WORKERS_AI_MODEL = env.WORKERS_AI_MODEL;

  // Custom provider configuration
  if (env.CUSTOM_PROVIDER_URL) envVars.CUSTOM_PROVIDER_URL = env.CUSTOM_PROVIDER_URL;
  if (env.ANTHROPIC_CUSTOM_URL) envVars.ANTHROPIC_CUSTOM_URL = env.ANTHROPIC_CUSTOM_URL;
  if (env.CUSTOM_API_KEY) envVars.CUSTOM_API_KEY = env.CUSTOM_API_KEY;
  if (env.ZEROCLAW_API_KEY) envVars.ZEROCLAW_API_KEY = env.ZEROCLAW_API_KEY;
  if (env.CUSTOM_PROVIDER_API) envVars.CUSTOM_PROVIDER_API = env.CUSTOM_PROVIDER_API;
  if (env.ZEROCLAW_RESPONSES_WEBSOCKET)
    envVars.ZEROCLAW_RESPONSES_WEBSOCKET = env.ZEROCLAW_RESPONSES_WEBSOCKET;
  if (env.DEFAULT_MODEL) envVars.DEFAULT_MODEL = env.DEFAULT_MODEL;
  if (env.TELEGRAM_BOT_TOKEN) envVars.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  if (env.TELEGRAM_DM_POLICY) envVars.TELEGRAM_DM_POLICY = env.TELEGRAM_DM_POLICY;
  if (env.DISCORD_BOT_TOKEN) envVars.DISCORD_BOT_TOKEN = env.DISCORD_BOT_TOKEN;
  if (env.DISCORD_DM_POLICY) envVars.DISCORD_DM_POLICY = env.DISCORD_DM_POLICY;
  if (env.SLACK_BOT_TOKEN) envVars.SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
  if (env.SLACK_APP_TOKEN) envVars.SLACK_APP_TOKEN = env.SLACK_APP_TOKEN;
  if (env.CF_AI_GATEWAY_MODEL) envVars.CF_AI_GATEWAY_MODEL = env.CF_AI_GATEWAY_MODEL;
  if (env.CF_ACCOUNT_ID) envVars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;
  if (env.CDP_SECRET) envVars.CDP_SECRET = env.CDP_SECRET;
  if (env.WORKER_URL) envVars.WORKER_URL = env.WORKER_URL;

  // R2 persistence credentials (used by rclone in start-zeroclaw.sh)
  if (env.R2_ACCESS_KEY_ID) envVars.R2_ACCESS_KEY_ID = env.R2_ACCESS_KEY_ID;
  if (env.R2_SECRET_ACCESS_KEY) envVars.R2_SECRET_ACCESS_KEY = env.R2_SECRET_ACCESS_KEY;
  if (env.R2_BUCKET_NAME) envVars.R2_BUCKET_NAME = env.R2_BUCKET_NAME;

  return envVars;
}
