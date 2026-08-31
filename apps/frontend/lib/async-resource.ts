'use client';

import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

/**
 * One fetch, four states: loading, error, empty and populated are explicit.
 *
 * The discriminated union prevents an error from being mistaken for an empty
 * response. `null` and `undefined` mean empty for singular resources; callers
 * fetching collections can use `useCollectionResource`, where `[]` is empty.
 */
export type ResourceSnapshot<T> =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'empty' }
  | { status: 'populated'; data: T };

export type AsyncResource<T> = ResourceSnapshot<T> & {
  /** Re-runs the fetch. Wire it to ErrorState's retry. */
  retry: () => void;
};

export function useResource<T>(
  fetcher: () => Promise<T | null | undefined>,
  deps: DependencyList,
  isEmpty: (data: T) => boolean = () => false,
): AsyncResource<T> {
  const [state, setState] = useState<ResourceSnapshot<T>>({ status: 'loading' });
  const sequence = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The caller owns the dependency list because the fetcher is usually a
  // render-local closure. Only the newest request may write its result.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    const ticket = ++sequence.current;
    setState({ status: 'loading' });

    fetcher().then(
      (data) => {
        if (!alive.current || ticket !== sequence.current) return;
        setState(data == null || isEmpty(data) ? { status: 'empty' } : { status: 'populated', data });
      },
      (error) => {
        if (!alive.current || ticket !== sequence.current) return;
        setState({ status: 'error', error });
      },
    );
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  return { ...state, retry: run };
}

/** Collections use [] as an explicit empty result, never as populated data. */
export function useCollectionResource<T>(
  fetcher: () => Promise<readonly T[]>,
  deps: DependencyList,
): AsyncResource<readonly T[]> {
  return useResource(fetcher, deps, (items) => items.length === 0);
}

/** Backwards-compatible name for callers migrating to the four-state contract. */
export const useAsyncResource = useResource;
