/**
 * The single door into the vendored Zerro core. Everything the server uses
 * from vendor/zerro-core is re-exported here, so a core update has one place
 * to check.
 */
export {
  createEmptyDataStore,
  applyPatch,
  getSyncCursor,
  stageCompiledCommand,
  buildOutboxTransport,
  compileTransactionQuery,
  type TDataStore,
  type TNormalizedPatch,
  type TCommand,
} from "../vendor/zerro-core/headless";
export type { TCoreContext, TCompiled } from "../vendor/zerro-core/types";
export { createProjectionGraph } from "../vendor/zerro-core/internal/projections/graph";
export {
  compileSetTotalAssigned,
  compileMoveBudgetFunds,
  compileApplyBudgetPreset,
  compileCoverOverspending,
} from "../vendor/zerro-core/internal/operations/budgetActions";
export { TrFilterMode } from "../vendor/zerro-core/internal/domain/zerro/transactions/query";
export { envelopeVisibility } from "../vendor/zerro-core/internal/domain/zerro/envelope-meta/types";
export type { TEnvMetrics } from "../vendor/zerro-core/internal/domain/zerro/activity/envMetrics";
export type { TMonthTotals } from "../vendor/zerro-core/internal/domain/zerro/activity/monthTotals";
export type { TGoalInfo } from "../vendor/zerro-core/internal/domain/zerro/goals/build";
export type { TEnvelope, TGroupNode, TEnvNode } from "../vendor/zerro-core/internal/domain/zerro/envelopes/build";
export type { TFxAmount } from "../vendor/zerro-core/internal/domain/zenmoney/model/money";
export type { TEnvelopeId } from "../vendor/zerro-core/internal/domain/zerro/envelope-id";
export type { TISOMonth } from "../vendor/zerro-core/internal/domain/foundation/primitives";
