import { Skeleton } from "@mill/web-design-system";

// Adapted from Towbar's Apache-2.0 QueryLoading composition.
export function QueryLoading({
  label = "Loading…",
  variant = "detail",
}: {
  label?: string;
  variant?: "detail" | "list";
}) {
  return (
    <div className="grid gap-3" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      {variant === "list" ? (
        Array.from({ length: 4 }, (_, index) => (
          <Skeleton
            aria-hidden="true"
            className="h-20 w-full rounded-2xl"
            key={index}
          />
        ))
      ) : (
        <>
          <Skeleton aria-hidden="true" className="h-40 w-full rounded-2xl" />
          <Skeleton aria-hidden="true" className="h-64 w-full rounded-2xl" />
        </>
      )}
    </div>
  );
}
