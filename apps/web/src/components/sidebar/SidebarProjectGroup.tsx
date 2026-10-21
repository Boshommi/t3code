/**
 * One project in the grouped sidebar: a collapsible header over that
 * project's thread rows, tinted with the project's color.
 *
 * The group subscribes to its own color so dragging the picker repaints only
 * this header and container, never the whole sidebar or its memoized rows.
 */
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  ClockIcon,
  FolderGit2Icon,
  FolderIcon,
  MessageCircleQuestionIcon,
  PaletteIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { type ProjectColor, useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProviderCustomColorPanel } from "../settings/ProviderAccentColorPicker";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { resolveSidebarThreadStatus, type SidebarProjectThreadGroup } from "../Sidebar.logic";

const PROJECT_COLOR_PRESETS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#64748b",
] as const;
const DEFAULT_PROJECT_COLOR: ProjectColor = { color: "#3b82f6", opacity: 0.14 };

function hexToRgba(hex: string, alpha: number): string {
  const numeric = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(numeric >> 16) & 255}, ${(numeric >> 8) & 255}, ${numeric & 255}, ${alpha})`;
}

/** Container tint plus a solid accent edge so the color still reads at low opacity. */
function projectTintStyle(color: ProjectColor | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    backgroundColor: hexToRgba(color.color, color.opacity),
    boxShadow: `inset 2px 0 0 ${hexToRgba(color.color, Math.min(1, color.opacity * 2 + 0.35))}`,
  };
}

function ProjectColorPanel(props: {
  projectName: string;
  value: ProjectColor | undefined;
  onChange: (color: ProjectColor | null) => void;
}) {
  const { onChange } = props;
  const current = props.value ?? DEFAULT_PROJECT_COLOR;
  // The HSV panel owns its drag state; remount it when a preset replaces the
  // color from outside so its handles jump to the new value.
  const [panelKey, setPanelKey] = useState(0);
  const opacityPercent = Math.round(current.opacity * 100);

  return (
    <div className="w-56">
      <div
        className="mx-3 mt-3 flex h-8 items-center gap-2 rounded-md px-2 text-xs font-medium text-sidebar-foreground"
        style={projectTintStyle(current)}
        aria-hidden
      >
        <span className="min-w-0 flex-1 truncate">{props.projectName}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 py-2.5">
        {PROJECT_COLOR_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-label={`Use ${preset}`}
            className={cn(
              "size-5 cursor-pointer rounded-full border border-black/10 dark:border-white/15",
              current.color === preset && props.value && "ring-2 ring-ring ring-offset-1",
            )}
            style={{ backgroundColor: preset }}
            onClick={() => {
              onChange({ color: preset, opacity: current.opacity });
              setPanelKey((key) => key + 1);
            }}
          />
        ))}
      </div>
      <ProviderCustomColorPanel
        key={panelKey}
        value={current.color}
        onCommit={(color) => onChange({ color, opacity: current.opacity })}
      />
      <label className="grid gap-1.5 px-3 pb-3 text-xs text-muted-foreground">
        <span className="flex justify-between">
          <span>Opacity</span>
          <span className="tabular-nums">{opacityPercent}%</span>
        </span>
        <input
          type="range"
          min={4}
          max={60}
          value={opacityPercent}
          onChange={(event) =>
            onChange({ color: current.color, opacity: Number(event.currentTarget.value) / 100 })
          }
          className="w-full cursor-pointer accent-primary"
          aria-label={`Opacity for ${props.projectName}`}
        />
      </label>
      <div className="border-t border-border/60 p-1">
        <Button
          type="button"
          size="compact"
          variant="ghost-muted"
          className="w-full justify-start"
          onClick={() => onChange(null)}
          disabled={!props.value}
        >
          <XIcon className="size-3.5" aria-hidden />
          Clear color
        </Button>
      </div>
    </div>
  );
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Rendered only while the tooltip is open, so the per-thread status pass
// never runs during ordinary list updates.
function ProjectGroupTooltipBody(props: {
  project: SidebarProjectSnapshot;
  displayName: string;
  threads: SidebarProjectThreadGroup<SidebarThreadSummary>;
}) {
  const { project, threads } = props;
  const liveThreads = [...threads.pinned, ...threads.active, ...threads.working];
  let working = 0;
  let needsYou = 0;
  let failed = 0;
  let lastActivity: string | null = null;
  for (const thread of liveThreads) {
    const status = resolveSidebarThreadStatus(thread);
    if (status === "working") working += 1;
    else if (status === "approval" || status === "input") needsYou += 1;
    else if (status === "failed" || status === "limited") failed += 1;
    const touchedAt = thread.latestUserMessageAt ?? thread.updatedAt;
    if (lastActivity === null || touchedAt > lastActivity) lastActivity = touchedAt;
  }
  const identity = project.repositoryIdentity;
  const repository =
    identity?.displayName ??
    (identity?.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
  const spansEnvironments = project.memberProjects.length > 1;
  const activeCount = threads.active.length + threads.working.length;
  const counts = [
    activeCount > 0 ? `${activeCount} active` : null,
    threads.pinned.length > 0 ? `${threads.pinned.length} pinned` : null,
    threads.snoozed.length > 0 ? `${threads.snoozed.length} snoozed` : null,
    threads.settled.length > 0 ? `${threads.settled.length} settled` : null,
  ].filter((entry) => entry !== null);

  return (
    <ThreadHoverCard
      title={props.displayName}
      footer={
        <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
          {counts.length > 0 ? counts.join(" · ") : "No threads yet"}
        </div>
      }
    >
      {repository ? (
        <div className="flex min-w-0 items-center gap-2">
          <FolderGit2Icon className="size-3 shrink-0 stroke-muted-foreground" />
          <div className="min-w-0 truncate text-foreground/75">{repository}</div>
        </div>
      ) : null}
      {project.memberProjects.map((member) => (
        <div key={member.physicalProjectKey} className="flex min-w-0 items-start gap-2">
          <FolderIcon className="mt-0.5 size-3 shrink-0 stroke-muted-foreground" />
          <div className="min-w-0 wrap-break-word text-foreground/75">
            {member.workspaceRoot}
            {spansEnvironments && member.environmentLabel ? (
              <span className="text-muted-foreground"> · {member.environmentLabel}</span>
            ) : null}
          </div>
        </div>
      ))}
      {working > 0 ? (
        <div className="flex min-w-0 items-center gap-2 text-info">
          <CircleDashedIcon aria-hidden className="size-3 shrink-0" />
          <div className="min-w-0 truncate">{working} working</div>
        </div>
      ) : null}
      {needsYou > 0 ? (
        <div className="flex min-w-0 items-center gap-2 text-warning-foreground">
          <MessageCircleQuestionIcon aria-hidden className="size-3 shrink-0" />
          <div className="min-w-0 truncate">{pluralize(needsYou, "thread")} waiting on you</div>
        </div>
      ) : null}
      {failed > 0 ? (
        <div className="flex min-w-0 items-center gap-2 text-error">
          <CircleAlertIcon aria-hidden className="size-3 shrink-0" />
          <div className="min-w-0 truncate">{failed} failed</div>
        </div>
      ) : null}
      {lastActivity !== null ? (
        <div className="flex min-w-0 items-center gap-2">
          <ClockIcon className="size-3 shrink-0 stroke-muted-foreground" />
          <div className="min-w-0 truncate text-foreground/75">
            Last activity {formatRelativeTimeLabel(lastActivity)}
          </div>
        </div>
      ) : null}
    </ThreadHoverCard>
  );
}

export function SidebarProjectGroup(props: {
  projectKey: string;
  /** Null for the catch-all group of threads whose project isn't loaded. */
  project: SidebarProjectSnapshot | null;
  displayName: string;
  expanded: boolean;
  /** The project's threads by section, for the header count and tooltip. */
  threads: SidebarProjectThreadGroup<SidebarThreadSummary>;
  colorPickerOpen: boolean;
  onColorPickerOpenChange: (projectKey: string, open: boolean) => void;
  onToggleExpanded: (projectKey: string) => void;
  onNewThread: (projectKey: string) => void;
  onContextMenu: (projectKey: string, position: { x: number; y: number }) => void;
  children: ReactNode;
}) {
  const { projectKey } = props;
  const color = useUiStateStore((state) => state.projectColorByKey[projectKey]);
  const setProjectColor = useUiStateStore((state) => state.setProjectColor);
  const liveCount =
    props.threads.pinned.length + props.threads.active.length + props.threads.working.length;
  const handleContextMenu = (event: ReactMouseEvent) => {
    if (props.project === null) return;
    event.preventDefault();
    props.onContextMenu(projectKey, { x: event.clientX, y: event.clientY });
  };

  return (
    <li
      className="list-none rounded-lg"
      style={projectTintStyle(color)}
      data-thread-selection-safe
      data-testid="sidebar-project-group"
    >
      <div
        className="group/project-header flex h-8 items-center gap-0.5 rounded-lg pe-1"
        onContextMenu={handleContextMenu}
      >
        <Tooltip disabled={props.project === null}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-expanded={props.expanded}
                onClick={() => props.onToggleExpanded(projectKey)}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md ps-1.5 text-left text-xs font-medium text-sidebar-foreground/85 outline-none hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-sidebar-muted-foreground/70 transition-transform",
                props.expanded && "rotate-90",
              )}
            />
            {props.project ? (
              <span className="flex shrink-0">
                <ProjectFavicon project={props.project} className="size-4" />
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">{props.displayName}</span>
            {!props.expanded && liveCount > 0 ? (
              <span className="shrink-0 pe-1 tabular-nums text-sidebar-muted-foreground/70">
                {liveCount}
              </span>
            ) : null}
          </TooltipTrigger>
          {props.project ? (
            <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
              <ProjectGroupTooltipBody
                project={props.project}
                displayName={props.displayName}
                threads={props.threads}
              />
            </ThreadHoverCardPopup>
          ) : null}
        </Tooltip>
        {props.project ? (
          <span
            className={cn(
              "flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-any-hover/project-header:opacity-100",
              props.colorPickerOpen && "opacity-100",
            )}
          >
            <Popover
              open={props.colorPickerOpen}
              onOpenChange={(open) => props.onColorPickerOpenChange(projectKey, open)}
            >
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Project color for ${props.displayName}`}
                    title="Project color"
                  >
                    <PaletteIcon className="size-3.5" />
                  </Button>
                }
              />
              <PopoverPopup side="bottom" align="end" sideOffset={6} padding="none">
                <ProjectColorPanel
                  projectName={props.displayName}
                  value={color}
                  onChange={(next) => setProjectColor(projectKey, next)}
                />
              </PopoverPopup>
            </Popover>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`New thread in ${props.displayName}`}
              title="New thread"
              onClick={() => props.onNewThread(projectKey)}
            >
              <SquarePenIcon className="size-3.5" />
            </Button>
          </span>
        ) : null}
      </div>
      {props.children ? (
        <ul role="presentation" className="flex flex-col gap-px pb-1">
          {props.children}
        </ul>
      ) : null}
    </li>
  );
}
