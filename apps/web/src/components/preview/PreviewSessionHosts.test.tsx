import * as NodeTimersPromises from "node:timers/promises";

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type PreviewEvent,
  type PreviewListResult,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";

import { PreviewSessionHosts } from "./PreviewSessionHosts";
import { usePreviewSession } from "./usePreviewSession";

const mocks = vi.hoisted(() => ({ list: vi.fn(), events: vi.fn() }));
vi.mock("~/state/preview", () => ({ previewEnvironment: mocks }));

const listSources = Atom.family((_key: string) =>
  Atom.make<AsyncResult.AsyncResult<PreviewListResult>>(AsyncResult.initial()).pipe(Atom.keepAlive),
);
const lists = Atom.family((key: string) => Atom.make((get) => get(listSources(key))));
const events = Atom.family((_environmentId: string) =>
  Atom.make<AsyncResult.AsyncResult<PreviewEvent>>(AsyncResult.initial()),
);
let renderer: ReactTestRenderer | null = null;
let sequence = 0;
let threadRef: ScopedThreadRef;

function snapshot(ref: ScopedThreadRef, tabId = "tab-1"): PreviewSessionSnapshot {
  return {
    threadId: ref.threadId,
    tabId,
    navStatus: { _tag: "Success", url: "https://example.com/", title: "Preview" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-10-05T09:00:00.000Z",
  };
}

function Panel({ threadRef }: { threadRef: ScopedThreadRef }) {
  usePreviewSession(threadRef);
  return null;
}

function seed(ref: ScopedThreadRef, sessions = [snapshot(ref)]) {
  appAtomRegistry.set(
    listSources(scopedThreadKey(ref)),
    AsyncResult.success({ sessions, serverEpoch: "epoch", revision: 1 }),
  );
  for (const session of sessions) applyPreviewServerSnapshot(ref, session);
}

function closeFromServer(ref: ScopedThreadRef, tabId = "tab-1", revision = 2) {
  appAtomRegistry.set(
    events(ref.environmentId),
    AsyncResult.success({
      type: "closed",
      threadId: ref.threadId,
      tabId,
      serverEpoch: "epoch",
      revision,
      createdAt: "2026-10-05T09:06:00.000Z",
    }),
  );
}

async function render(panel = false) {
  await act(() => {
    const tree = (
      <AppAtomRegistryProvider>
        <PreviewSessionHosts />
        {panel && <Panel threadRef={threadRef} />}
      </AppAtomRegistryProvider>
    );
    if (renderer) renderer.update(tree);
    else renderer = create(tree);
  });
}

beforeEach(() => {
  appAtomRegistry.reset();
  resetPreviewStateForTests();
  mocks.list.mockImplementation(({ environmentId, input }) =>
    lists(scopedThreadKey(scopeThreadRef(environmentId, input.threadId))),
  );
  mocks.events.mockImplementation(({ environmentId }) => events(environmentId));
  threadRef = scopeThreadRef(
    EnvironmentId.make(`environment-${++sequence}`),
    ThreadId.make("thread-1"),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  appAtomRegistry.reset();
  resetPreviewStateForTests();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("releases a retained preview when the server closes it after leaving the panel", async () => {
  seed(threadRef);
  await render(true);
  await render(false);
  // The panel subscription has a one-second cache grace period, rounded into
  // registry timer buckets. Let it expire so the panel cannot mask a missing host.
  await act(() => NodeTimersPromises.setTimeout(2_100));
  await act(() => closeFromServer(threadRef));
  expect(readThreadPreviewState(threadRef).sessions).toEqual({});
});

it("releases automation-created tabs that never mounted a preview panel", async () => {
  await render();
  await act(() => seed(threadRef));
  expect(Object.keys(readThreadPreviewState(threadRef).sessions)).toEqual(["tab-1"]);
  await act(() => closeFromServer(threadRef));
  expect(readThreadPreviewState(threadRef).sessions).toEqual({});
});

it("keeps synchronization until the last tab closes without touching another environment", async () => {
  const remote = scopeThreadRef(EnvironmentId.make("remote"), threadRef.threadId);
  seed(threadRef, [snapshot(threadRef), snapshot(threadRef, "tab-2")]);
  seed(remote);
  await render();
  await act(() => closeFromServer(threadRef));
  expect(Object.keys(readThreadPreviewState(threadRef).sessions)).toEqual(["tab-2"]);
  expect(Object.keys(readThreadPreviewState(remote).sessions)).toEqual(["tab-1"]);
  await act(() => closeFromServer(threadRef, "tab-2", 3));
  expect(readThreadPreviewState(threadRef).sessions).toEqual({});
  await act(() => closeFromServer(remote));
  expect(readThreadPreviewState(remote).sessions).toEqual({});
});

it("reconciles retained previews against the server without visiting their threads", async () => {
  seed(threadRef);
  appAtomRegistry.set(
    listSources(scopedThreadKey(threadRef)),
    AsyncResult.success({ sessions: [], serverEpoch: "epoch", revision: 2 }),
  );
  await render();
  expect(readThreadPreviewState(threadRef).sessions).toEqual({});
});

it("does not subscribe to hundreds of histories with no live previews", async () => {
  for (let index = 0; index < 300; index++) {
    const ref = scopeThreadRef(threadRef.environmentId, ThreadId.make(`old-${index}`));
    seed(ref);
    applyPreviewServerSnapshot(ref, null);
  }
  await render();
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.events).not.toHaveBeenCalled();
});
