import { useState, useEffect, useCallback, useRef } from 'react';
import {
  listDevices,
  restartGateway,
  getStorageStatus,
  triggerSync,
  getProcessLogs,
  AuthError,
  type PendingDevice,
  type PairedDevice,
  type DeviceListResponse,
  type StorageStatusResponse,
} from '../api';
import './AdminPage.css';

// Small inline spinner for buttons
function ButtonSpinner() {
  return <span className="btn-spinner" />;
}

function formatSyncTime(isoString: string | null) {
  if (!isoString) return 'Never';
  try {
    const date = new Date(isoString);
    return date.toLocaleString();
  } catch {
    return isoString;
  }
}

// Strip ANSI escape codes (ZeroClaw uses colored output)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

function LogConsole() {
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const lastLenRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (!pausedRef.current) {
        try {
          const data = await getProcessLogs();
          const raw = stripAnsi(data.stdout || '');
          if (raw.length > lastLenRef.current) {
            const newContent = raw.slice(lastLenRef.current);
            lastLenRef.current = raw.length;
            const newLines = newContent.split('\n').filter((l) => l.trim().length > 0);
            setLines((prev) => [...prev, ...newLines].slice(-500));
            setLogError(null);
          }
        } catch (err) {
          setLogError(err instanceof Error ? err.message : 'Failed to fetch logs');
        }
      }
      timer = setTimeout(poll, 2000);
    };

    poll();
    return () => clearTimeout(timer);
  }, []);

  // Auto-scroll when not paused
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, paused]);

  const handleClear = () => {
    setLines([]);
    lastLenRef.current = 0;
  };

  return (
    <section className="devices-section log-console-section">
      <div className="section-header">
        <h2>Container Logs</h2>
        <div className="header-actions">
          <button className="btn btn-secondary btn-sm" onClick={handleClear}>
            Clear
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setPaused((p) => !p)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>
      {logError && <p className="log-error">{logError}</p>}
      <div className="log-console" ref={scrollRef}>
        {lines.length === 0 ? (
          <span className="log-empty">Waiting for logs…</span>
        ) : (
          lines.map((line, i) => (
            <div key={`${i}-${line}`} className="log-line">
              {line}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export default function AdminPage() {
  const [_pending, setPending] = useState<PendingDevice[]>([]);
  const [_paired, setPaired] = useState<PairedDevice[]>([]);
  const [storageStatus, setStorageStatus] = useState<StorageStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartInProgress, setRestartInProgress] = useState(false);
  const [syncInProgress, setSyncInProgress] = useState(false);

  const fetchDevices = useCallback(async () => {
    try {
      setError(null);
      const data: DeviceListResponse = await listDevices();
      setPending(data.pending || []);
      setPaired(data.paired || []);

      if (data.error) {
        setError(data.error);
      } else if (data.parseError) {
        setError(`Parse error: ${data.parseError}`);
      }
    } catch (err) {
      if (err instanceof AuthError) {
        setError('Authentication required. Please log in via Cloudflare Access.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to fetch devices');
      }
    }
  }, []);

  const fetchStorageStatus = useCallback(async () => {
    try {
      const status = await getStorageStatus();
      setStorageStatus(status);
    } catch (err) {
      // Don't show error for storage status - it's not critical
      console.error('Failed to fetch storage status:', err);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
    fetchStorageStatus();
  }, [fetchDevices, fetchStorageStatus]);

  const handleRestartGateway = async () => {
    if (
      !confirm(
        'Are you sure you want to restart the gateway? This will disconnect all clients temporarily.',
      )
    ) {
      return;
    }

    setRestartInProgress(true);
    try {
      const result = await restartGateway();
      if (result.success) {
        setError(null);
        // Show success message briefly
        alert('Gateway restart initiated. Clients will reconnect automatically.');
      } else {
        setError(result.error || 'Failed to restart gateway');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart gateway');
    } finally {
      setRestartInProgress(false);
    }
  };

  const handleSync = async () => {
    setSyncInProgress(true);
    try {
      const result = await triggerSync();
      if (result.success) {
        // Update the storage status with new lastSync time
        setStorageStatus((prev) => (prev ? { ...prev, lastSync: result.lastSync || null } : null));
        setError(null);
      } else {
        setError(result.error || 'Sync failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync');
    } finally {
      setSyncInProgress(false);
    }
  };

  return (
    <div className="devices-page">
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="dismiss-btn">
            Dismiss
          </button>
        </div>
      )}

      {storageStatus && !storageStatus.configured && (
        <div className="warning-banner">
          <div className="warning-content">
            <strong>R2 Storage Not Configured</strong>
            <p>
              Paired devices and conversations will be lost when the container restarts. To enable
              persistent storage, configure R2 credentials. See the{' '}
              <a
                href="https://github.com/cloudflare/moltworker-zero"
                target="_blank"
                rel="noopener noreferrer"
              >
                README
              </a>{' '}
              for setup instructions.
            </p>
            {storageStatus.missing && (
              <p className="missing-secrets">Missing: {storageStatus.missing.join(', ')}</p>
            )}
          </div>
        </div>
      )}

      {storageStatus?.configured && (
        <div className="success-banner">
          <div className="storage-status">
            <div className="storage-info">
              <span>
                R2 storage is configured. Your data will persist across container restarts.
              </span>
              <span className="last-sync">
                Last backup: {formatSyncTime(storageStatus.lastSync)}
              </span>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleSync}
              disabled={syncInProgress}
            >
              {syncInProgress && <ButtonSpinner />}
              {syncInProgress ? 'Syncing...' : 'Backup Now'}
            </button>
          </div>
        </div>
      )}

      <section className="devices-section gateway-section">
        <div className="section-header">
          <h2>Gateway Controls</h2>
          <button
            className="btn btn-danger"
            onClick={handleRestartGateway}
            disabled={restartInProgress}
          >
            {restartInProgress && <ButtonSpinner />}
            {restartInProgress ? 'Restarting...' : 'Restart Gateway'}
          </button>
        </div>
        <p className="hint">
          Restart the gateway to apply configuration changes or recover from errors. All connected
          clients will be temporarily disconnected.
        </p>
      </section>

      <LogConsole />
    </div>
  );
}
