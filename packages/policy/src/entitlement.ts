/** Closed, server-owned plan rights. Billing/catalog state is intentionally out of scope. */

export type Plan = "free_unverified" | "free_verified" | "pro" | "lifetime";
export type Visibility = "aggregate" | "masked" | "detailed";
export type PlaybookSlice = "passive" | "introductory" | "full";

export type Rights = Readonly<{
  visibility: Visibility;
  playbookSlice: PlaybookSlice;
  maxCredits: number;
  reports: boolean;
  scheduling: boolean;
  history: boolean;
}>;

const PLAN_VALUES: readonly Plan[] = Object.freeze([
  "free_unverified",
  "free_verified",
  "pro",
  "lifetime",
]);

const RIGHTS_BY_PLAN: Readonly<Record<Plan, Rights>> = Object.freeze({
  free_unverified: Object.freeze({
    visibility: "aggregate",
    playbookSlice: "passive",
    maxCredits: 1,
    reports: false,
    scheduling: false,
    history: false,
  }),
  free_verified: Object.freeze({
    visibility: "masked",
    playbookSlice: "introductory",
    maxCredits: 1,
    reports: false,
    scheduling: false,
    history: false,
  }),
  pro: Object.freeze({
    visibility: "detailed",
    playbookSlice: "full",
    maxCredits: 10,
    reports: true,
    scheduling: true,
    history: true,
  }),
  lifetime: Object.freeze({
    visibility: "detailed",
    playbookSlice: "full",
    maxCredits: 10,
    reports: true,
    scheduling: true,
    history: true,
  }),
});

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && PLAN_VALUES.includes(value as Plan);
}

/** Return the immutable rights singleton; invalid runtime values fail closed. */
export function rightsForPlan(plan: Plan): Rights {
  if (!isPlan(plan)) throw new TypeError("invalid plan");
  return RIGHTS_BY_PLAN[plan];
}
