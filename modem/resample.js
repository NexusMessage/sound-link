// Block-wise resampling between the device's sample rate and the modem's fixed
// internal one.
//
// The whole difficulty is the seam. Interpolating inside each block on its own
// loses the sample at every boundary, and one lost sample per 4096 is a 244 ppm
// timing error — larger than the clock difference between two phones, and on
// its own enough to stop anything decoding. So the last sample of the previous
// block survives as virtual index 0, and the fractional read position carries
// across the boundary.

export class Resampler {
  constructor(fromRate, toRate) {
    this.step = fromRate / toRate;
    this.pos = 0;
    this.tail = 0;
  }

  reset() {
    this.pos = 0;
    this.tail = 0;
  }

  /** Feed one block; `emit` is called once per output sample. */
  push(block, emit) {
    const at = (i) => (i === 0 ? this.tail : block[i - 1]);
    let p = this.pos;
    while (p < block.length) {
      const k = Math.floor(p);
      const f = p - k;
      emit(at(k) * (1 - f) + at(k + 1) * f);
      p += this.step;
    }
    this.pos = p - block.length;
    this.tail = block[block.length - 1];
  }
}
