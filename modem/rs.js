// Reed-Solomon over GF(256), the same field and generator ggwave and QR codes
// use. Systematic: the parity bytes are appended, so the payload stays readable
// in the encoded block.
//
// It corrects up to nsym/2 wrong bytes per block, wherever they sit. Paired with
// the interleaver below, a burst of errors caused by one bad patch of spectrum
// gets spread thinly across many blocks instead of destroying one.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a, b) => {
  if (b === 0) throw new Error('Division durch null in GF(256)');
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];
};

function polyMul(p, q) {
  const out = new Uint8Array(p.length + q.length - 1);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 0) continue;
    for (let j = 0; j < q.length; j++) out[i + j] ^= mul(p[i], q[j]);
  }
  return out;
}

function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

function generator(nsym) {
  let g = Uint8Array.from([1]);
  for (let i = 0; i < nsym; i++) g = polyMul(g, Uint8Array.from([1, EXP[i]]));
  return g;
}

const genCache = new Map();
function gen(nsym) {
  let g = genCache.get(nsym);
  if (!g) { g = generator(nsym); genCache.set(nsym, g); }
  return g;
}

/** Append `nsym` parity bytes to one block. */
export function encodeBlock(data, nsym) {
  const g = gen(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < g.length; j++) out[i + j] ^= mul(g[j], coef);
  }
  out.set(data);
  return out;
}

const pow2 = (i) => EXP[((i % 255) + 255) % 255];

function polyScale(p, x) {
  const out = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = mul(p[i], x);
  return out;
}

// Polynomials are stored highest power first, so addition aligns on the right.
function polyAdd(p, q) {
  const n = Math.max(p.length, q.length);
  const out = new Uint8Array(n);
  for (let i = 0; i < p.length; i++) out[i + n - p.length] ^= p[i];
  for (let i = 0; i < q.length; i++) out[i + n - q.length] ^= q[i];
  return out;
}

function syndromes(msg, nsym) {
  // A leading zero keeps the indices lining up with the classic formulation.
  const s = new Uint8Array(nsym + 1);
  for (let i = 0; i < nsym; i++) s[i + 1] = polyEval(msg, EXP[i]);
  return s;
}

/**
 * Forney syndromes: the syndromes with the known-bad positions divided out, so
 * Berlekamp-Massey only has to hunt for the errors nobody flagged.
 */
function forneySyndromes(synd, erasePos, msgLen) {
  const f = Array.from(synd.slice(1));
  for (const p of erasePos) {
    const x = pow2(msgLen - 1 - p);
    for (let j = 0; j < f.length - 1; j++) f[j] = mul(f[j], x) ^ f[j + 1];
  }
  return Uint8Array.from(f);
}

// `iterations` is how many syndromes are still in play (parity minus the
// erasures already accounted for); `offset` is where they start in the array,
// which differs between raw syndromes and Forney syndromes.
function errorLocator(synd, iterations, offset = 1) {
  let errLoc = Uint8Array.from([1]);
  let oldLoc = Uint8Array.from([1]);
  for (let i = 0; i < iterations; i++) {
    const K = i + offset;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= mul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    }
    oldLoc = Uint8Array.from([...oldLoc, 0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, div(1, delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  let lead = 0;
  while (lead < errLoc.length && errLoc[lead] === 0) lead++;
  return errLoc.slice(lead);
}

function errorPositions(errLoc, msgLen) {
  const expected = errLoc.length - 1;
  const pos = [];
  for (let i = 0; i < msgLen; i++) {
    if (polyEval(errLoc, pow2(-i)) === 0) pos.push(msgLen - 1 - i);
  }
  return pos.length === expected ? pos : null;
}

/**
 * Returns the corrected block, or null when the damage exceeds what the parity
 * can cover.
 *
 * `erasePos` are byte positions the receiver already knows are unreliable —
 * bits that arrived on a carrier the room had notched out. Knowing *where* the
 * damage is doubles what the same parity can repair: nsym erasures instead of
 * nsym/2 blind errors.
 */
export function decodeBlock(block, nsym, erasePos = []) {
  const msg = Uint8Array.from(block);
  const erasures = erasePos.filter((p) => p >= 0 && p < msg.length);
  if (erasures.length > nsym) return null;
  for (const p of erasures) msg[p] = 0;

  const synd = syndromes(msg, nsym);
  if (synd.every((v) => v === 0)) return msg;

  let positions;
  if (erasures.length > 0) {
    const fsynd = forneySyndromes(synd, erasures, msg.length);
    const errLoc = errorLocator(fsynd, nsym - erasures.length, 0);
    const errCount = errLoc.length - 1;
    if (errCount * 2 + erasures.length > nsym) return null;
    const found = errCount > 0 ? errorPositions(errLoc, msg.length) : [];
    if (!found) return null;
    positions = [...erasures, ...found];
  } else {
    const errLoc = errorLocator(synd, nsym);
    if ((errLoc.length - 1) * 2 > nsym) return null;

    positions = errorPositions(errLoc, msg.length);
    if (!positions) return null;
  }

  // Forney: how far off is each of the bytes we just located?
  const coefPos = positions.map((p) => msg.length - 1 - p);
  let errataLoc = Uint8Array.from([1]);
  for (const p of coefPos) {
    errataLoc = polyMul(errataLoc, polyAdd(Uint8Array.from([1]), Uint8Array.from([pow2(p), 0])));
  }

  // Error evaluator: the remainder of syndromes × locator, modulo x^(errs+1),
  // which is the last errs+1 coefficients of the product.
  const syndRev = Uint8Array.from(synd).reverse();
  const product = polyMul(syndRev, errataLoc);
  const keep = errataLoc.length; // errs + 1
  const errEval = product.slice(Math.max(0, product.length - keep));

  const X = coefPos.map((p) => pow2(p));
  for (let i = 0; i < X.length; i++) {
    const xiInv = div(1, X[i]);
    let prime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) prime = mul(prime, 1 ^ mul(xiInv, X[j]));
    }
    if (prime === 0) return null;
    const y = mul(X[i], polyEval(errEval, xiInv));
    msg[positions[i]] ^= div(y, prime);
  }

  // Confirm: a correction that leaves a non-zero syndrome was a guess.
  const check = syndromes(msg, nsym);
  if (!check.every((v) => v === 0)) return null;
  return msg;
}

// Exposed so the tests can check each stage on its own; nothing else uses it.
export const _internals = { syndromes, errorLocator, errorPositions, polyEval, pow2, EXP };

/**
 * Split into blocks, protect each, then interleave the bytes across all blocks
 * so that a burst of channel errors lands one byte deep in many blocks rather
 * than many bytes deep in one.
 */
export function encode(data, nsym, blockData = 64) {
  const blocks = [];
  for (let i = 0; i < data.length; i += blockData) {
    blocks.push(encodeBlock(data.subarray(i, Math.min(i + blockData, data.length)), nsym));
  }
  if (blocks.length === 0) blocks.push(encodeBlock(new Uint8Array(0), nsym));

  const maxLen = Math.max(...blocks.map((b) => b.length));
  const out = [];
  for (let i = 0; i < maxLen; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  return { bytes: Uint8Array.from(out), blocks: blocks.length, lengths: blocks.map((b) => b.length) };
}

/**
 * @param reliability optional per-byte confidence from the demodulator, in the
 *   same order as `bytes`. Where it is present, the decoder flags its least
 *   trustworthy bytes as erasures — each worth twice as much as a blind
 *   correction — and retries with several amounts of flagging, because how far
 *   to trust the confidence depends on the channel and cannot be fixed in
 *   advance.
 */
export function decode(bytes, nsym, lengths, reliability = null) {
  const blocks = lengths.map((len) => new Uint8Array(len));
  const conf = lengths.map((len) => (reliability ? new Float64Array(len) : null));
  const maxLen = Math.max(...lengths);
  let c = 0;
  for (let i = 0; i < maxLen; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < lengths[b]) {
        blocks[b][i] = bytes[c];
        // De-interleaving carries the confidence along with the bytes.
        if (reliability) conf[b][i] = reliability[c];
        c++;
      }
    }
  }

  const out = [];
  let repaired = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];

    let ranked = null;
    if (conf[bi]) {
      ranked = Array.from(conf[bi].keys()).sort((x, y) => conf[bi][x] - conf[bi][y]);
    }
    // Every flagged byte spends one parity byte and every unflagged error
    // spends two, so the ladder walks from trusting the confidence heavily
    // down to ignoring it entirely.
    const ladder = ranked ? [Math.floor(nsym * 0.75), Math.floor(nsym * 0.5), Math.floor(nsym * 0.25), 0] : [0];

    let fixed = null;
    for (const count of ladder) {
      const erase = count > 0 ? ranked.slice(0, Math.min(count, b.length)) : [];
      fixed = decodeBlock(b, nsym, erase);
      if (fixed) break;
    }
    if (!fixed) return null;

    let diff = 0;
    for (let i = 0; i < b.length; i++) if (b[i] !== fixed[i]) diff++;
    repaired += diff;
    for (let i = 0; i < b.length - nsym; i++) out.push(fixed[i]);
  }
  return { bytes: Uint8Array.from(out), repaired };
}
