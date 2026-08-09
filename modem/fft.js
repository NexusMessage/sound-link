// Iterative radix-2 FFT over split real/imaginary arrays. No dependencies, so
// the same file runs in the browser and in node.

const twiddleCache = new Map();

function twiddles(n) {
  let t = twiddleCache.get(n);
  if (t) return t;
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  t = { cos, sin };
  twiddleCache.set(n, t);
  return t;
}

function bitReverse(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
}

/** In-place forward FFT. Arrays must be the same power-of-two length. */
export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT length must be a power of two');
  bitReverse(re, im);
  const { cos, sin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** In-place inverse FFT, scaled by 1/n. */
export function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

/**
 * Cross-correlation of `signal` against `template`, computed through the
 * frequency domain. Returns the correlation magnitude for every offset, which
 * is what frame sync searches for a peak in.
 */
export function correlate(signal, template) {
  const need = signal.length + template.length;
  let n = 1;
  while (n < need) n <<= 1;

  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(signal);
  // Conjugate-reversed template turns convolution into correlation.
  for (let i = 0; i < template.length; i++) br[i] = template[template.length - 1 - i];

  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < n; i++) {
    const xr = ar[i] * br[i] - ai[i] * bi[i];
    const xi = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = xr;
    ai[i] = xi;
  }
  ifft(ar, ai);

  const out = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    const j = i + template.length - 1;
    out[i] = Math.abs(ar[j]);
  }
  return out;
}
