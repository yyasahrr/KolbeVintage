import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";

type State<T> = { data: T | null; loading: boolean; error: string | null; empty: boolean };
export function useFetch<T>(fetcher: () => Promise<T>, deps: unknown[] = []): State<T> & { reload: () => void; setData: (v: T | null) => void } {
  const [state, setState] = useState<State<T>>({ data: null, loading: true, error: null, empty: false });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetcherRef.current();
      const empty = data === null || (Array.isArray((data as unknown as { items?: unknown[] })?.items) && ((data as unknown as { items: unknown[] }).items.length === 0));
      setState({ data, loading: false, error: null, empty: !!empty });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "خطای شبکه";
      setState({ data: null, loading: false, error: msg, empty: false });
    }
  }, []);
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ...state, reload: load, setData: (v) => setState((s) => ({ ...s, data: v })) };
}

export function Loading(_props: { label?: string }) {
  return null as unknown as React.ReactElement;
}
