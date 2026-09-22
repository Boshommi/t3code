import type { DesktopPortForward, EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftRight, ExternalLink } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import {
  closePortForwardsDialog,
  forwardedUrl,
  forwardPort,
  openPortForwardsDialog,
  stopPortForward,
  useEnvironmentPortForwards,
  usePortForwardsDialogStore,
} from "~/browser/portForwards";
import { ensureLocalApi } from "~/localApi";
import { useDiscoveredPortsState } from "~/portDiscoveryState";
import { useEnvironment } from "~/state/environments";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DiscoveryList } from "../ui/discovery-list";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const parsePort = (value: string): number | null => {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65_535 ? port : null;
};

/** Mounted once at the app root; shows the ports of whichever environment asked. */
export function PortForwardsDialogHost() {
  const environmentId = usePortForwardsDialogStore((state) => state.environmentId);
  if (environmentId === null) return null;
  return <PortForwardsDialog environmentId={environmentId} />;
}

function PortForwardsDialog({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environmentLabel = useEnvironment(environmentId)?.label ?? "the remote environment";
  const forwards = useEnvironmentPortForwards(environmentId);
  const { servers } = useDiscoveredPortsState(environmentId);
  const [draft, setDraft] = useState("");
  const [pendingPort, setPendingPort] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const detected = useMemo(() => {
    const forwarded = new Set(forwards.map((forward) => forward.remotePort));
    const seen = new Set<number>();
    return servers.filter((server) => {
      if (forwarded.has(server.port) || seen.has(server.port)) return false;
      seen.add(server.port);
      return true;
    });
  }, [forwards, servers]);

  const draftPort = parsePort(draft);

  const start = async (port: number) => {
    setPendingPort(port);
    setError(null);
    try {
      await forwardPort(environmentId, port);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The port could not be forwarded.");
    } finally {
      setPendingPort(null);
    }
  };

  const open = (forward: DesktopPortForward) => {
    void ensureLocalApi()
      .shell.openExternal(forwardedUrl(forward))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "The browser could not be opened.");
      });
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closePortForwardsDialog();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Forwarded ports</DialogTitle>
          <DialogDescription>
            Reach ports on {environmentLabel} at localhost on this computer, from any browser.
            Forward every port a page loads from, such as an auth iframe on another port.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (draftPort !== null) void start(draftPort);
            }}
          >
            <Input
              autoFocus
              inputMode="numeric"
              placeholder="Port, e.g. 5173"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={draftPort === null || pendingPort !== null}>
              Forward
            </Button>
          </form>
          {error ? <p className="text-destructive text-xs">{error}</p> : null}

          {forwards.length > 0 ? (
            <PortSection title="Forwarded">
              {forwards.map((forward) => (
                <PortRow
                  key={forward.remotePort}
                  title={`localhost:${String(forward.localPort)}`}
                  description={
                    forward.localPort === forward.remotePort
                      ? `Remote port ${String(forward.remotePort)}`
                      : `Remote port ${String(forward.remotePort)}, which is in use on this computer`
                  }
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Open in system browser"
                    onClick={() => open(forward)}
                  >
                    <ExternalLink />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => void stopPortForward(forward).catch(() => undefined)}
                  >
                    Stop
                  </Button>
                </PortRow>
              ))}
            </PortSection>
          ) : null}

          {detected.length > 0 ? (
            <PortSection title={`Listening on ${environmentLabel}`}>
              {detected.map((server) => (
                <PortRow
                  key={server.port}
                  title={`Port ${String(server.port)}`}
                  description={server.processName ?? server.host}
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={pendingPort !== null}
                    onClick={() => void start(server.port)}
                  >
                    Forward
                  </Button>
                </PortRow>
              ))}
            </PortSection>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function PortSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
      <DiscoveryList>{children}</DiscoveryList>
    </section>
  );
}

function PortRow({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-foreground text-sm">{title}</span>
        <span className="truncate text-muted-foreground text-xs">{description}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

/**
 * Composer-strip reminder that this remote has ports forwarded. Forwards
 * belong to the environment, so every thread on it shows the same chip.
 */
export function PortForwardsChip({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const forwards = useEnvironmentPortForwards(environmentId);
  if (forwards.length === 0) return null;
  const ports = forwards
    .map((forward) => forward.remotePort)
    .toSorted((left, right) => left - right)
    .join(", ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-composer-context-control
            className="min-w-0 shrink-0 font-normal text-muted-foreground/70 text-xs!"
            aria-label={`Forwarded ports: ${ports}`}
            onClick={() => openPortForwardsDialog(environmentId)}
          />
        }
      >
        <ArrowLeftRight className="size-3" />
        <span className="truncate">{ports}</span>
      </TooltipTrigger>
      <TooltipPopup>Forwarded to localhost on this computer</TooltipPopup>
    </Tooltip>
  );
}
