/**
 * Side-threads right-panel surface: read-only `/btw` questions about the
 * thread, answered beside the conversation without entering it. Everything
 * shown comes from the thread read model; only which view is open is local
 * (sideThreadPanelStore), so the panel stays usable while a turn runs.
 */
import type { SideThread } from "@t3tools/client-runtime/state/side-threads";
import {
  SIDE_QUESTION_MAX_CHARS,
  type MessageId,
  type OrchestrationMessage,
  type OrchestrationSideMessage,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ChevronLeft, CircleAlert, MessagesSquare, Plus, Trash2 } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { ensureLocalApi } from "~/localApi";
import { newMessageId } from "~/lib/utils";
import { useSideThreadPanelStore, useSideThreadPanelView } from "~/sideThreadPanelStore";
import { formatDayAwareTimestamp } from "~/timestampFormat";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface SideQuestionInput {
  readonly sideThreadId: MessageId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly anchorMessageId: MessageId | null;
}

interface SideThreadsPanelProps {
  threadKey: string;
  threadRef: ScopedThreadRef;
  sideThreads: ReadonlyArray<SideThread>;
  /** Main-thread messages, for the excerpt of the message a side thread started from. */
  messages: ReadonlyArray<OrchestrationMessage>;
  /** Anchor for a side thread started from the panel: the newest message. */
  latestMessageId: MessageId | null;
  /** False when the thread's provider cannot answer side questions. */
  canAsk: boolean;
  markdownCwd: string | undefined;
  timestampFormat: TimestampFormat;
  /** Resolves false when the question could not be sent; the draft is kept. */
  onAsk: (input: SideQuestionInput) => Promise<boolean>;
  onDelete: (sideThreadId: MessageId) => Promise<boolean>;
}

export const SideThreadsPanel = memo(function SideThreadsPanel(props: SideThreadsPanelProps) {
  const { threadKey, sideThreads } = props;
  const view = useSideThreadPanelView(threadKey);
  const setView = useSideThreadPanelStore((state) => state.setView);
  const openThread =
    view.kind === "thread" ? sideThreads.find((thread) => thread.id === view.sideThreadId) : null;
  const pendingQuestion =
    view.kind === "thread" && !openThread ? (view.pendingQuestion ?? null) : null;

  // Once the question arrives the placeholder has done its job; dropping it
  // means a later deletion (from any device) falls back to the list.
  useEffect(() => {
    if (view.kind === "thread" && openThread && view.pendingQuestion !== undefined) {
      setView(threadKey, { kind: "thread", sideThreadId: view.sideThreadId });
    }
  }, [openThread, setView, threadKey, view]);

  if (view.kind === "compose") {
    return (
      <SideThreadView
        {...props}
        key={`compose:${view.anchorMessageId ?? ""}`}
        thread={null}
        sideThreadId={null}
        anchorMessageId={view.anchorMessageId}
        pendingQuestion={null}
      />
    );
  }
  if (view.kind === "thread" && (openThread || pendingQuestion !== null)) {
    return (
      <SideThreadView
        {...props}
        key={view.sideThreadId}
        thread={openThread ?? null}
        sideThreadId={view.sideThreadId}
        anchorMessageId={openThread?.anchorMessageId ?? null}
        pendingQuestion={pendingQuestion}
      />
    );
  }
  return (
    <SideThreadList
      {...props}
      anchorMessageId={view.kind === "list" ? (view.anchorMessageId ?? null) : null}
    />
  );
});

function SideThreadList(props: SideThreadsPanelProps & { anchorMessageId: MessageId | null }) {
  const { threadKey, anchorMessageId } = props;
  const setView = useSideThreadPanelStore((state) => state.setView);
  const threads = useMemo(
    () =>
      anchorMessageId === null
        ? props.sideThreads
        : props.sideThreads.filter((thread) => thread.anchorMessageId === anchorMessageId),
    [anchorMessageId, props.sideThreads],
  );
  const startNew = () =>
    setView(threadKey, {
      kind: "compose",
      anchorMessageId: anchorMessageId ?? props.latestMessageId,
    });

  if (props.sideThreads.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <MessagesSquare aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No side threads yet</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          Ask a quick question about this thread with /btw, or reply to a message in a side thread.
          Answers stay out of the conversation and never interrupt the agent.
        </p>
        {props.canAsk ? (
          <Button size="xs" variant="outline" className="mt-2" onClick={startNew}>
            <Plus />
            New side thread
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        {anchorMessageId !== null ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setView(threadKey, { kind: "list" })}
            aria-label="Show all side threads"
          >
            <ChevronLeft />
            All side threads
          </Button>
        ) : (
          <span className="px-1 text-xs font-medium text-muted-foreground">
            {props.sideThreads.length} side {props.sideThreads.length === 1 ? "thread" : "threads"}
          </span>
        )}
        {props.canAsk ? (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={startNew}>
            <Plus />
            New
          </Button>
        ) : null}
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 p-2">
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => setView(threadKey, { kind: "thread", sideThreadId: thread.id })}
              className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/40"
            >
              <span className="line-clamp-2 text-sm">{thread.question}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <SideThreadStatus thread={thread} />
                <span aria-hidden>·</span>
                <span className="tabular-nums">
                  {formatDayAwareTimestamp(thread.updatedAt, props.timestampFormat)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/** Reply count, or what the newest message says about the answer. */
export function SideThreadStatus({ thread }: { thread: SideThread }) {
  if (thread.waiting) return <span>Thinking…</span>;
  if (thread.messages.at(-1)?.role === "error") {
    return <span className="text-destructive-foreground">Failed</span>;
  }
  return (
    <span>
      {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
    </span>
  );
}

function SideThreadView(
  props: SideThreadsPanelProps & {
    thread: SideThread | null;
    /** Null while composing the first question of a new side thread. */
    sideThreadId: MessageId | null;
    anchorMessageId: MessageId | null;
    pendingQuestion: string | null;
  },
) {
  const { thread, threadKey, sideThreadId, anchorMessageId } = props;
  const setView = useSideThreadPanelStore((state) => state.setView);
  const anchorText = useMemo(() => {
    if (anchorMessageId === null) return null;
    return props.messages.find((message) => message.id === anchorMessageId)?.text ?? null;
  }, [anchorMessageId, props.messages]);
  const waiting = thread === null ? props.pendingQuestion !== null : thread.waiting;
  const messageCount = thread?.messages.length ?? 0;
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messageCount > 0) endRef.current?.scrollIntoView({ block: "end" });
  }, [messageCount]);

  const deleteThread = async () => {
    if (sideThreadId === null) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      ["Delete this side thread?", "Its questions and answers are removed on every device."].join(
        "\n",
      ),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    if (await props.onDelete(sideThreadId)) {
      setView(threadKey, { kind: "list" });
    }
  };

  const ask = async (text: string) => {
    const messageId = newMessageId();
    // A new side thread is identified by its first question.
    const nextSideThreadId = sideThreadId ?? messageId;
    const sent = await props.onAsk({
      sideThreadId: nextSideThreadId,
      messageId,
      text,
      anchorMessageId,
    });
    if (sent && sideThreadId === null) {
      setView(threadKey, {
        kind: "thread",
        sideThreadId: nextSideThreadId,
        pendingQuestion: text,
      });
    }
    return sent;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setView(threadKey, { kind: "list" })}
          aria-label="Back to side threads"
        >
          <ChevronLeft />
          Side threads
        </Button>
        {thread !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => void deleteThread()}
                  aria-label="Delete side thread"
                />
              }
            >
              <Trash2 />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Delete side thread</TooltipPopup>
          </Tooltip>
        ) : null}
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {anchorMessageId !== null ? (
            <blockquote className="border-l-2 border-border pl-2 text-xs text-muted-foreground">
              <span className="line-clamp-3 whitespace-pre-wrap">
                {anchorText?.trim() || "An earlier message in this thread"}
              </span>
            </blockquote>
          ) : null}
          {thread?.messages.map((message) => (
            <SideMessageItem
              key={message.id}
              message={message}
              threadRef={props.threadRef}
              markdownCwd={props.markdownCwd}
            />
          ))}
          {thread === null && props.pendingQuestion !== null ? (
            <SideQuestionBubble text={props.pendingQuestion} />
          ) : null}
          {waiting ? <p className="text-xs text-muted-foreground">Thinking…</p> : null}
          <div ref={endRef} />
        </div>
      </ScrollArea>
      <SideQuestionComposer
        canAsk={props.canAsk}
        waiting={waiting}
        placeholder={thread === null ? "Ask a side question…" : "Reply…"}
        autoFocus={thread === null && props.pendingQuestion === null}
        onSubmit={ask}
      />
    </div>
  );
}

const SideMessageItem = memo(function SideMessageItem(props: {
  message: OrchestrationSideMessage;
  threadRef: ScopedThreadRef;
  markdownCwd: string | undefined;
}) {
  const { message } = props;
  if (message.role === "user") return <SideQuestionBubble text={message.text} />;
  if (message.role === "error") {
    return (
      <p className="flex items-start gap-1.5 text-xs text-destructive-foreground">
        <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
        <span className="whitespace-pre-wrap">{message.text}</span>
      </p>
    );
  }
  return (
    <div className="min-w-0 text-sm">
      <ChatMarkdown
        text={message.text}
        cwd={props.markdownCwd}
        threadRef={props.threadRef}
        isStreaming={false}
      />
    </div>
  );
});

function SideQuestionBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-message px-3 py-2 text-sm text-message-foreground">
      {text}
    </div>
  );
}

function SideQuestionComposer(props: {
  canAsk: boolean;
  waiting: boolean;
  placeholder: string;
  autoFocus: boolean;
  onSubmit: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const disabled = !props.canAsk || props.waiting || sending;

  const submit = async () => {
    const text = draft.trim();
    if (disabled || text.length === 0) return;
    setSending(true);
    const sent = await props.onSubmit(text);
    setSending(false);
    if (sent) setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <div className="shrink-0 border-t border-border/60 p-2">
      <Textarea
        size="sm"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          props.canAsk ? props.placeholder : "This thread's provider cannot answer side questions."
        }
        disabled={disabled}
        maxLength={SIDE_QUESTION_MAX_CHARS}
        autoFocus={props.autoFocus}
        aria-label={props.placeholder}
        style={{ maxHeight: "10rem" }}
      />
    </div>
  );
}
