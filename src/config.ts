/**
 * Configuration constants for Moltbot Sandbox
 */

/** Port that the ZeroClaw gateway listens on inside the container */
export const MOLTBOT_PORT = 18789;

/** Port that camofox-browser listens on inside its container */
export const CAMOFOX_PORT = 9377;

/** Maximum time to wait for Moltbot to start (3 minutes) */
export const STARTUP_TIMEOUT_MS = 180_000;

/**
 * R2 bucket name for persistent storage.
 * Can be overridden via R2_BUCKET_NAME env var for test isolation.
 */
export function getR2BucketName(env?: { R2_BUCKET_NAME?: string }): string {
  return env?.R2_BUCKET_NAME || 'moltbot-data';
}
