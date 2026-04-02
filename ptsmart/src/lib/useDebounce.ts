import { useEffect, useState } from 'react';

/**
 * Hook para debounce de valores
 * Útil para reduzir chamadas de funções pesadas (agregações, filtros, etc)
 * @param value - Valor a ser debounceado
 * @param delay - Delay em ms (padrão: 300ms)
 * @returns Valor debounceado
 */
export function useDebounce<T>(value: T, delay: number = 300): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
}

/**
 * Hook para debounce de múltiplos valores simultaneamente
 * @param values - Objeto com valores a serem debounceados
 * @param delay - Delay em ms (padrão: 300ms)
 * @returns Objeto com valores debounceados
 */
export function useDebouncedValues<T extends Record<string, any>>(
  values: T,
  delay: number = 300
): T {
  const [debouncedValues, setDebouncedValues] = useState<T>(values);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValues(values);
    }, delay);

    return () => clearTimeout(handler);
  }, [values, delay]);

  return debouncedValues;
}
