/** Order fulfillment / lifecycle (payment state is on paymentStatus). */
export const OrderStatus = {
  PENDING_PAYMENT: "PENDING_PAYMENT",
  PROCESSING: "PROCESSING",
  /** Packed / ready to ship — between processing and shipped */
  PACKED: "PACKED",
  SHIPPED: "SHIPPED",
  DELIVERED: "DELIVERED",
  /** Customer requested return after delivery */
  RETURN_REQUESTED: "RETURN_REQUESTED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
  /** Legacy rows may still use this value */
  LEGACY_PENDING: "pending",
} as const;

export type OrderStatusValue = (typeof OrderStatus)[keyof typeof OrderStatus];

export const PaymentStatus = {
  PENDING: "pending",
  PAID: "paid",
  FAILED: "failed",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "partially_refunded",
} as const;

export type PaymentStatusValue =
  (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** Map legacy lowercase / alternate labels → canonical statuses. */
const STATUS_ALIASES: Record<string, string> = {
  pending: OrderStatus.LEGACY_PENDING,
  pending_payment: OrderStatus.PENDING_PAYMENT,
  processing: OrderStatus.PROCESSING,
  confirmed: OrderStatus.PROCESSING,
  packed: OrderStatus.PACKED,
  shipped: OrderStatus.SHIPPED,
  delivered: OrderStatus.DELIVERED,
  return_requested: OrderStatus.RETURN_REQUESTED,
  cancelled: OrderStatus.CANCELLED,
  canceled: OrderStatus.CANCELLED,
  failed: OrderStatus.FAILED,
};

/**
 * Normalize free-form / legacy status strings to canonical values used in writes.
 * Existing DB rows may still be lowercase; transitions accept both.
 */
export function normalizeOrderStatus(status: string): string {
  if (!status) return status;
  if (
    status === OrderStatus.PENDING_PAYMENT ||
    status === OrderStatus.PROCESSING ||
    status === OrderStatus.PACKED ||
    status === OrderStatus.SHIPPED ||
    status === OrderStatus.DELIVERED ||
    status === OrderStatus.RETURN_REQUESTED ||
    status === OrderStatus.CANCELLED ||
    status === OrderStatus.FAILED
  ) {
    return status;
  }
  const lower = status.toLowerCase();
  return STATUS_ALIASES[lower] ?? status;
}

/**
 * Allowed admin/customer status transitions (ecommerce fulfillment).
 * Payment flips PENDING_PAYMENT → PROCESSING via payment success, not this map.
 * Keys include legacy lowercase values found in older rows.
 */
export const ORDER_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  [OrderStatus.PENDING_PAYMENT]: [
    OrderStatus.PROCESSING,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ],
  [OrderStatus.LEGACY_PENDING]: [
    OrderStatus.PROCESSING,
    OrderStatus.PACKED,
    OrderStatus.SHIPPED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PROCESSING]: [
    OrderStatus.PACKED,
    OrderStatus.SHIPPED,
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PACKED]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [OrderStatus.RETURN_REQUESTED],
  [OrderStatus.RETURN_REQUESTED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.FAILED]: [],
  // Legacy lowercase rows in older data (pending covered by LEGACY_PENDING)
  processing: [OrderStatus.PACKED, OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  confirmed: [OrderStatus.PACKED, OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  packed: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  shipped: [OrderStatus.DELIVERED],
  delivered: [OrderStatus.RETURN_REQUESTED],
  return_requested: [],
  cancelled: [],
  canceled: [],
  failed: [],
};

export function canTransitionOrderStatus(from: string, to: string): boolean {
  const allowed = ORDER_STATUS_TRANSITIONS[from] ?? [];
  const normalizedTo = normalizeOrderStatus(to);
  return (
    allowed.includes(to) ||
    allowed.includes(normalizedTo) ||
    allowed.map((s) => s.toLowerCase()).includes(normalizedTo.toLowerCase())
  );
}

export const OrderEventType = {
  STATUS_CHANGED: "status_changed",
  PAYMENT_RECORDED: "payment_recorded",
  PAYMENT_STATUS_CHANGED: "payment_status_changed",
  REFUND_REQUESTED: "refund_requested",
  NOTE_ADDED: "note_added",
  CUSTOMER_CONTACTED: "customer_contacted",
  AUTO_DELIVERED: "auto_delivered",
  CANCELLED: "cancelled",
  RETURN_REQUESTED: "return_requested",
} as const;
