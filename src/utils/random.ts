/**
 * Deterministic Pseudo-Random Number Generator using Mulberry32.
 * Ensures that stroke generation and jitter rendering are fully reproducible given a seed.
 */
export class SeededRandom {
  private state: number;

  constructor(seed = 123456789) {
    this.state = seed >>> 0;
  }

  /**
   * Returns a float between 0 (inclusive) and 1 (exclusive).
   */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Returns a float in range [min, max).
   */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /**
   * Returns an integer in range [min, max] inclusive.
   */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /**
   * Returns random value with normal-like distribution (Box-Muller transform).
   */
  gaussian(mean = 0, stdDev = 1): number {
    const u1 = Math.max(1e-7, this.next());
    const u2 = this.next();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return mean + z0 * stdDev;
  }
}
