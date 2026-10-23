import { promptAppInstall, useAppInstallState } from "../../pwa";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const DESCRIPTIONS = {
  installed: "T3 Code is running as an installed app.",
  promptable: "Open T3 Code in its own window, with unread counts on the app icon.",
  manual:
    "Use your browser's install option, or Share → Add to Home Screen on iPhone and iPad, to open T3 Code in its own window.",
} as const;

export function InstallAppSettingsRow() {
  const state = useAppInstallState();
  return (
    <SettingsRow
      {...searchableSetting("install-app")}
      description={DESCRIPTIONS[state]}
      control={
        state === "promptable" ? (
          <Button size="sm" variant="outline" onClick={() => void promptAppInstall()}>
            Install
          </Button>
        ) : null
      }
    />
  );
}
