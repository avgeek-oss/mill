// Adapted from Towbar's Apache-2.0 QueryLoading composition; see NOTICE.
export function QueryLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <span className="sr-only" role="status">
      {label}
    </span>
  );
}
