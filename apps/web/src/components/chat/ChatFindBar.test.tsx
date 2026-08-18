import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ChatFindBar } from "./ChatFindBar";

describe("ChatFindBar", () => {
  it("renders the match count in the top-right find field", () => {
    const markup = renderToStaticMarkup(
      <ChatFindBar
        query="login"
        onQueryChange={() => {}}
        matchIndex={1}
        matchCount={4}
        focusToken={1}
        onClose={() => {}}
        onNext={() => {}}
        onPrevious={() => {}}
      />,
    );

    expect(markup).toContain('data-chat-find-bar=""');
    expect(markup).toContain("2/4");
    expect(markup).toContain('aria-label="Find in chat"');
    expect(markup).toContain('placeholder="Find"');
  });
});
