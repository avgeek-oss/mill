import React, {
  createContext,
  Suspense,
  useContext,
  useDeferredValue,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

type Read<T> = {
  promise: Promise<void>;
  result?: PromiseSettledResult<T>;
  controller: AbortController;
};
type Readiness = {
  committed: boolean;
  reads: Map<string, Read<unknown>>;
};
type Destination = Readiness & {
  location: string;
  scopes: Map<string, Readiness>;
  cancellation?: Promise<never>;
};
type ReadContext = {
  destination: Destination;
  readiness: Readiness;
  scope: string[];
};
const PageReadiness = createContext<ReadContext | null>(null);
const NavigationPending = createContext(false);
const abortReads = (readiness: Readiness) => {
  for (const read of readiness.reads.values()) read.controller.abort();
};
const abortDestination = (destination: Destination) => {
  destination.cancellation ??= new Promise<never>(() => {});
  abortReads(destination);
  for (const scope of destination.scopes.values()) abortReads(scope);
};

/** Keep the committed page mounted until the latest destination is ready. */
export function PageNavigation({
  location,
  children,
  fallback = (
    <span className="sr-only" role="status">
      Loading Mill
    </span>
  ),
}: {
  location: string;
  children: (location: string) => ReactNode;
  fallback?: ReactNode;
}) {
  const destinations = useRef(new Map<string, Destination>());
  let destination = destinations.current.get(location);
  if (!destination) {
    destination = {
      location,
      committed: false,
      reads: new Map(),
      scopes: new Map(),
    };
    destinations.current.set(location, destination);
  }
  const displayed = useDeferredValue(destination);
  useLayoutEffect(() => {
    for (const [location, item] of destinations.current) {
      if (item === displayed || item === destination) continue;
      abortDestination(item);
      destinations.current.delete(location);
    }
  }, [destination, displayed]);
  useLayoutEffect(() => {
    const owned = destinations.current;
    return () => {
      for (const item of owned.values()) abortDestination(item);
    };
  }, []);
  return (
    <NavigationPending.Provider value={destination !== displayed}>
      <Suspense fallback={fallback}>
        <PageContent
          destination={displayed}
          destinations={destinations.current}
        >
          {children(displayed.location)}
        </PageContent>
      </Suspense>
    </NavigationPending.Provider>
  );
}

function PageContent({
  destination,
  destinations,
  children,
}: {
  destination: Destination;
  destinations: Map<string, Destination>;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    destination.committed = true;
    for (const read of destination.reads.values())
      if (!read.result) read.controller.abort();
    for (const [key, scope] of destination.scopes) {
      if (scope.committed) continue;
      abortReads(scope);
      destination.scopes.delete(key);
    }
    for (const [location, item] of destinations) {
      if (item === destination) continue;
      abortDestination(item);
      destinations.delete(location);
    }
  }, [destination, destinations]);
  // A queued retry of an abandoned destination must not commit its old reads.
  if (destination.cancellation) throw destination.cancellation;
  return (
    <PageReadiness.Provider
      value={{ destination, readiness: destination, scope: [] }}
    >
      {children}
    </PageReadiness.Provider>
  );
}

/** Isolate authenticated reads, including identity changes on the same route. */
export function PageReadScope({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}) {
  const parent = useContext(PageReadiness);
  const path = [...(parent?.scope ?? []), scope];
  const key = JSON.stringify(path);
  let readiness = parent?.destination.scopes.get(key);
  if (parent && !readiness) {
    readiness = { committed: false, reads: new Map() };
    parent.destination.scopes.set(key, readiness);
  }
  const destination = parent?.destination;
  useLayoutEffect(() => {
    if (!destination || !readiness) return;
    const owned = readiness;
    destination.scopes.set(key, owned);
    owned.committed = true;
    for (const [scopeKey, previous] of destination.scopes) {
      if (previous.committed) continue;
      abortReads(previous);
      destination.scopes.delete(scopeKey);
    }
    return () => {
      abortReads(owned);
      if (destination.scopes.get(key) === owned) destination.scopes.delete(key);
    };
  }, [destination, readiness, key]);
  if (!parent || !readiness) return children;
  return (
    <PageReadiness.Provider
      value={{ destination: parent.destination, readiness, scope: path }}
    >
      {children}
    </PageReadiness.Provider>
  );
}

export function usePageNavigationPending() {
  return useContext(NavigationPending);
}

/** Prepare initial reads; committed pages retain their own refresh and retry UI. */
export function usePageRead<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
): PromiseSettledResult<T> | undefined {
  const context = useContext(PageReadiness);
  if (!context || key === null) return undefined;
  const { readiness, scope } = context;
  const scopedKey = JSON.stringify([...scope, key]);
  let read = readiness.reads.get(scopedKey) as Read<T> | undefined;
  if (!read && !readiness.committed) {
    const controller = new AbortController();
    read = { controller, promise: Promise.resolve() };
    const pending = read;
    read.promise = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return load(controller.signal);
      })
      .then(
        (value) => {
          pending.result = controller.signal.aborted
            ? { status: "rejected", reason: controller.signal.reason }
            : { status: "fulfilled", value };
        },
        (reason) => {
          pending.result = { status: "rejected", reason };
        },
      );
    readiness.reads.set(scopedKey, read as Read<unknown>);
  }
  if (read && !read.result) throw read.promise;
  return read?.result;
}
