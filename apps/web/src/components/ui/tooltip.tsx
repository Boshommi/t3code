import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";

// Base UI's default, restated because a padding object zeroes the sides it omits.
const COLLISION_PADDING = 5;

const TooltipProvider = TooltipPrimitive.Provider;

type TooltipActionsRef = RefObject<TooltipPrimitive.Root.Actions | null>;

// Context values are frozen to the compiler, so consumers update the hovered
// tooltip through these calls rather than by writing to a shared ref.
function createTooltipHoverTracker() {
  let hovered: { trigger: HTMLElement; actionsRef: TooltipActionsRef } | null = null;
  return {
    hover(trigger: HTMLElement, actionsRef: TooltipActionsRef) {
      hovered = { trigger, actionsRef };
    },
    release(actionsRef: TooltipActionsRef) {
      if (hovered?.actionsRef === actionsRef) hovered = null;
    },
    dismissUnfocused() {
      const tooltip = hovered;
      if (!tooltip || tooltip.trigger.contains(tooltip.trigger.ownerDocument.activeElement)) {
        return;
      }
      hovered = null;
      // Base UI also cancels delayed hover opens through this action.
      tooltip.actionsRef.current?.close();
    },
  };
}

type TooltipHoverTracker = ReturnType<typeof createTooltipHoverTracker>;
const TooltipHoverContext = createContext<TooltipActionsRef | null>(null);
const TooltipScrollContext = createContext<TooltipHoverTracker | null>(null);

// Base UI tooltips only open on mouse hover or keyboard focus, which leaves
// touch users without them. A tap on a trigger that has no action of its own
// (a status icon, a timestamp, truncated text) toggles the tooltip instead;
// buttons and links keep their tap for their action.
const TooltipTapContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

const TAP_ACTION_SELECTOR =
  "button, a[href], input, select, textarea, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=switch]";

function TooltipScrollDismissArea({ onScrollCapture, ...props }: ComponentProps<"div">) {
  const [tracker] = useState(createTooltipHoverTracker);
  return (
    <TooltipScrollContext value={tracker}>
      <div
        {...props}
        onScrollCapture={(event) => {
          onScrollCapture?.(event);
          tracker.dismissUnfocused();
        }}
      />
    </TooltipScrollContext>
  );
}

function Tooltip<Payload>({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: TooltipPrimitive.Root.Props<Payload>) {
  const tracker = use(TooltipScrollContext);
  const localActionsRef = useRef<TooltipPrimitive.Root.Actions | null>(null);
  const actionsRef = props.actionsRef ?? localActionsRef;
  const [openState, setOpenState] = useState(defaultOpen);
  useEffect(() => () => tracker?.release(actionsRef), [actionsRef, tracker]);
  // Callers that control `open` own it, so tap-to-open stays out of their way.
  const tap = openProp === undefined ? { open: openState, setOpen: setOpenState } : null;

  const root = (
    <TooltipPrimitive.Root
      {...props}
      actionsRef={actionsRef}
      open={openProp ?? openState}
      onOpenChange={(open, details) => {
        onOpenChange?.(open, details);
        if (details.isCanceled) return;
        setOpenState(open);
        if (!open) tracker?.release(actionsRef);
      }}
    />
  );
  return (
    <TooltipTapContext value={tap}>
      {tracker ? <TooltipHoverContext value={actionsRef}>{root}</TooltipHoverContext> : root}
    </TooltipTapContext>
  );
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  const tracker = use(TooltipScrollContext);
  const actionsRef = use(TooltipHoverContext);
  const tap = use(TooltipTapContext);
  // Base UI closes an open tooltip on pointerdown, so the toggle reads the
  // state from before that press.
  const pressRef = useRef<{ touch: boolean; wasOpen: boolean } | null>(null);
  const tapProps: Partial<TooltipPrimitive.Trigger.Props> = tap
    ? {
        onPointerDown: (event) => {
          pressRef.current = { touch: event.pointerType === "touch", wasOpen: tap.open };
          props.onPointerDown?.(event);
        },
        onClick: (event) => {
          props.onClick?.(event);
          const press = pressRef.current;
          pressRef.current = null;
          if (!press?.touch || event.defaultPrevented) return;
          if (event.currentTarget.matches(TAP_ACTION_SELECTOR)) return;
          tap.setOpen(!press.wasOpen);
        },
      }
    : {};
  const hoverProps: Partial<TooltipPrimitive.Trigger.Props> =
    tracker && actionsRef
      ? {
          onMouseEnter: (event) => {
            props.onMouseEnter?.(event);
            tracker.hover(event.currentTarget, actionsRef);
          },
        }
      : {};
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      {...tapProps}
      {...hoverProps}
    />
  );
}

function TooltipPositioner(props: TooltipPrimitive.Positioner.Props) {
  const titlebarHeight = useNativeTitlebarHeight();
  return (
    <TooltipPrimitive.Positioner
      className="pointer-events-none z-[140] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"
      collisionPadding={{
        top: COLLISION_PADDING + titlebarHeight,
        right: COLLISION_PADDING,
        bottom: COLLISION_PADDING,
        left: COLLISION_PADDING,
      }}
      data-slot="tooltip-positioner"
      {...props}
    />
  );
}

function TooltipPopup({
  className,
  align = "center",
  sideOffset = 4,
  side = "top",
  variant = "default",
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  variant?: "default" | "glass" | "code";
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPositioner align={align} anchor={anchor} side={side} sideOffset={sideOffset}>
        <TooltipPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md text-popover-foreground text-xs transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            variant === "glass"
              ? "dropdown-glass shadow-xl shadow-black/25 before:hidden"
              : "border bg-popover not-dark:bg-clip-padding shadow-md/5",
            variant === "code"
              ? "max-w-120 wrap-anywhere text-left font-mono text-[11px] leading-relaxed"
              : "max-w-80 wrap-anywhere whitespace-normal leading-snug",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Viewport
            className="relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity"
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPositioner>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipPopup, TooltipScrollDismissArea };
