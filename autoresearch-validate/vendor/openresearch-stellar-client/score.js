export const BIPS_DENOMINATOR = 10000n;
export const MAX_BIPS = 10_000;
export const MAX_METRIC_SCALE = 4294967295n;
export const I128_MIN = -(1n << 127n);
export const I128_MAX = (1n << 127n) - 1n;
export function scaleMetric(metric, scale, direction) {
    if (scale <= 0n || scale > MAX_METRIC_SCALE) {
        throw new RangeError("metric scale is outside the contract bounds");
    }
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(metric.trim());
    if (!match)
        throw new TypeError("metric must be a base-10 decimal string");
    const sign = match[1] === "-" ? -1n : 1n;
    const whole = match[2];
    const fraction = match[3] ?? "";
    const denominator = 10n ** BigInt(fraction.length);
    const numerator = BigInt(`${whole}${fraction}`) * sign;
    const scaledNumerator = numerator * scale;
    if (scaledNumerator % denominator !== 0n) {
        throw new RangeError("metric cannot be represented exactly at this scale");
    }
    const scaled = scaledNumerator / denominator;
    const directed = direction === "minimize" ? -scaled : scaled;
    assertI128(directed);
    return directed;
}
export function improvementThreshold(incumbent, improvementBips) {
    assertI128(incumbent);
    assertImprovementBips(improvementBips);
    if (improvementBips === 0)
        return incumbent;
    const product = checkedMultiply(checkedAbs(incumbent), BigInt(improvementBips));
    const margin = product / BIPS_DENOMINATOR;
    return checkedAdd(incumbent, margin);
}
export function isSufficient(score, incumbent, improvementBips) {
    assertI128(score);
    assertI128(incumbent);
    assertImprovementBips(improvementBips);
    return improvementBips === 0
        ? score > incumbent
        : score >= improvementThreshold(incumbent, improvementBips);
}
export function assertI128(score) {
    if (score < I128_MIN || score > I128_MAX) {
        throw new RangeError("score is outside i128");
    }
}
function assertImprovementBips(improvementBips) {
    if (!Number.isInteger(improvementBips) ||
        improvementBips < 0 ||
        improvementBips > MAX_BIPS) {
        throw new RangeError("improvement basis points are outside contract bounds");
    }
}
function abs(value) {
    return value < 0n ? -value : value;
}
function checkedAbs(value) {
    if (value === I128_MIN) {
        throw new RangeError("i128 absolute-value overflow");
    }
    return abs(value);
}
function checkedMultiply(left, right) {
    const product = left * right;
    assertI128(product);
    return product;
}
function checkedAdd(left, right) {
    const sum = left + right;
    assertI128(sum);
    return sum;
}
