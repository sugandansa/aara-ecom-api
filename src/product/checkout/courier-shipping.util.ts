import {
  FREE_SHIPPING_MIN_MERCHANDISE,
  DEFAULT_CHECKOUT_SHIPPING_FLAT,
} from "./checkout.constants";
import {
  isMassUnit,
  isVolumeUnit,
  parsePackLabelToBaseUnits,
  parsePiecePackCount,
  toBaseUnits,
} from "../products/product-stock-pool.util";

/** Fallback kg per piece when pack has no mass/volume label (bottles etc.). */
export const DEFAULT_PIECE_WEIGHT_KG = 0.1;

export type CourierStateRow = {
  name: string;
  code: string;
};

export type CourierRateRuleRow = {
  minWeight: number;
  maxWeight: number | null;
  ratePerKg: number;
  freeShipping: boolean;
};

export type CourierForShipping = {
  id: number;
  name: string;
  code: string;
  status: string;
  states: CourierStateRow[];
  rateRules: CourierRateRuleRow[];
};

export type ShippingQuote = {
  shipping: number;
  weightKg: number;
  courierId: number | null;
  courierCode: string | null;
  courierName: string | null;
  matchedState: string | null;
  source: "courier_rate" | "free_merchandise" | "flat_fallback" | "zero_empty";
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Normalize "Tamil Nadu" / "Tamilnadu" / "TN" for matching. */
export function normalizeStateKey(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/pradesh$/g, "")
    .replace(/nadu$/g, "nadu");
}

/**
 * Estimate line weight in kg from pack label / packSize / piece multiplicity.
 */
export function estimateLineWeightKg(opts: {
  quantity: number;
  variantName?: string | null;
  packSize?: {
    size: { toString(): string } | number;
    unit: string;
    label: string;
  } | null;
  stockUnit?: string | null;
}): number {
  const qty = Number(opts.quantity);
  if (!Number.isFinite(qty) || qty <= 0) return 0;

  const fromLabel =
    parsePackLabelToBaseUnits(opts.variantName) ??
    parsePackLabelToBaseUnits(opts.packSize?.label);

  if (fromLabel != null && fromLabel > 0) {
    // parsePackLabelToBaseUnits returns g or ml. Treat both as ~kg via /1000.
    const label = (
      opts.variantName ||
      opts.packSize?.label ||
      ""
    ).toLowerCase();
    if (/\b(kg|g)\b/.test(label) || isMassUnit(opts.packSize?.unit)) {
      return round3((qty * fromLabel) / 1000);
    }
    if (/\b(l|ml)\b/.test(label) || isVolumeUnit(opts.packSize?.unit)) {
      // Approximate 1 L ≈ 1 kg for shipping.
      return round3((qty * fromLabel) / 1000);
    }
    return round3((qty * fromLabel) / 1000);
  }

  if (opts.packSize) {
    const size = Number(opts.packSize.size);
    if (Number.isFinite(size) && size > 0) {
      if (isMassUnit(opts.packSize.unit)) {
        return round3((qty * toBaseUnits(size, opts.packSize.unit)) / 1000);
      }
      if (isVolumeUnit(opts.packSize.unit)) {
        return round3((qty * toBaseUnits(size, opts.packSize.unit)) / 1000);
      }
    }
  }

  const pieces =
    parsePiecePackCount(opts.variantName) ??
    parsePiecePackCount(opts.packSize?.label) ??
    1;
  return round3(qty * pieces * DEFAULT_PIECE_WEIGHT_KG);
}

export function estimateCartWeightKg(
  lines: Array<{
    quantity: number;
    variantName?: string | null;
    packSize?: {
      size: { toString(): string } | number;
      unit: string;
      label: string;
    } | null;
    stockUnit?: string | null;
  }>,
): number {
  const total = lines.reduce(
    (sum, line) => sum + estimateLineWeightKg(line),
    0,
  );
  return round3(total);
}

export function findCourierForState(
  couriers: CourierForShipping[],
  state: string | null | undefined,
): { courier: CourierForShipping; matchedState: string } | null {
  const key = normalizeStateKey(state);
  if (!key) return null;

  const active = couriers.filter(
    (c) => (c.status || "").toUpperCase() === "ACTIVE",
  );

  for (const courier of active) {
    for (const s of courier.states) {
      const nameKey = normalizeStateKey(s.name);
      const codeKey = normalizeStateKey(s.code);
      if (
        nameKey === key ||
        codeKey === key ||
        nameKey.includes(key) ||
        key.includes(nameKey)
      ) {
        return { courier, matchedState: s.name };
      }
    }
  }
  return null;
}

export function pickRateRule(
  rules: CourierRateRuleRow[],
  weightKg: number,
): CourierRateRuleRow | null {
  if (!rules.length) return null;
  const w = Math.max(0, weightKg);
  const sorted = [...rules].sort((a, b) => a.minWeight - b.minWeight);

  for (const rule of sorted) {
    const max = rule.maxWeight;
    if (w + 1e-9 >= rule.minWeight && (max == null || w <= max + 1e-9)) {
      return rule;
    }
  }

  // Over max band: use last open-ended or highest band.
  const open = [...sorted].reverse().find((r) => r.maxWeight == null);
  return open ?? sorted[sorted.length - 1] ?? null;
}

/**
 * Compute shipping from courier rate card for a destination state + cart weight.
 * Merchandise ≥ FREE_SHIPPING_MIN_MERCHANDISE always ships free.
 */
export function quoteCourierShipping(opts: {
  state?: string | null;
  weightKg: number;
  merchandiseTotal: number;
  couriers: CourierForShipping[];
  flatFallback?: number;
}): ShippingQuote {
  const flat = opts.flatFallback ?? DEFAULT_CHECKOUT_SHIPPING_FLAT;
  const weightKg = round3(Math.max(0, Number(opts.weightKg) || 0));

  if (opts.merchandiseTotal >= FREE_SHIPPING_MIN_MERCHANDISE) {
    return {
      shipping: 0,
      weightKg,
      courierId: null,
      courierCode: null,
      courierName: null,
      matchedState: null,
      source: "free_merchandise",
    };
  }

  if (weightKg <= 0 && !opts.state) {
    return {
      shipping: 0,
      weightKg: 0,
      courierId: null,
      courierCode: null,
      courierName: null,
      matchedState: null,
      source: "zero_empty",
    };
  }

  const match = findCourierForState(opts.couriers, opts.state);
  if (!match) {
    return {
      shipping: flat,
      weightKg,
      courierId: null,
      courierCode: null,
      courierName: null,
      matchedState: null,
      source: "flat_fallback",
    };
  }

  const billableWeight = weightKg > 0 ? weightKg : DEFAULT_PIECE_WEIGHT_KG;
  const rule = pickRateRule(match.courier.rateRules, billableWeight);
  if (!rule) {
    return {
      shipping: flat,
      weightKg: billableWeight,
      courierId: match.courier.id,
      courierCode: match.courier.code,
      courierName: match.courier.name,
      matchedState: match.matchedState,
      source: "flat_fallback",
    };
  }

  if (rule.freeShipping) {
    return {
      shipping: 0,
      weightKg: billableWeight,
      courierId: match.courier.id,
      courierCode: match.courier.code,
      courierName: match.courier.name,
      matchedState: match.matchedState,
      source: "courier_rate",
    };
  }

  // ratePerKg is the slab charge for the matched weight band (admin rate card).
  const shipping = round2(Number(rule.ratePerKg || 0));

  return {
    shipping,
    weightKg: billableWeight,
    courierId: match.courier.id,
    courierCode: match.courier.code,
    courierName: match.courier.name,
    matchedState: match.matchedState,
    source: "courier_rate",
  };
}
