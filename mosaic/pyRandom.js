/**
 * CPython 3 random.Random (MT19937), so RAND_SIZE jitter
 * matches mosaic.py after random.seed(0).
 */
const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PyRandom {
  constructor(seed = 0) {
    this.mt = new Uint32Array(N);
    this.mti = N;
    this.seed(seed);
  }

  seed(a) {
    const key = intToKey(a);
    this._initByArray(key);
  }

  _initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let mti = 1; mti < N; mti++) {
      mt[mti] =
        (Math.imul(1812433253, mt[mti - 1] ^ (mt[mti - 1] >>> 30)) + mti) >>> 0;
    }
    this.mti = N;
  }

  _initByArray(initKey) {
    this._initGenrand(19650218);
    const mt = this.mt;
    const keyLength = initKey.length;
    let i = 1;
    let j = 0;
    let k = N > keyLength ? N : keyLength;
    for (; k; k--) {
      mt[i] =
        ((mt[i] ^
          Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) +
          initKey[j] +
          j) >>>
        0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
      if (j >= keyLength) j = 0;
    }
    for (k = N - 1; k; k--) {
      mt[i] =
        ((mt[i] ^
          Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) -
          i) >>>
        0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  genrandInt32() {
    let y;
    const mag01 = [0, MATRIX_A];
    const mt = this.mt;
    if (this.mti >= N) {
      let kk;
      for (kk = 0; kk < N - M; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ mag01[y & 1];
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ mag01[y & 1];
      }
      y = (mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ mag01[y & 1];
      this.mti = 0;
    }
    y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  random() {
    const a = this.genrandInt32() >>> 5;
    const b = this.genrandInt32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  getrandbits(k) {
    if (k <= 32) return this.genrandInt32() >>> (32 - k);
    let acc = 0n;
    let shift = 0n;
    while (k > 0) {
      const take = k >= 32 ? 32 : k;
      const bits = BigInt(this.genrandInt32() >>> (32 - take));
      acc |= bits << shift;
      shift += BigInt(take);
      k -= take;
    }
    return Number(acc);
  }

  _randbelow(n) {
    if (n <= 0) return 0;
    const k = 32 - Math.clz32(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  randrange(start, stop) {
    const n = stop - start;
    return start + this._randbelow(n);
  }

  randint(a, b) {
    return this.randrange(a, b + 1);
  }

  uniform(a, b) {
    return a + (b - a) * this.random();
  }
}

function intToKey(a) {
  if (a === 0 || a === 0n) return [0];
  let n = BigInt(a);
  if (n < 0n) n = -n;
  const key = [];
  while (n > 0n) {
    key.push(Number(n & 0xffffffffn));
    n >>= 32n;
  }
  return key.length ? key : [0];
}

export const pyRandom = new PyRandom(0);
