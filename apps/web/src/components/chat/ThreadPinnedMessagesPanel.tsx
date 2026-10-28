import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, PinIcon, XIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { assistantCitationNavigation } from "../../lib/assistantCitationNavigation";
import { cn } from "../../lib/utils";
import {
  usePinnedMessagesStore,
  useThreadPins,
  type PinnedMessage,
} from "../../pinnedMessagesStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

function pinnedMessagePreview(pin: PinnedMessage): string {
  return (
    pin.citation.text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

export function ThreadPinnedMessagesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const pins = useThreadPins(threadRef);
  const open = usePinnedMessagesStore((state) => state.sectionOpen);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const navigate = useNavigate();

  if (pins.length === 0) return null;

  const jumpTo = (pin: PinnedMessage) => {
    // The popover card covers the timeline; the inline card sits beside it.
    useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", false);
    void navigate(assistantCitationNavigation(pin.citation));
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-pinned-heading"
      title="Pinned"
      showHeading={false}
    >
      <ThreadDetailsControl
        aria-expanded={open}
        onClick={() => usePinnedMessagesStore.getState().setSectionOpen(!open)}
      >
        <PinIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          Pinned
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{pins.length}</span>
        <ChevronDownIcon className={cn(THREAD_DETAILS_PANEL_CHEVRON_CLASS, open && "rotate-180")} />
      </ThreadDetailsControl>
      {open ? (
        <ul data-thread-pinned-messages-list className="m-0 flex list-none flex-col p-0">
          {pins.map((pin) => {
            const preview = pinnedMessagePreview(pin);
            return (
              <li key={pin.citation.messageId} className="group/pin flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={<ThreadDetailsControl multiline onClick={() => jumpTo(pin)} />}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{preview}</span>
                      <span className="text-2xs font-normal text-muted-foreground">
                        {formatDayAwareTimestamp(pin.messageCreatedAt, timestampFormat)}
                      </span>
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup side="left" className="max-w-80">
                    <p className="line-clamp-4 whitespace-pre-line">{pin.citation.text}</p>
                  </TooltipPopup>
                </Tooltip>
                <span className="me-1 opacity-0 group-focus-within/pin:opacity-100 group-hover/pin:opacity-100 pointer-coarse:opacity-100">
                  <ThreadDetailsControl
                    part="icon"
                    aria-label={`Unpin: ${preview}`}
                    onClick={() =>
                      usePinnedMessagesStore.getState().unpin(threadRef, pin.citation.messageId)
                    }
                  >
                    <XIcon className="size-3.5" />
                  </ThreadDetailsControl>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </ThreadDetailsSection>
  );
}
