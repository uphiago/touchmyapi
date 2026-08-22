export {
  ScopeValidationError,
  compileScope,
  isForbiddenAddress,
  matchesScope,
  normalizeExternalUrl,
  normalizeSurfaceHost,
  validateResolvedAddresses,
} from "./scope";
export type {
  CompiledScope,
  NormalizedTarget,
  ScopeResult,
  ScopeRule,
  ScopeRuleInput,
} from "./scope";
export { isPlan, rightsForPlan } from "./entitlement";
export type { PlaybookSlice, Plan, Rights, Visibility } from "./entitlement";
export { reduceLimits } from "./limits";
export type {
  EffectiveLimits,
  LimitCeiling,
  LimitInput,
  LimitResult,
  PlaybookLimits,
} from "./limits";
export { authorize } from "./engine";
export type {
  ActionRequest,
  BlockCode,
  PolicyBlock,
  PolicyContext,
  PolicyDecision,
  RuntimeAction,
  TargetCategory,
} from "./engine";
