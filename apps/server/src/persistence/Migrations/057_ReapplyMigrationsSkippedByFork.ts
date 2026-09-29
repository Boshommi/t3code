import * as Effect from "effect/Effect";

import migratePullRequestFilesViewed from "./053_PullRequestFilesViewed.ts";
import migrateAutoSettleDisabledAt from "./054_ProjectionThreadsAutoSettleDisabledAt.ts";

// This fork once shipped its own 053 and 054 (now 055 and 056). The migrator only
// runs ids above the latest recorded one, so databases created by those builds
// skipped upstream's 053 and 054. Both are idempotent, so rerunning them here is
// a no-op everywhere else.
export default Effect.gen(function* () {
  yield* migratePullRequestFilesViewed;
  yield* migrateAutoSettleDisabledAt;
});
