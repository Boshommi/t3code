import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { createContext, useContext, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;

// Base UI tooltips only open on mouse hover or keyboard focus, which leaves
// touch users without them. A tap on a trigger that has no action of its own
// (a status icon, a timestamp, truncated text) toggles the tooltip instead.
// Buttons and links keep their tap for their action.
const TooltipTapContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

const TAP_ACTION_SELECTOR =
  "button, a[href], input, select, textarea, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=switch]";

function Tooltip<Payload>({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: TooltipPrimitive.Root.Props<Payload>) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  // Callers that control `open` own it, so tap-to-open stays out of their way.
  const tap = useMemo(
    () => (openProp === undefined ? { open: openState, setOpen: setOpenState } : null),
    [openProp, openState],
  );
  return (
    <TooltipTapContext.Provider value={tap}>
      <TooltipPrimitive.Root
        {...props}
        open={open}
        onOpenChange={(next, eventDetails) => {
          setOpenState(next);
          onOpenChange?.(next, eventDetails);
        }}
      />
    </TooltipTapContext.Provider>
  );
}

function TooltipTrigger<Payload>(props: TooltipPrimitive.Trigger.Props<Payload>) {
  const tap = useContext(TooltipTapContext);
  // Base UI closes an open tooltip on pointerdown, so the toggle has to read the
  // state from before that press.
  const pressRef = useRef<{ touch: boolean; wasOpen: boolean } | null>(null);
  if (!tap) return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onPointerDown={(event) => {
        pressRef.current = { touch: event.pointerType === "touch", wasOpen: tap.open };
        props.onPointerDown?.(event);
      }}
      onClick={(event) => {
        props.onClick?.(event);
        const press = pressRef.current;
        pressRef.current = null;
        if (!press?.touch || event.defaultPrevented) return;
        if (event.currentTarget.matches(TAP_ACTION_SELECTOR)) return;
        tap.setOpen(!press.wasOpen);
      }}
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
  /** `code` renders monospace content that breaks anywhere, for paths and commands. */
  variant?: "default" | "glass" | "code";
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        anchor={anchor}
        className="pointer-events-none z-[140] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"
        data-slot="tooltip-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md text-popover-foreground text-xs transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            variant === "glass"
              ? "dropdown-glass shadow-xl shadow-black/25 before:hidden"
              : "border bg-popover not-dark:bg-clip-padding shadow-md/5",
            // One wrap width for prose; code dumps get more room and break anywhere.
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
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipPopup };
