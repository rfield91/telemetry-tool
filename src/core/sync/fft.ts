/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]!
      re[i] = re[j]!
      re[j] = tr
      const ti = im[i]!
      im[i] = im[j]!
      im[j] = ti
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    const half = size >> 1
    for (let start = 0; start < n; start += size) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k += 1) {
        const a = start + k
        const b = a + half
        const tr = re[b]! * cr - im[b]! * ci
        const ti = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - tr
        im[b] = im[a]! - ti
        re[a] = re[a]! + tr
        im[a] = im[a]! + ti
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] = re[i]! / n
      im[i] = im[i]! / n
    }
  }
}

export function nextPowerOfTwo(n: number): number {
  let size = 1
  while (size < n) size <<= 1
  return size
}

interface Spectrum {
  re: Float64Array
  im: Float64Array
}

function spectrum(values: Float64Array, size: number): Spectrum {
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  re.set(values)
  fft(re, im)
  return { re, im }
}

/** C[L] = Σ_i a[i]·b[i+L] from spectra, indexed by L + aLength - 1. */
function correlateSpectra(a: Spectrum, b: Spectrum, aLength: number, bLength: number): Float64Array {
  const size = a.re.length
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  // conj(A) · B
  for (let k = 0; k < size; k += 1) {
    re[k] = a.re[k]! * b.re[k]! + a.im[k]! * b.im[k]!
    im[k] = a.re[k]! * b.im[k]! - a.im[k]! * b.re[k]!
  }
  fft(re, im, true)
  const out = new Float64Array(aLength + bLength - 1)
  for (let lag = -(aLength - 1); lag < bLength; lag += 1) {
    out[lag + aLength - 1] = re[lag >= 0 ? lag : size + lag]!
  }
  return out
}

/**
 * Cross-correlation sums C[L] = Σ_i a[i]·b[i+L] for every lag
 * L ∈ [-(a.length-1), b.length-1], returned with index `L + a.length - 1`.
 */
export function crossCorrelate(a: Float64Array, b: Float64Array): Float64Array {
  const size = nextPowerOfTwo(a.length + b.length)
  return correlateSpectra(spectrum(a, size), spectrum(b, size), a.length, b.length)
}

/**
 * The six lag sums needed for a Pearson correlation that ignores missing
 * samples (NaN) in either signal: overlap count and the sums of a, b, a², b²
 * and a·b over the samples present in both.
 */
export function maskedLagSums(a: Float64Array, b: Float64Array) {
  const size = nextPowerOfTwo(a.length + b.length)
  const split = (values: Float64Array) => {
    const mask = new Float64Array(values.length)
    const clean = new Float64Array(values.length)
    const squared = new Float64Array(values.length)
    values.forEach((v, i) => {
      if (Number.isNaN(v)) return
      mask[i] = 1
      clean[i] = v
      squared[i] = v * v
    })
    return { mask: spectrum(mask, size), clean: spectrum(clean, size), squared: spectrum(squared, size) }
  }
  const sa = split(a)
  const sb = split(b)
  const c = (x: Spectrum, y: Spectrum) => correlateSpectra(x, y, a.length, b.length)
  return {
    count: c(sa.mask, sb.mask),
    sumA: c(sa.clean, sb.mask),
    sumB: c(sa.mask, sb.clean),
    sumA2: c(sa.squared, sb.mask),
    sumB2: c(sa.mask, sb.squared),
    sumAB: c(sa.clean, sb.clean),
  }
}
