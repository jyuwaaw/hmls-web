// Agent factories
export { type AgentConfig, type RunAgentOptions, runHmlsAgent } from "./hmls/agent.ts";
export { runStaffAgent, type RunStaffAgentOptions } from "./hmls/staff-agent.ts";
export { runFixoAgent, type RunFixoAgentOptions } from "./fixo/agent.ts";
export { type DiagnoseOnceInput, type DiagnoseOnceResult, runFixoOnce } from "./fixo/run-once.ts";
export {
  fixoResultSchema,
  type FixoSessionResult,
  summarizeFixoSession,
  type SummarizeFixoSessionOptions,
} from "./fixo/summarize.ts";
export { runSummarizer } from "./fixo/summarizer.ts";
export { buildAgentContext } from "./fixo/build-context.ts";

// Types
export { formatUserContext, type UserContext } from "./types/user-context.ts";

// Fixo business logic (used by gateway middleware/routes)
export {
  calculateCost,
  consumeCredits,
  CREDIT_COSTS,
  type CreditBalance,
  creditsForUsd,
  ensureFreshMonthlyGrant,
  getBalance,
  getCreditHistory,
  getUsageStats,
  grantMonthly,
  grantTopup,
  type InputKind,
  InsufficientCreditsError,
  MONTHLY_GRANT,
  PromoRedemptionError,
  redeemPromoCode,
  refundCredits,
  revokeTopupCredits,
  SUGGESTED_TOPUPS_USD,
  type Tier,
  TOPUP_CENTS_PER_CREDIT,
  TOPUP_MAX_USD,
  TOPUP_MIN_USD,
  type UsageStats,
} from "./fixo/lib/credits.ts";
export {
  createCheckoutSession,
  createPortalSession,
  createTopupCheckoutSession,
  getStripeCustomerIdForUser,
  handleSubscriptionWebhook,
  stripe,
  tierFromPriceId,
} from "./fixo/lib/stripe.ts";
export {
  createSignedReadUrl,
  createSignedUploadUrl,
  deleteMedia,
  getMedia,
  getObjectInfo,
  type SignedUpload,
  uploadMedia,
  type UploadResult,
} from "./fixo/lib/storage.ts";

// Public-API key handling (gateway api-key middleware + mint script)
export { generateApiKey, hashApiKey, verifyApiKey } from "./fixo/lib/api-keys.ts";

// Notifications
export { notifyOrderStatusChange, notifyPaymentFailed } from "./lib/notifications.ts";

// Funnel telemetry (channel attribution for fixo推广 plan)
export { type FunnelEventInput, insertFunnelEvent, recordFunnelEvent } from "./lib/funnel.ts";

// Kill-criteria signals (Lane A S6 — D5 kill criteria from CEO plan)
export {
  type ChannelClick,
  computeKillSignals,
  type KillCriteriaSignals,
  renderKillSignalsForSlack,
  type SeoPageView,
} from "./lib/kill-criteria.ts";

// Slack webhook helper (used by kill-criteria check + future ops alerts)
export { postSlackMessage, type SlackMessageOptions } from "./lib/slack.ts";

// PDF components (for gateway rendering)
export { EstimatePdf } from "./hmls/pdf/EstimatePdf.tsx";
export { DiagnosticReportPdf } from "./fixo/pdf/fixo-report.tsx";
