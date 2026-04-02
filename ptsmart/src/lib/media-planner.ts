/**
 * Sistema de Cache para Agregações
 * Evita re-computação de agregações custosas em 400k+ linhas
 * Padrão: Memoization com invalidação por timestamp
 */

// ── Type Definitions ──────────────────────────────────────────────────────

export interface AggregationCacheEntry {
  data: Map<string, any>;           // Agregações por key (campanha/curso)
  options: Map<string, Set<string>>; // Opções de filtro por field
  dateRange: [string, string] | null; // [minDate, maxDate]
  timestamp: number;                 // Quando foi computado
  rawDataHash: number;               // Hash dos dados brutos para invalidação
}

interface CacheConfig {
  maxAge?: number; // Tempo máximo de cache em ms (default: 5 min)
  enabled?: boolean; // Se cache está habilitado (default: true)
}

// ── Hash Function ─────────────────────────────────────────────────────────

/**
 * Computa um hash rápido (não criptográfico) dos dados
 * Usado para detectar mudanças nos dados brutos
 */
function computeDataHash(data: any[], sampleSize: number = 100): number {
  if (!data.length) return 0;
  
  // Amostra dados para fazer hash rápido
  const step = Math.max(1, Math.floor(data.length / sampleSize));
  let hash = 0;
  
  for (let i = 0; i < data.length; i += step) {
    const item = data[i];
    const str = JSON.stringify(item).substring(0, 100);
    
    for (let j = 0; j < str.length; j++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(j);
      hash = hash & hash; // Convert to 32bit integer
    }
  }
  
  return hash >>> 0; // Unsigned
}

// ── Cache Storage ────────────────────────────────────────────────────────

class AggregationCacheStore {
  private cache = new Map<string, AggregationCacheEntry>();
  private config: Required<CacheConfig>;

  constructor(config: CacheConfig = {}) {
    this.config = {
      maxAge: config.maxAge ?? 5 * 60 * 1000, // 5 min default
      enabled: config.enabled ?? true,
    };
  }

  /**
   * Get cached aggregation
   */
  get<T>(key: string): T | null {
    if (!this.config.enabled) return null;

    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check if expired
    const age = Date.now() - entry.timestamp;
    if (age > this.config.maxAge) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as any as T;
  }

  /**
   * Get cached options
   */
  getOptions(key: string): Map<string, Set<string>> | null {
    if (!this.config.enabled) return null;

    const entry = this.cache.get(key);
    return entry?.options ?? null;
  }

  /**
   * Get cached date range
   */
  getDateRange(key: string): [string, string] | null {
    if (!this.config.enabled) return null;

    const entry = this.cache.get(key);
    return entry?.dateRange ?? null;
  }

  /**
   * Store aggregation in cache
   */
  set(
    key: string,
    aggData: Map<string, any>,
    options: Map<string, Set<string>>,
    dateRange: [string, string] | null,
    rawDataHash: number
  ): void {
    if (!this.config.enabled) return;

    this.cache.set(key, {
      data: aggData,
      options,
      dateRange,
      timestamp: Date.now(),
      rawDataHash,
    });
  }

  /**
   * Check if cache is still valid for given data hash
   */
  isValid(key: string, currentDataHash: number): boolean {
    if (!this.config.enabled) return false;

    const entry = this.cache.get(key);
    if (!entry) return false;

    // Hash mismatch = data changed = invalidate
    if (entry.rawDataHash !== currentDataHash) {
      this.cache.delete(key);
      return false;
    }

    // Check age
    const age = Date.now() - entry.timestamp;
    if (age > this.config.maxAge) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache stats for debugging
   */
  getStats() {
    return {
      entries: this.cache.size,
      config: this.config,
    };
  }
}

// ── Global Cache Instances ────────────────────────────────────────────────

export const campaignCache = new AggregationCacheStore();
export const courseCache = new AggregationCacheStore();

// ── Helper Functions ─────────────────────────────────────────────────────

/**
 * Build cache key from filter params
 * Exemplo: "campaigns::2024-01-01::2024-12-31::all::produto1"
 */
export function buildCacheKey(
  prefix: string,
  filters: Record<string, any>
): string {
  const values = Object.values(filters)
    .map(v => String(v || 'null'))
    .join('::');
  
  return `${prefix}::${values}`;
}

/**
 * Compute hash from raw data
 */
export function getDataHash(data: any[]): number {
  return computeDataHash(data);
}

/**
 * Reset all caches (útil após upload de novos dados)
 */
export function resetAllCaches(): void {
  campaignCache.clear();
  courseCache.clear();
  console.log('🗑️ All aggregation caches cleared');
}

// ── Reactive Cache Hook ───────────────────────────────────────────────────

import { useEffect, useRef } from 'react';

export function useCacheInvalidation(data: any[], cacheInstance: AggregationCacheStore) {
  const dataHashRef = useRef<number | null>(null);

  useEffect(() => {
    const newHash = getDataHash(data);

    // Se hash mudou, clear cache
    if (dataHashRef.current !== null && dataHashRef.current !== newHash) {
      cacheInstance.clear();
    }

    dataHashRef.current = newHash;
  }, [data, cacheInstance]);
}
