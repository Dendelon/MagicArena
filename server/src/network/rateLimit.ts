export const RATE_PER_SECOND = 60;
export const BUCKET_CAPACITY = 60;
export const CHAT_RATE_PER_SECOND = 5;
export const CHAT_BUCKET_CAPACITY = 10;

export interface TokenBucketConfig {
  readonly capacity: number;
  readonly ratePerSecond: number;
}

export interface TokenConsumeResult {
  readonly allowed: boolean;
  readonly tokens: number;
  readonly lastRefill: number;
}

export const consumeToken = (
  tokens: number,
  lastRefill: number,
  now: number,
  { capacity, ratePerSecond }: TokenBucketConfig,
): TokenConsumeResult => {
  const elapsedSeconds = Math.max(0, (now - lastRefill) / 1000);
  const refilled = Math.min(capacity, tokens + elapsedSeconds * ratePerSecond);

  if (refilled < 1) {
    return {
      allowed: false,
      tokens: refilled,
      lastRefill: now,
    };
  }

  return {
    allowed: true,
    tokens: refilled - 1,
    lastRefill: now,
  };
};

