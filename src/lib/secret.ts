const encoder = new TextEncoder();

/** Constant-time string compare (hashing first so lengths always match). Same as openrace-api. */
export async function secretsMatch(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(a)), crypto.subtle.digest("SHA-256", encoder.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
