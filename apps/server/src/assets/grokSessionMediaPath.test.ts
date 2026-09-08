import { describe, expect, it } from "vite-plus/test";

import {
  encodedGrokSessionMediaPath,
  grokSessionMediaPathCandidates,
  isGrokSessionMediaPath,
} from "./grokSessionMediaPath.ts";

const decodedSessionImage =
  "/home/wsl/.grok/sessions/home/wsl/proj/.t3/worktrees/t3code-90f0a8fd/01a07e4e-b1fc-7173-afcc-8403670aa057/images/1.jpg";
const encodedSessionImage =
  "/home/wsl/.grok/sessions/%2Fhome%2Fwsl%2Fproj%2F.t3%2Fworktrees%2Ft3code-90f0a8fd/01a07e4e-b1fc-7173-afcc-8403670aa057/images/1.jpg";

describe("encodedGrokSessionMediaPath", () => {
  it("rebuilds the on-disk Grok session path from a decoded markdown destination", () => {
    expect(
      encodedGrokSessionMediaPath(
        "/home/wsl.grok/sessions/home/wsl/proj/.t3/worktrees/t3code-90f0a8fd/01a07e4e-b1fc-7173-afcc-8403670aa057/images/1.jpg",
      ),
    ).toBe(
      "/home/wsl.grok/sessions/%2Fhome%2Fwsl%2Fproj%2F.t3%2Fworktrees%2Ft3code-90f0a8fd/01a07e4e-b1fc-7173-afcc-8403670aa057/images/1.jpg",
    );
  });

  it("rebuilds a path whose decodeURIComponent introduced an empty sessions segment", () => {
    expect(
      encodedGrokSessionMediaPath(
        "/home/wsl.grok/sessions//home/wsl/proj/01a07e4e-b1fc-7173-afcc-8403670aa057/images/1.jpg",
      ),
    ).toBe(
      "/home/wsl.grok/sessions/%2Fhome%2Fwsl%2Fproj/01a07e4e-b1fc-7173-afcc-8403670aa057/images/1.jpg",
    );
  });

  it("leaves an already-encoded session cwd alone", () => {
    expect(
      encodedGrokSessionMediaPath(
        "/home/wsl.grok/sessions/%2Fhome%2Fwsl%2Fproj/01a07e4e-b1fc-7173-afcc-8403670aa057/images/1.jpg",
      ),
    ).toBeNull();
  });

  it("ignores non-session media paths", () => {
    expect(encodedGrokSessionMediaPath("/tmp/embed-test/1.jpg")).toBeNull();
    expect(
      encodedGrokSessionMediaPath("/home/wsl/proj/.t3/worktrees/t3code-90f0a8fd/images/1.jpg"),
    ).toBeNull();
  });
});

describe("isGrokSessionMediaPath", () => {
  it("accepts encoded and decoded Grok session image paths", () => {
    expect(isGrokSessionMediaPath(decodedSessionImage)).toBe(true);
    expect(isGrokSessionMediaPath(encodedSessionImage)).toBe(true);
  });

  it("rejects ordinary media paths", () => {
    expect(isGrokSessionMediaPath("/tmp/embed-test/1.jpg")).toBe(false);
    expect(
      isGrokSessionMediaPath("/home/wsl/proj/.t3/worktrees/t3code-90f0a8fd/images/1.jpg"),
    ).toBe(false);
  });
});

describe("grokSessionMediaPathCandidates", () => {
  it("tries the decoded markdown path then the encoded on-disk path", () => {
    expect(grokSessionMediaPathCandidates(decodedSessionImage)).toEqual([
      decodedSessionImage,
      encodedSessionImage,
    ]);
  });

  it("leaves an already-encoded session path as the only candidate", () => {
    expect(grokSessionMediaPathCandidates(encodedSessionImage)).toEqual([encodedSessionImage]);
  });

  it("returns no candidates for ordinary media paths", () => {
    expect(grokSessionMediaPathCandidates("/tmp/embed-test/1.jpg")).toEqual([]);
  });
});
