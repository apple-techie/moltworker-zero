import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { getR2BucketName } from '../config';
import { ensureRcloneConfig } from './r2';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

const RCLONE_FLAGS = '--transfers=16 --fast-list --s3-no-check-bucket';
const LAST_SYNC_FILE = '/tmp/.last-sync';

function rcloneRemote(env: MoltbotEnv, prefix: string): string {
  return `r2:${getR2BucketName(env)}/${prefix}`;
}

/**
 * Detect the ZeroClaw config directory in the container.
 */
async function detectConfigDir(sandbox: Sandbox): Promise<string | null> {
  let check: { stdout?: string };
  try {
    check = await sandbox.exec('test -f /root/.zeroclaw/config.toml && echo zeroclaw || echo none');
  } catch {
    return null;
  }
  const result = check.stdout?.trim();
  if (result === 'zeroclaw') return '/root/.zeroclaw';
  return null;
}

/**
 * Sync ZeroClaw config and workspace from container to R2 for persistence.
 * Uses rclone for direct S3 API access (no FUSE mount overhead).
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  const rcloneOk = await ensureRcloneConfig(sandbox, env);
  console.log('[syncToR2] ensureRcloneConfig:', rcloneOk);
  if (!rcloneOk) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  const configDir = await detectConfigDir(sandbox);
  console.log('[syncToR2] detectConfigDir:', configDir);
  if (!configDir) {
    return {
      success: false,
      error: 'Sync aborted: no config file found',
      details: 'config.toml not found in /root/.zeroclaw/',
    };
  }

  const remote = (prefix: string) => rcloneRemote(env, prefix);

  // Checkpoint SQLite WALs before syncing to ensure consistent DB snapshots.
  // Without this, rclone copying a live SQLite file can produce a corrupt backup.
  const dbCheckResult = await sandbox.exec(
    `find ${configDir} -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" 2>/dev/null`,
  );
  const dbFiles = (dbCheckResult.stdout || '').trim().split('\n').filter(Boolean);
  console.log('[syncToR2] SQLite DB files found:', dbFiles);
  for (const dbFile of dbFiles) {
    await sandbox.exec(`sqlite3 '${dbFile}' "PRAGMA wal_checkpoint(FULL);" 2>/dev/null || true`);
  }

  // Sync config (rclone sync propagates deletions)
  const configResult = await sandbox.exec(
    `rclone sync ${configDir}/ ${remote('zeroclaw/')} ${RCLONE_FLAGS} --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' --exclude='.git/**'`,
    { timeout: 120000 },
  );
  if (!configResult.success) {
    console.error('[syncToR2] rclone sync failed:', configResult.stderr?.slice(-500));
    return {
      success: false,
      error: 'Config sync failed',
      details: configResult.stderr?.slice(-500),
    };
  }

  // Sync workspace (non-fatal, rclone sync propagates deletions)
  await sandbox.exec(
    `test -d /root/clawd && rclone sync /root/clawd/ ${remote('workspace/')} ${RCLONE_FLAGS} --exclude='skills/**' --exclude='.git/**' || true`,
    { timeout: 120000 },
  );

  // Sync skills (non-fatal)
  await sandbox.exec(
    `test -d /root/clawd/skills && rclone sync /root/clawd/skills/ ${remote('skills/')} ${RCLONE_FLAGS} || true`,
    { timeout: 120000 },
  );

  // Write timestamp
  await sandbox.exec(`date -Iseconds > ${LAST_SYNC_FILE}`);
  const tsResult = await sandbox.exec(`cat ${LAST_SYNC_FILE}`);
  const lastSync = tsResult.stdout?.trim();

  return { success: true, lastSync };
}
