/**
 * Read-only transcript of one subagent, opened from the Agents panel.
 *
 * The server reads it from the provider's own history on demand, so nothing
 * streams while the view is closed. A live agent refetches on an interval.
 */
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, SubagentTranscriptEntry, ThreadId } from "@t3tools/contracts";
import { ChevronLeft } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";

const LIVE_REFRESH_MS = 3_000;
/** Distance from the bottom that still counts as following the tail. */
const FOLLOW_THRESHOLD_PX = 48;

function sameEntry(a: SubagentTranscriptEntry, b: SubagentTranscriptEntry): boolean {
  if (a._tag !== b._tag) return false;
  if (a._tag === "tool" && b._tag === "tool") {
    return (
      a.name === b.name && a.detail === b.detail && a.output === b.output && a.failed === b.failed
    );
  }
  return (a as { text: string }).text === (b as { text: string }).text;
}

const TranscriptEntry = memo(
  function TranscriptEntry({
    entry,
    environmentId,
  }: {
    entry: SubagentTranscriptEntry;
    environmentId: EnvironmentId;
  }) {
    switch (entry._tag) {
      case "prompt":
        return (
          <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-xs">
            <div className="mb-1 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
              Prompt
            </div>
            <ChatMarkdown
              text={entry.text}
              cwd={undefined}
              environmentId={environmentId}
              lineBreaks
            />
          </div>
        );
      case "message":
        return (
          <div className="text-sm">
            <ChatMarkdown text={entry.text} cwd={undefined} environmentId={environmentId} />
          </div>
        );
      case "reasoning":
        return (
          <p className="whitespace-pre-wrap break-words text-xs italic text-muted-foreground/80">
            {entry.text}
          </p>
        );
      case "tool": {
        const summary = (
          <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-[.7rem]">
            <span
              className={cn(
                "shrink-0",
                entry.failed ? "text-destructive-foreground" : "text-foreground/80",
              )}
            >
              ▸ {entry.name}
            </span>
            {entry.detail ? (
              <span className="min-w-0 truncate text-muted-foreground">{entry.detail}</span>
            ) : null}
          </span>
        );
        return entry.output ? (
          <details className="group">
            <summary className="cursor-pointer list-none rounded-sm px-1 hover:bg-accent/40">
              {summary}
            </summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted/40 p-2 font-mono text-[.7rem] text-foreground/80">
              {entry.output}
            </pre>
          </details>
        ) : (
          <div className="px-1">{summary}</div>
        );
      }
    }
  },
  (previous, next) =>
    previous.environmentId === next.environmentId && sameEntry(previous.entry, next.entry),
);

export function SubagentTranscript({
  agent,
  environmentId,
  threadId,
  onBack,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onBack: () => void;
}) {
  const transcript = useEnvironmentQuery(
    orchestrationEnvironment.subagentTranscript({
      environmentId,
      input: { threadId, agentId: agent.transcriptAgentId ?? agent.id },
    }),
  );
  const live = isActiveSubagentStatus(agent.status);
  const { refresh } = transcript;

  useEffect(() => {
    if (!live) return;
    const id = setInterval(refresh, LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [live, refresh]);

  // Open at the tail, and keep following it while the reader stays there.
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const entries = transcript.data?.entries;
  const skipped = transcript.data?.skipped ?? 0;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (entries && element && followRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entries]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1.5 border-b border-border/60 px-1.5 py-1">
        <Button size="icon-micro" variant="ghost-muted" onClick={onBack} aria-label="All agents">
          <ChevronLeft aria-hidden className="size-3.5" />
        </Button>
        <span className="min-w-0 truncate text-sm font-medium">{agent.title}</span>
        {agent.role ? (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground">
            {agent.role}
          </span>
        ) : null}
      </header>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          followRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="flex flex-col gap-2.5 p-2.5">
          {skipped > 0 ? (
            <p className="text-center text-[.7rem] text-muted-foreground">
              {skipped} earlier {skipped === 1 ? "step" : "steps"} hidden
            </p>
          ) : null}
          {entries?.map((entry, index) => (
            // Entries only append, and `skipped` counts the ones dropped from
            // the front, so the absolute position is a stable key.
            // oxlint-disable-next-line react/no-array-index-key
            <TranscriptEntry key={skipped + index} entry={entry} environmentId={environmentId} />
          ))}
          {entries?.length === 0 ? (
            <p className="text-xs text-muted-foreground">No messages yet.</p>
          ) : null}
          {entries === undefined && transcript.error ? (
            <p className="text-xs text-destructive-foreground">{transcript.error}</p>
          ) : null}
          {entries === undefined && !transcript.error ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
