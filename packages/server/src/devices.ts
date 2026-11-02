// Named virtual devices: VENEER01, VENEER02, ... instead of QPADEVxxxx, so
// operators can tell Veneer jobs apart (WRKACTJOB, WRKCFGSTS).

/** How long to skip a name the host said is in use (e.g. by a leftover job). */
const AVOID_MS = 10 * 60_000;

/** Device names start with a letter; IBM i takes 10 characters, a VTAM LU 8. */
const NAME_START = /^[A-Z][A-Z0-9]*$/;

export class DeviceNamePool {
  readonly prefix: string;
  readonly digits: number;
  readonly capacity: number;
  private readonly inUse = new Set<number>();
  /** Names in use outside this pool, by number, until a time. */
  private readonly avoided = new Map<number, number>();

  /** `maxLength` is the longest name the host takes: 10 on IBM i, 8 for a 3270 LU. */
  constructor(prefix: string, maxLength = 10) {
    const p = prefix.toUpperCase();
    if (!NAME_START.test(p) || p.length > maxLength - 2) {
      throw new Error(`Device name prefix "${prefix}" must be 1-${maxLength - 2} letters/digits starting with a letter`);
    }
    this.prefix = p;
    // Fill the name with digits, but no more than 3 (999 devices).
    this.digits = Math.min(3, maxLength - p.length);
    this.capacity = 10 ** this.digits - 1;
  }

  /** The lowest free name, or undefined when every name is taken. */
  acquire(): string | undefined {
    const now = Date.now();
    for (let n = 1; n <= this.capacity; n++) {
      if (!this.inUse.has(n) && (this.avoided.get(n) ?? 0) <= now) {
        this.avoided.delete(n);
        this.inUse.add(n);
        return this.prefix + String(n).padStart(this.digits, '0');
      }
    }
    return undefined;
  }

  release(name: string): void {
    if (!name.startsWith(this.prefix)) return;
    this.inUse.delete(Number(name.slice(this.prefix.length)));
  }

  /** The host says this name is in use elsewhere: give it back and skip it for a while. */
  avoid(name: string, ms = AVOID_MS): void {
    if (!name.startsWith(this.prefix)) return;
    const n = Number(name.slice(this.prefix.length));
    this.inUse.delete(n);
    this.avoided.set(n, Date.now() + ms);
  }

  get size(): number {
    return this.inUse.size;
  }
}
