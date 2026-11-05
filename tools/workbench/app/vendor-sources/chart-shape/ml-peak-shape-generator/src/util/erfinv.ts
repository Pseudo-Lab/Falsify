// https://en.wikipedia.org/wiki/Error_function#Inverse_functions
// This code yields to a good approximation

// If needed a better implementation using polynomial can be found on https://en.wikipedia.org/wiki/Error_function#Inverse_functions

/**
 * Approximate inverse error function.
 * @param x - value in the range (-1, 1).
 * @returns erfinv(x).
 * @see https://en.wikipedia.org/wiki/Error_function#Inverse_functions
 */
export default function erfinv(x: number): number {
  const a = 0.147;
  if (x === 0) return 0;
  const ln1MinusXSqrd = Math.log(1 - x * x);
  const lnEtcBy2Plus2 = ln1MinusXSqrd / 2 + 2 / (Math.PI * a);
  const firstSqrt = Math.sqrt(lnEtcBy2Plus2 ** 2 - ln1MinusXSqrd / a);
  const secondSqrt = Math.sqrt(firstSqrt - lnEtcBy2Plus2);
  return secondSqrt * (x > 0 ? 1 : -1);
}
