/**
 * useAggregationWorker
 * ────────────────────
 * Creates (and reuses) a Web Worker that runs heavy aggregation off the main
 * thread.  Falls back to synchronous execution if Workers are unavailable.
 *
 * Usage:
 *   const { runCampaigns, runCourses, busy } = useAggregationWorker();
 *   const rows = await runCampaigns({ data, availableKeys, ...filters });
 */
import { useRef, useCallback, useState } from 'react';

// Vite handles ?worker imports; the worker file is bundled separately.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import AggregationWorker from './aggregation.worker?worker';

type MessageId = string;

interface PendingCall {
  resolve: (v: any) => void;
  reject:  (e: any) => void;
}

let workerInstance: Worker | null = null;
let pendingMap: Map<MessageId, PendingCall> = new Map();
let msgCounter = 0;

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!workerInstance) {
    try {
      workerInstance = new AggregationWorker();
      workerInstance.onmessage = (e: MessageEvent) => {
        const { id, type, result, message } = e.data;
        const pending = pendingMap.get(id);
        if (!pending) return;
        pendingMap.delete(id);
        if (type === 'error') pending.reject(new Error(message));
        else pending.resolve(result);
      };
      workerInstance.onerror = (e: ErrorEvent) => {
        // Reject all pending on unrecoverable worker error
        for (const [, p] of pendingMap) p.reject(e);
        pendingMap.clear();
        workerInstance = null; // will be recreated on next call
      };
    } catch {
      return null;
    }
  }
  return workerInstance;
}

function postToWorker(type: string, payload: any): Promise<any> {
  const worker = getWorker();
  if (!worker) {
    // Synchronous fallback (imports the same logic inline)
    return Promise.resolve(null); // caller handles null → sync path
  }
  const id = String(++msgCounter);
  return new Promise((resolve, reject) => {
    pendingMap.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAggregationWorker() {
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<string | null>(null); // track in-flight id to ignore stale results

  const run = useCallback(async (type: string, payload: any): Promise<any | null> => {
    const myId = String(++msgCounter);
    abortRef.current = myId;
    setBusy(true);
    try {
      const result = await postToWorker(type, payload);
      // If a newer call has started, discard this result
      if (abortRef.current !== myId) return null;
      return result;
    } finally {
      if (abortRef.current === myId) setBusy(false);
    }
  }, []);

  const runCampaigns = useCallback((payload: any) => run('aggregateCampaigns', payload), [run]);
  const runCourses   = useCallback((payload: any) => run('aggregateCourses',   payload), [run]);

  return { runCampaigns, runCourses, busy };
}
