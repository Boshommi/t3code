import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStashMenu } from "./ComposerStashMenu";

describe("ComposerStashMenu", () => {
  it("shows incomplete image states", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[
          {
            id: "with-images",
            createdAt: new Date(0).toISOString(),
            prompt: "Compare these screenshots",
            imageCount: 1,
            droppedImageNames: ["after.png"],
            unreadableImageNames: [],
            pendingImageCount: 0,
          },
          {
            id: "saving-images",
            createdAt: new Date(0).toISOString(),
            prompt: "Save this image",
            imageCount: 0,
            droppedImageNames: [],
            unreadableImageNames: [],
            pendingImageCount: 1,
          },
        ]}
        stashShortcutLabel="Ctrl+S"
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("1 image dropped");
    expect(markup).toContain("saving 1 image");
  });

  it("labels mixed file and image stashes without treating images as files", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[
          {
            id: "mixed-attachments",
            createdAt: new Date(0).toISOString(),
            prompt: "",
            imageCount: 1,
            files: [
              {
                id: "file-one",
                name: "report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 42,
                attachmentId: "pending-report-pdf",
                environmentId: EnvironmentId.make("environment-1"),
              },
            ],
            droppedImageNames: [],
          },
        ]}
        stashShortcutLabel={null}
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("(2 attachments)");
    expect(markup).not.toContain("(2 files)");
  });
});
