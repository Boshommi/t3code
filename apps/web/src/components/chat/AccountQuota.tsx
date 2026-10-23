import type { ServerProvider } from "@t3tools/contracts";
import {
  formatDuration,
  formatResetsIn,
  quotaAlert,
  quotaAlertLabel,
  remainingPercent,
  tightestLimitWindow,
  type QuotaAlert,
} from "@t3tools/shared/usageLimits";

import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor } from "../usage/UsageLimits";

/** Minute precision is enough for quota, and every reader shares one timer. */
export function useQuotaNow(): number {
  return Date.parse(`${useNowMinute()}Z`);
}

export function accountQuotaAlert(provider: ServerProvider | undefined, now: number) {
  return provider ? quotaAlert(provider.usageLimits, now) : null;
}

/** For tooltips and labels, such as "64% left" or "Back in 3h 5m". */
export function accountQuotaText(provider: ServerProvider | undefined, now: number): string | null {
  const alert = accountQuotaAlert(provider, now);
  if (alert) return quotaAlertLabel(alert, now);
  const tightest = provider ? tightestLimitWindow(provider.usageLimits, now) : null;
  return tightest ? `${tightest.remaining}% left` : null;
}

/** Marks an account icon that is running low or out. Healthy accounts get nothing. */
export function AccountQuotaDot({ alert }: { readonly alert: QuotaAlert }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-1 right-1 z-40 size-1.5 rounded-full",
        alert.level === "empty" ? "bg-destructive" : "bg-warning",
      )}
    />
  );
}

/** Next to the composer's model name, only once the account needs attention. */
export function AccountQuotaPill({
  provider,
  now,
}: {
  readonly provider: ServerProvider | undefined;
  readonly now: number;
}) {
  const alert = accountQuotaAlert(provider, now);
  if (!alert) return null;
  return (
    <Badge variant={alert.level === "empty" ? "error" : "warning"} size="sm">
      {alert.level === "low" ? `${alert.remaining}%` : quotaAlertLabel(alert, now)}
    </Badge>
  );
}

/** One line for the selected account; hovering lists every window. */
export function AccountQuotaFooter({ provider }: { readonly provider: ServerProvider }) {
  const now = useQuotaNow();
  const tightest = tightestLimitWindow(provider.usageLimits, now);
  if (!tightest) return null;
  const alert = quotaAlert(provider.usageLimits, now);
  const resetsIn = tightest.remaining < 100 ? formatResetsIn(tightest.window, now) : null;
  const windows = provider.usageLimits?.windows ?? [];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border/70 px-3 text-xs text-muted-foreground" />
        }
      >
        <span aria-hidden className="block h-1 w-8 shrink-0 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              "block h-full rounded-full",
              alert?.level === "low" && "bg-warning",
              alert?.level === "empty" && "bg-destructive",
            )}
            style={{
              width: `${tightest.remaining}%`,
              ...(alert ? {} : { backgroundColor: barColor(provider.driver) }),
            }}
          />
        </span>
        <span className="min-w-0 truncate">
          <span
            className={cn(
              "tabular-nums text-foreground",
              alert?.level === "low" && "text-warning-foreground",
              alert?.level === "empty" && "text-destructive-foreground",
            )}
          >
            {tightest.remaining}% left
          </span>
          {windows.length > 1 ? ` · ${tightest.window.label}` : ""}
          {resetsIn ? ` · ${resetsIn}` : ""}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <div className="grid grid-cols-[auto_auto_auto] gap-x-3 gap-y-0.5 text-xs">
          {windows.map((window) => {
            const resetsAt =
              window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
            const refilled = Number.isFinite(resetsAt) && resetsAt <= now;
            return (
              <div key={window.id} className="contents">
                <span>{window.label}</span>
                <span className="text-right tabular-nums">
                  {refilled ? 100 : remainingPercent(window)}% left
                </span>
                <span className="text-muted-foreground">
                  {Number.isFinite(resetsAt) && !refilled
                    ? `resets in ${formatDuration(resetsAt - now)}`
                    : ""}
                </span>
              </div>
            );
          })}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
