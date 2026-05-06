import { useEffect, useState } from "react";

/**
 * Returns `value` delayed by `delay` ms. While the user is still typing the
 * returned value lags behind, so consumers like SWR don't fire a fetch on
 * every keystroke. Default 300ms is the common "snappy but not noisy" point.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
