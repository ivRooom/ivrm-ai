/** All amounts are integer micro-USD (1 USD = 1,000,000). */
export type CostLimits = {
  perRequestMicroUsd: number;
  userDailyMicroUsd: number;
  globalMonthlyMicroUsd: number;
  userRequestsPerMinute: number;
  maxConcurrent: number;
};

// Initial values from docs/design.md section 5. Tune with real usage; keep the
// global monthly cap well below the account budget (USD 67, where 100% stops
// the production EC2).
export const DEFAULT_LIMITS: CostLimits = {
  perRequestMicroUsd: 120_000, // $0.12
  userDailyMicroUsd: 500_000, // $0.50
  globalMonthlyMicroUsd: 15_000_000, // $15
  userRequestsPerMinute: 6,
  maxConcurrent: 4,
};

export function usdToMicro(usd: number): number {
  return Math.round(usd * 1_000_000);
}
