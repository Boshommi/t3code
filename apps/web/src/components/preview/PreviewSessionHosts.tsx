import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useActivePreviewThreadKeys } from "~/previewStateStore";

import { usePreviewSession } from "./usePreviewSession";

function PreviewSessionHost({ threadRef }: { threadRef: ScopedThreadRef }) {
  usePreviewSession(threadRef);
  return null;
}

/** Keep server cleanup subscribed for as long as a client retains preview tabs. */
export function PreviewSessionHosts() {
  const threadKeys = useActivePreviewThreadKeys();
  return Array.from(threadKeys, (threadKey) => {
    const threadRef = parseScopedThreadKey(threadKey);
    return threadRef ? <PreviewSessionHost key={threadKey} threadRef={threadRef} /> : null;
  });
}
