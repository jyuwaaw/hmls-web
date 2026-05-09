// Agent factories
export { type AgentConfig, type RunAgentOptions, runHmlsAgent } from "./hmls/agent.ts";
export { runStaffAgent, type RunStaffAgentOptions } from "./hmls/staff-agent.ts";
export { runFixoAgent, type RunFixoAgentOptions } from "./fixo/agent.ts";
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
  deleteMedia,
  getMedia,
  uploadMedia,
  type UploadResult,
} from "./fixo/lib/storage.ts";

// Notifications
export { notifyOrderStatusChange, notifyPaymentFailed } from "./lib/notifications.ts";

// PDF components (for gateway rendering)
export { EstimatePdf } from "./hmls/pdf/EstimatePdf.tsx";
export { DiagnosticReportPdf } from "./fixo/pdf/fixo-report.tsx";
