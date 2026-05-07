import type { Sql } from 'postgres';
import { debug } from './util.js';

export interface RunUpdateNotification {
  runId: string;
  status: string;
  updatedAt: string;
}

export type RunUpdateListener = (notification: RunUpdateNotification) => void;

const RUN_UPDATE_CHANNEL = 'workflow_run_update';

/**
 * Subscribe to real-time run status updates via PostgreSQL LISTEN/NOTIFY.
 *
 * The trigger `runs_notify_update` (installed by migration 0002) fires
 * on every INSERT or UPDATE to `workflow_runs`, publishing a JSON payload
 * with `{ runId, status, updatedAt }`.
 *
 * @param postgres - The postgres.js connection instance
 * @returns An object with `subscribe` and `unsubscribe` methods
 */
export function createRunUpdateSubscriber(postgres: Sql) {
  const listeners = new Set<RunUpdateListener>();
  let listening = false;

  async function ensureListening(): Promise<void> {
    if (listening) return;
    listening = true;

    postgres
      .listen(RUN_UPDATE_CHANNEL, (payload) => {
        try {
          const data = JSON.parse(payload) as RunUpdateNotification;
          for (const listener of listeners) {
            try {
              listener(data);
            } catch (err) {
              debug('Run update listener error:', err);
            }
          }
        } catch (err) {
          debug('Failed to parse run update notification:', err);
        }
      })
      .catch((err) => {
        debug('Failed to LISTEN on', RUN_UPDATE_CHANNEL, err);
        listening = false;
      });
  }

  return {
    /**
     * Subscribe to run update notifications.
     * @returns An unsubscribe function.
     */
    subscribe(listener: RunUpdateListener): () => void {
      listeners.add(listener);
      ensureListening();
      return () => {
        listeners.delete(listener);
      };
    },

    /** Number of active listeners. */
    get listenerCount() {
      return listeners.size;
    },
  };
}
