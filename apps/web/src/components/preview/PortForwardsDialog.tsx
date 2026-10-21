import type { DesktopPortForward, EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftRightIcon, ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  closePortForwardsDialog,
  forwardPort,
  openPortForwardsDialog,
  openUrlInSystemBrowser,
  stopPortForward,
  useCanForwardPorts,
  useEnvironmentPortForwards,
  usePortForwardsDialogStore,
} from "~/browser/portForwards";
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
import { DiscoveryList, DiscoveryListRow } from "../ui/discovery-list";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const parsePort = (value: string): number | null => {
  const trimmed = value.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65_535 ? port : null;
};

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

/** Mounted once at the app root; shows the ports of whichever environment asked. */
export function PortForwardsDialogHost() {
  const environmentId = usePortForwardsDialogStore((state) => state.environmentId);
  return environmentId === null ? null : <PortForwardsDialog environmentId={environmentId} />;
}

function PortForwardsDialog({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environmentLabel = useEnvironment(environmentId)?.label ?? "the environment";
  const forwards = useEnvironmentPortForwards(environmentId);
  const { servers } = useDiscoveredPortsState(environmentId);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forwarded = new Set(forwards.map((forward) => forward.remotePort));
  const listening = servers.filter(
    (server, index) =>
      !forwarded.has(server.port) &&
      servers.findIndex((other) => other.port === server.port) === index,
  );
  const draftPort = parsePort(draft);

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setPending(true);
    setError(null);
    // No `finally`: the React Compiler cannot compile it.
    const ok = await action().then(
      () => true,
      (cause: unknown) => {
        setError(errorMessage(cause, fallback));
        return false;
      },
    );
    setPending(false);
    return ok;
  };
  const start = (port: number) =>
    run(() => forwardPort(environmentId, port), "The port could not be forwarded.");
  const open = (forward: DesktopPortForward) =>
    void run(
      () => openUrlInSystemBrowser(environmentId, `http://localhost:${forward.remotePort}/`),
      "The browser could not be opened.",
    );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closePortForwardsDialog();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Forwarded ports</DialogTitle>
          <DialogDescription>
            Reach servers on {environmentLabel} at localhost on this computer, from the browser here
            or any other. A page that loads from several ports needs each of them.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (draftPort === null) return;
                void start(draftPort).then((started) => {
                  if (started) setDraft("");
                });
              }}
            >
              <Input
                autoFocus
                aria-label="Remote port"
                inputMode="numeric"
                placeholder="Port, such as 5173"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button type="submit" disabled={draftPort === null || pending}>
                Forward
              </Button>
            </form>
            {error ? (
              <p role="alert" className="text-destructive text-xs">
                {error}
              </p>
            ) : null}
            {forwards.length > 0 ? (
              <PortSection title="Forwarded">
                {forwards.map((forward) => (
                  <div key={forward.remotePort} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium text-foreground text-sm">
                        localhost:{forward.localPort}
                      </span>
                      <span className="truncate text-muted-foreground text-xs">
                        {forward.localPort === forward.remotePort
                          ? `Port ${forward.remotePort} on ${environmentLabel}`
                          : `Port ${forward.remotePort} on ${environmentLabel}, in use on this computer`}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Open localhost:${forward.localPort} in the system browser`}
                      onClick={() => open(forward)}
                    >
                      <ExternalLinkIcon />
                    </Button>
                    <Button
                      variant="outline"
                      size="compact"
                      onClick={() =>
                        void run(
                          () => stopPortForward(forward),
                          "The forward could not be stopped.",
                        )
                      }
                    >
                      Stop
                    </Button>
                  </div>
                ))}
              </PortSection>
            ) : null}
            {listening.length > 0 ? (
              <PortSection title={`Listening on ${environmentLabel}`}>
                {listening.map((server) => (
                  <DiscoveryListRow
                    key={server.port}
                    disabled={pending}
                    onClick={() => void start(server.port)}
                    icon={<ArrowLeftRightIcon className="size-4 shrink-0 text-muted-foreground" />}
                    title={`Port ${server.port}`}
                    description={server.processName ?? server.host}
                    action={<span className="text-muted-foreground text-xs">Forward</span>}
                  />
                ))}
              </PortSection>
            ) : null}
          </div>
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
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
      <DiscoveryList>{children}</DiscoveryList>
    </section>
  );
}

/** Thread-header entry to a remote environment's forwarded ports. */
export function PortForwardsHeaderControl({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const canForward = useCanForwardPorts(environmentId);
  const forwards = useEnvironmentPortForwards(environmentId);
  if (!canForward) return null;
  const ports = forwards.map((forward) => forward.remotePort).join(", ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="compact"
            aria-label={ports ? `Forwarded ports: ${ports}` : "Forward ports"}
            onClick={() => openPortForwardsDialog(environmentId)}
          />
        }
      >
        <ArrowLeftRightIcon />
        {forwards.length > 0 ? `Ports ${forwards.length}` : "Ports"}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {ports ? `Forwarded to this computer: ${ports}` : "Forward ports to this computer"}
      </TooltipPopup>
    </Tooltip>
  );
}
