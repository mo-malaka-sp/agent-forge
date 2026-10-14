export const SAILPOINT_DEMO_DURATION_MS = 15 * 60 * 1000;

/** Uneven gaps: short bursts, a steady pace, then quieter stretches. */
export function sailPointDemoDelayMs(random: () => number = Math.random): number {
  const roll = random();
  if (roll < 0.25) return 2_000 + Math.floor(random() * 2_000);
  if (roll < 0.7) return 6_000 + Math.floor(random() * 6_000);
  return 12_000 + Math.floor(random() * 10_001);
}

/** How many logs a 15-minute run sends: one immediately, then after each gap. */
export function countSailPointDemoTicks(
  durationMs = SAILPOINT_DEMO_DURATION_MS,
  random: () => number = Math.random,
): number {
  let elapsed = 0;
  let count = 0;
  while (elapsed < durationMs && count < 10_000) {
    count += 1;
    elapsed += sailPointDemoDelayMs(random);
  }
  return count;
}
