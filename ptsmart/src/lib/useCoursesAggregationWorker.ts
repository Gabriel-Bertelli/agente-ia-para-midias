import { useEffect, useRef, useCallback, useState } from 'react';

/**
 * Hook para usar Web Worker para agregação de cursos
 * Processa em thread paralela, não bloqueia UI
 */

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: NodeJS.Timeout;
}

export function useCoursesAggregationWorker() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<string, PendingRequest>>(new Map());
  const [workerReady, setWorkerReady] = useState(false);

  // Initialize worker
  useEffect(() => {
    try {
      // Vite dynamic imports: ?worker inline para web workers
      workerRef.current = new Worker(
        new URL('../workers/coursesAggregationWorker.ts', import.meta.url),
        { type: 'module' }
      );

      const handleMessage = (event: MessageEvent) => {
        const { id, type, result, duration, message } = event.data;
        const pending = pendingRef.current.get(id);

        if (!pending) return; // Request timeout ou unknown

        clearTimeout(pending.timeout);
        pendingRef.current.delete(id);

        if (type === 'aggregate-courses-result') {
          console.log(`✅ Worker aggregation completed in ${duration.toFixed(0)}ms`);
          pending.resolve(result);
        } else if (type === 'error') {
          pending.reject(new Error(message));
        }
      };

      const handleError = (error: ErrorEvent) => {
        console.error('❌ Worker error:', error.message);
        // Clear all pending requests
        pendingRef.current.forEach(({ reject, timeout }) => {
          clearTimeout(timeout);
          reject(new Error(`Worker error: ${error.message}`));
        });
        pendingRef.current.clear();
      };

      workerRef.current.addEventListener('message', handleMessage);
      workerRef.current.addEventListener('error', handleError);
      setWorkerReady(true);

      console.log('✨ Courses aggregation worker initialized');

      return () => {
        if (workerRef.current) {
          workerRef.current.removeEventListener('message', handleMessage);
          workerRef.current.removeEventListener('error', handleError);
          workerRef.current.terminate();
        }
      };
    } catch (error) {
      console.warn('⚠️ Worker initialization failed, will use main thread:', error);
      setWorkerReady(false);
    }
  }, []);

  /**
   * Send aggregation request to worker
   * Falls back to main thread if worker unavailable
   */
  const aggregate = useCallback(
    (
      data: any[],
      availableKeys: string[],
      opts: { start: string; end: string; tipoCampanha: string },
      fallbackFn: () => any[] // Fallback aggregation function
    ): Promise<any[]> => {
      return new Promise((resolve, reject) => {
        // If worker not ready, use fallback
        if (!workerReady || !workerRef.current) {
          console.log('⚠️ Using main thread fallback for aggregation');
          try {
            const result = fallbackFn();
            resolve(result);
          } catch (error) {
            reject(error);
          }
          return;
        }

        const id = `${Date.now()}-${Math.random()}`;
        const timeout = setTimeout(() => {
          pendingRef.current.delete(id);
          reject(new Error('Worker request timeout (60s)'));
        }, 60000); // 60 second timeout

        pendingRef.current.set(id, { resolve, reject, timeout });

        try {
          workerRef.current!.postMessage({
            id,
            type: 'aggregate-courses',
            data,
            availableKeys,
            opts,
          });
        } catch (error) {
          clearTimeout(timeout);
          pendingRef.current.delete(id);
          reject(error);
        }
      });
    },
    [workerReady]
  );

  return { aggregate, workerReady };
}
