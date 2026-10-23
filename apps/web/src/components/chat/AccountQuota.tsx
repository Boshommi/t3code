import type { ServerProvider } from "@t3tools/contracts";
import { formatDuration, remainingPercent, tightestLimitWindow } from "@t3tools/shared/usageLimits";

import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { barColor } from "../usage/UsageLimits";

/** Minute precision is enough for quota, and every reader shares one timer. */
export function useQuotaNow(): number {
  return Date.parse(`${useNowMinute()}Z`);
}

export function accountQuota(provider: ServerProvider | undefined, now: number) {
  return provider ? tightestLimitWindow(provider.usageLimits, now) : null;
}

export function accountQuotaLabel(
  provider: ServerProvider | undefined,
  now: number,
): string | null {
  const quota = accountQuota(provider, now);
  return quota ? `${quota.remaining}% left` : null;
}

/** A thin bar of what the account's tightest window has left. */
export function AccountQuotaBar({
  provider,
  now,
  className,
}: {
  readonly provider: ServerProvider;
  readonly now: number;
  readonly className?: string;
}) {
  const quota = accountQuota(provider, now);
  if (!quota) return null;
  return (
    <span
      aria-hidden
      className={cn("block h-0.5 overflow-hidden rounded-full bg-muted", className)}
    >
      <span
        className="block h-full rounded-full"
        style={{ width: `${quota.remaining}%`, backgroundColor: barColor(provider.driver) }}
      />
    </span>
  );
}

/** Every window on one line, such as "Session 43% · 3h 27m". */
export function AccountQuotaSummary({ provider }: { readonly provider: ServerProvider }) {
  const now = useQuotaNow();
  if (!accountQuota(provider, now)) return null;
  return (
    <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-0.5 px-3 pt-1.5 pb-0.5 text-xs text-muted-foreground">
      {provider.usageLimits?.windows.map((window) => {
        const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
        const refilled = Number.isFinite(resetsAt) && resetsAt <= now;
        const remaining = refilled ? 100 : remainingPercent(window);
        return (
          <span key={window.id} className="whitespace-nowrap">
            {window.label}{" "}
            <span
              className={cn(
                "tabular-nums text-foreground",
                remaining <= 10 && "text-warning-foreground",
              )}
            >
              {remaining}%
            </span>
            {Number.isFinite(resetsAt) && !refilled ? ` · ${formatDuration(resetsAt - now)}` : ""}
          </span>
        );
      })}
    </div>
  );
}
