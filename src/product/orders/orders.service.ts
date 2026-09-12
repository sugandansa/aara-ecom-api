import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Coupon } from "@prisma/client";
import { randomUUID } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  OrderStatus,
  PaymentStatus,
  OrderEventType,
  normalizeOrderStatus,
} from "../constants/order-status";
import { CreateOrderDto } from "../dto/order.dto";
import type { ReturnOrderDto } from "../dto/order.dto";
import { AdminUpdateOrderDto } from "../../admin/dto/admin.dto";
import {
  computeCheckoutTotals,
  toCartLineInputs,
  extractInclusiveTax,
} from "../checkout/checkout-pricing.util";
import { assertCouponUsable } from "../checkout/assert-coupon-usable";
import { DEFAULT_CHECKOUT_SHIPPING_FLAT } from "../checkout/checkout.constants";
import {
  affectedRowsCount,
  quoteSqlIdentifier,
  stringContainsFilter,
} from "../../common/database-provider.util";
import {
  unitsToConsume,
  poolAvailableInBase,
  unitsToDeductFromStoredPool,
} from "../products/product-stock-pool.util";
import {
  recordSaleTransactions,
  recordStockMovement,
  type SaleLineInput,
} from "../products/inventory-ledger";

/** Standard relation graph for storefront order responses. */
const orderDetailInclude = {
  items: {
    include: {
      variant: {
        select: {
          id: true,
          product: { select: { hsnCode: true, taxPercent: true } },
        },
      },
    },
  },
  payments: true,
  shipments: true,
} as const;

/** `adminFindAll` + `include.customer` — Prisma MariaDB typings omit nested includes on some models. */
type AdminOrderCsvRow = {
  orderNumber: string;
  customer: { name: string; email: string; phone: string | null };
  status: string;
  paymentStatus: string;
  totalAmount: unknown;
  taxAmount: unknown;
  shippingAmount: unknown;
  trackingId: string | null;
  notes: string | null;
  createdAt: Date;
};

const cartForPlaceOrderInclude = {
  items: {
    include: {
      variant: { include: { packSize: true, product: true } },
    },
  },
} as const;

export type PlaceOrderParams = {
  customerId: number;
  cartId: number;
  shippingAddressId?: number;
  couponCode?: string | null;
  /** ONLINE = reserve stock until payment; COD = deduct immediately */
  paymentMethod: "ONLINE" | "COD";
  idempotencyKey?: string | null;
  shippingFlat: number;
  /** Snapshot from checkout when DB row is not loaded in this call */
  couponPricing?: {
    percentOff: Prisma.Decimal | null;
    maxDiscountAmount: Prisma.Decimal | null;
    minOrderAmount: Prisma.Decimal | null;
  } | null;
};

type CartForPlaceOrder = Prisma.CartGetPayload<{
  include: typeof cartForPlaceOrderInclude;
}>;

/** DB coupon row or checkout snapshot — both expose pricing fields for totals. */
type OrderPricingSource =
  | Coupon
  | NonNullable<PlaceOrderParams["couponPricing"]>;

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Legacy: create order from cart (server-priced, ONLINE checkout with reservation).
   */
  async create(dto: CreateOrderDto) {
    return this.placeOrder({
      customerId: dto.customerId,
      cartId: dto.cartId,
      paymentMethod: "ONLINE",
      shippingFlat: this.getShippingFlat(),
      couponPricing: null,
    });
  }

  async placeOrder(params: PlaceOrderParams) {
    const {
      customerId,
      cartId,
      shippingAddressId,
      couponCode,
      paymentMethod,
      idempotencyKey,
      shippingFlat,
      couponPricing: couponPricingFromCaller,
    } = params;

    const idempotentHit = await this.findOrderByIdempotencyKey(
      customerId,
      idempotencyKey,
    );
    if (idempotentHit) {
      return idempotentHit;
    }

    const cart = await this.loadCartForPlaceOrder(cartId, customerId);

    const couponRow = await this.loadCouponRowIfCodePresent(couponCode);
    const pricingSource: OrderPricingSource | null =
      couponRow ?? couponPricingFromCaller ?? null;

    const discountPercent = decimalToNumberOrUndefined(
      pricingSource?.percentOff,
    );

    const lines = toCartLineInputs(cart.items);
    const totals = computeCheckoutTotals(lines, {
      shippingFlat,
      discountPercent,
      maxDiscountAmount: decimalToNumberOrNull(
        pricingSource?.maxDiscountAmount,
      ),
      minOrderAmount: decimalToNumberOrNull(pricingSource?.minOrderAmount),
    });

    this.assertSubtotalMeetsCouponMinimum(totals.subtotal, pricingSource);

    await this.validateStockForCheckout(cart.items, paymentMethod);

    const { snapshot, shippingId } = await this.resolveShippingSnapshot(
      shippingAddressId,
      customerId,
    );

    const orderNumber = this.generateOrderNumber();

    return this.prisma.$transaction(async (tx) => {
      const stockDelta = await this.applyInventoryForPaymentMode(
        tx,
        cart.items,
        paymentMethod,
      );

      const created = await tx.order.create({
        data: {
          customerId,
          orderNumber,
          status:
            paymentMethod === "COD"
              ? OrderStatus.PROCESSING
              : OrderStatus.PENDING_PAYMENT,
          totalAmount: totals.total,
          taxAmount: totals.tax,
          shippingAmount: totals.shipping,
          discountAmount: totals.discount,
          ...(discountPercent != null ? { discountPercent } : {}),
          couponCode:
            couponCode?.trim().toUpperCase() ?? couponRow?.code ?? null,
          paymentStatus: "pending",
          shippingAddressId: shippingId ?? null,
          ...(snapshot !== undefined ? { addressSnapshot: snapshot } : {}),
          items: {
            create: totals.items.map((pl) => ({
              variantId: pl.variantId,
              productName: pl.productName,
              sizeLabel: pl.sizeLabel,
              hsnCode: pl.hsnCode ?? null,
              taxPercent: pl.taxPercent,
              taxAmount: pl.taxAmount,
              price: pl.unitPrice,
              quantity: pl.quantity,
              subtotal: pl.lineSubtotal,
            })),
          },
        },
        include: {
          items: {
            include: {
              variant: {
                include: {
                  packSize: true,
                  product: {
                    select: { id: true, stockUnit: true, taxPercent: true },
                  },
                },
              },
            },
          },
          payments: true,
          shipments: true,
        },
      });

      if (paymentMethod === "COD" && stockDelta.size > 0) {
        await this.writeSaleLedger(tx, {
          orderId: created.id,
          paymentMethod: "COD",
          items: created.items,
          stockByProduct: stockDelta,
        });
      }

      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      if (idempotencyKey) {
        await tx.checkoutIdempotency.create({
          data: {
            customerId,
            key: idempotencyKey,
            orderId: created.id,
          },
        });
      }

      await tx.checkoutSession.deleteMany({ where: { customerId } });

      return this.mapOrderDetail(created);
    });
  }

  /**
   * After a successful payment: commit reserved units to stock for ONLINE orders,
   * or only flip payment flags for COD / already-deducted flows.
   */
  async applyPaymentSuccess(orderId: number) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: {
            include: {
              variant: {
                include: {
                  packSize: true,
                  product: {
                    select: { id: true, stockUnit: true },
                  },
                },
              },
            },
          },
        },
      });
      if (!order) throw new NotFoundException(`Order #${orderId} not found`);
      if (order.paymentStatus === "paid") {
        return tx.order.findUnique({
          where: { id: orderId },
          include: orderDetailInclude,
        });
      }

      if (order.status === OrderStatus.PENDING_PAYMENT) {
        const byProduct = this.aggregateProductPoolUnits(
          order.items.map((item) => ({
            productId: item.variant.product.id,
            stockUnit: item.variant.product.stockUnit,
            quantity: item.quantity,
            packSize: item.variant.packSize,
            variantName: item.variant.variantName,
          })),
        );
        const stockByProduct = new Map<
          number,
          {
            units: number;
            stockBefore: number;
            stockAfter: number;
            reservedBefore: number;
            reservedAfter: number;
          }
        >();
        const T = quoteSqlIdentifier("Product");
        const stockCol = quoteSqlIdentifier("stock");
        const reservedCol = quoteSqlIdentifier("reservedStock");
        for (const [productId, neededBase] of byProduct) {
          const before = await tx.product.findUniqueOrThrow({
            where: { id: productId },
            select: { stock: true, reservedStock: true, stockUnit: true },
          });
          const units = unitsToDeductFromStoredPool(
            neededBase,
            before.stockUnit,
          );
          const rowsAffected = await tx.$executeRawUnsafe(
            `UPDATE ${T} SET ${stockCol} = ${stockCol} - ?, ${reservedCol} = ${reservedCol} - ? WHERE id = ? AND ${reservedCol} >= ? AND ${stockCol} >= ?`,
            units,
            units,
            productId,
            units,
            units,
          );
          if (affectedRowsCount(rowsAffected) !== 1) {
            throw new BadRequestException(
              `Inventory commit failed for product #${productId}`,
            );
          }
          const after = await tx.product.findUniqueOrThrow({
            where: { id: productId },
            select: { stock: true, reservedStock: true },
          });
          stockByProduct.set(productId, {
            units,
            stockBefore: before.stock,
            stockAfter: after.stock,
            reservedBefore: before.reservedStock,
            reservedAfter: after.reservedStock,
          });
        }

        await this.writeSaleLedger(tx, {
          orderId: order.id,
          paymentMethod: "ONLINE",
          items: order.items,
          stockByProduct,
        });

        return tx.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.PROCESSING, paymentStatus: "paid" },
          include: orderDetailInclude,
        });
      }

      return tx.order.update({
        where: { id: orderId },
        data: { paymentStatus: "paid" },
        include: orderDetailInclude,
      });
    });
  }

  async cancel(orderId: number, customerId: number) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            variant: {
              include: {
                packSize: true,
                product: { select: { id: true, stockUnit: true } },
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException(`Order #${orderId} not found`);
    if (order.customerId !== customerId) {
      throw new ForbiddenException("Not your order");
    }

    const status = normalizeOrderStatus(order.status);
    if (
      status === OrderStatus.CANCELLED ||
      order.status === "cancelled" ||
      order.status === "canceled"
    ) {
      return { status: 200, message: "Order cancelled successfully" };
    }

    const cancellable = new Set([
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PROCESSING,
      OrderStatus.PACKED,
      OrderStatus.LEGACY_PENDING,
      "processing",
      "confirmed",
      "packed",
      "pending",
    ]);
    if (!cancellable.has(order.status) && !cancellable.has(status)) {
      throw new BadRequestException(
        "Only orders that are not yet shipped can be cancelled. Use return for delivered orders.",
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.releaseStockOnCustomerCancel(tx, order);
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELLED },
      });
      await tx.orderEvent.create({
        data: {
          orderId,
          type: OrderEventType.CANCELLED,
          label: "Order cancelled by customer",
          detail: null,
          actorType: "customer",
          actorName: `customer#${customerId}`,
          metadata: { previousStatus: order.status },
        },
      });
    });

    return { status: 200, message: "Order cancelled successfully" };
  }

  async requestReturn(
    orderId: number,
    customerId: number,
    dto: ReturnOrderDto,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { refunds: { orderBy: { id: "desc" }, take: 5 } },
    });
    if (!order) throw new NotFoundException(`Order #${orderId} not found`);
    if (order.customerId !== customerId) {
      throw new ForbiddenException("Not your order");
    }

    const status = normalizeOrderStatus(order.status);
    if (status !== OrderStatus.DELIVERED && order.status !== "delivered") {
      throw new BadRequestException("Only delivered orders can be returned");
    }

    if (
      status === OrderStatus.RETURN_REQUESTED ||
      order.refunds.some((r) =>
        ["requested", "approved"].includes(r.status.toLowerCase()),
      )
    ) {
      throw new BadRequestException(
        "A return/refund request already exists for this order",
      );
    }

    const reasonText = `${dto.reason}: ${dto.description.trim()}`;

    await this.prisma.$transaction(async (tx) => {
      const refund = await tx.orderRefund.create({
        data: {
          orderId,
          amount: order.totalAmount,
          reason: reasonText,
          status: "requested",
          items: {
            reason: dto.reason,
            description: dto.description.trim(),
            source: "customer",
          } as Prisma.InputJsonValue,
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.RETURN_REQUESTED },
      });

      await tx.orderEvent.create({
        data: {
          orderId,
          type: OrderEventType.RETURN_REQUESTED,
          label: "Return requested by customer",
          detail: reasonText,
          actorType: "customer",
          actorName: `customer#${customerId}`,
          metadata: {
            refundId: refund.id,
            reason: dto.reason,
            description: dto.description.trim(),
          },
        },
      });
    });

    return { status: 200, message: "Return requested successfully" };
  }

  /**
   * PENDING_PAYMENT / unpaid: release reservedStock.
   * Otherwise (COD deducted / paid): restock Product.stock.
   */
  private async releaseStockOnCustomerCancel(
    tx: Prisma.TransactionClient,
    order: {
      status: string;
      paymentStatus: string;
      items: Array<{
        quantity: number;
        variant: {
          variantName: string | null;
          packSize: {
            size: { toString(): string } | number;
            unit: string;
            label: string;
          } | null;
          product: { id: number; stockUnit: string | null };
        };
      }>;
    },
  ): Promise<void> {
    if (!order.items.length) return;

    const byProduct = this.aggregateProductPoolUnits(
      order.items.map((item) => ({
        productId: item.variant.product.id,
        stockUnit: item.variant.product.stockUnit,
        quantity: item.quantity,
        packSize: item.variant.packSize,
        variantName: item.variant.variantName,
      })),
    );

    const T = quoteSqlIdentifier("Product");
    const stockCol = quoteSqlIdentifier("stock");
    const reservedCol = quoteSqlIdentifier("reservedStock");
    const status = normalizeOrderStatus(order.status);
    const releaseReservation =
      (status === OrderStatus.PENDING_PAYMENT ||
        order.status === OrderStatus.LEGACY_PENDING ||
        order.status === "pending") &&
      order.paymentStatus !== PaymentStatus.PAID;

    for (const [productId, neededBase] of byProduct) {
      const product = await tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: { stockUnit: true, stock: true, reservedStock: true },
      });
      const units = unitsToDeductFromStoredPool(neededBase, product.stockUnit);
      if (units <= 0) continue;

      if (releaseReservation) {
        const rowsAffected = await tx.$executeRawUnsafe(
          `UPDATE ${T} SET ${reservedCol} = ${reservedCol} - ? WHERE id = ? AND ${reservedCol} >= ?`,
          units,
          productId,
          units,
        );
        if (affectedRowsCount(rowsAffected) !== 1) {
          throw new BadRequestException(
            `Failed to release reservation for product #${productId}`,
          );
        }
        await recordStockMovement(tx, {
          productId,
          type: "release",
          quantityChange: 0,
          stockBefore: product.stock,
          stockAfter: product.stock,
          reservedBefore: product.reservedStock,
          reservedAfter: Math.max(0, product.reservedStock - units),
          reason: "customer_cancel_release",
        });
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE ${T} SET ${stockCol} = ${stockCol} + ? WHERE id = ?`,
          units,
          productId,
        );
        await recordStockMovement(tx, {
          productId,
          type: "restock",
          quantityChange: units,
          stockBefore: product.stock,
          stockAfter: product.stock + units,
          reservedBefore: product.reservedStock,
          reservedAfter: product.reservedStock,
          reason: "customer_cancel_restock",
        });
      }
    }
  }

  findAll(customerId?: number) {
    return this.prisma.order
      .findMany({
        where: customerId ? { customerId } : {},
        include: orderDetailInclude,
        orderBy: { createdAt: "desc" },
      })
      .then((orders) => orders.map((o) => this.mapOrderDetail(o)));
  }

  async findOne(id: number) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: orderDetailInclude,
    });
    if (!order) throw new NotFoundException(`Order #${id} not found`);
    return this.mapOrderDetail(order);
  }

  async findOneForCustomer(id: number, customerId: number) {
    const order = await this.findOne(id);
    if (order.customerId !== customerId) {
      throw new ForbiddenException("Not your order");
    }
    return order;
  }

  async updateStatus(id: number, status: string) {
    await this.findOne(id);
    return this.prisma.order.update({ where: { id }, data: { status } });
  }

  getShippingFlat(): number {
    const raw = process.env.CHECKOUT_SHIPPING_FLAT;
    if (raw == null || raw === "") return DEFAULT_CHECKOUT_SHIPPING_FLAT;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CHECKOUT_SHIPPING_FLAT;
  }

  // ─── Admin ─────────────────────────────────────────────────────────────────

  adminFindAll(params: {
    status?: string;
    paymentStatus?: string;
    search?: string;
    from?: string;
    to?: string;
  }) {
    const { status, paymentStatus, search, from, to } = params;
    return this.prisma.order.findMany({
      where: {
        ...(status && { status }),
        ...(paymentStatus && { paymentStatus }),
        ...(search && {
          OR: [
            { orderNumber: stringContainsFilter(search) },
            { customer: { name: stringContainsFilter(search) } },
            { customer: { email: stringContainsFilter(search) } },
          ],
        }),
        ...(from || to
          ? {
              createdAt: {
                ...(from && { gte: new Date(from) }),
                ...(to && { lte: new Date(to) }),
              },
            }
          : {}),
      },
      include: {
        customer: {
          select: { id: true, name: true, email: true, phone: true },
        },
        items: true,
        payments: {
          select: {
            paymentMethod: true,
            paymentStatus: true,
            paymentDate: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async adminFindOne(id: number) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: {
          select: { id: true, name: true, email: true, phone: true },
        },
        items: { include: { variant: { include: { packSize: true } } } },
        payments: true,
        shipments: true,
      },
    });
    if (!order) throw new NotFoundException(`Order #${id} not found`);
    return order;
  }

  async adminUpdate(id: number, dto: AdminUpdateOrderDto) {
    await this.findOne(id);
    return this.prisma.order.update({
      where: { id },
      data: dto,
      include: {
        customer: { select: { name: true, email: true } },
        items: true,
      },
    });
  }

  async adminExportCsv(params: {
    status?: string;
    from?: string;
    to?: string;
  }): Promise<string> {
    const orders = (await this.adminFindAll(params)) as AdminOrderCsvRow[];

    const headers = [
      "Order Number",
      "Customer Name",
      "Customer Email",
      "Customer Phone",
      "Status",
      "Payment Status",
      "Total Amount",
      "Tax Amount",
      "Shipping Amount",
      "Tracking ID",
      "Notes",
      "Created At",
    ].join(",");

    const rows = orders.map((o) =>
      [
        o.orderNumber,
        `"${o.customer.name}"`,
        o.customer.email,
        o.customer.phone ?? "",
        o.status,
        o.paymentStatus,
        o.totalAmount,
        o.taxAmount,
        o.shippingAmount,
        o.trackingId ?? "",
        `"${(o.notes ?? "").replace(/"/g, '""')}"`,
        o.createdAt.toISOString(),
      ].join(","),
    );

    return [headers, ...rows].join("\n");
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private generateOrderNumber(): string {
    return `ORD-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  private async findOrderByIdempotencyKey(
    customerId: number,
    idempotencyKey: string | null | undefined,
  ) {
    if (!idempotencyKey) {
      return null;
    }
    const record = await this.prisma.checkoutIdempotency.findUnique({
      where: { customerId_key: { customerId, key: idempotencyKey } },
      include: { order: { include: orderDetailInclude } },
    });
    return record?.order ?? null;
  }

  private async loadCartForPlaceOrder(
    cartId: number,
    customerId: number,
  ): Promise<CartForPlaceOrder> {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      include: cartForPlaceOrderInclude,
    });
    if (!cart || cart.customerId !== customerId) {
      throw new NotFoundException("Cart not found");
    }
    if (cart.items.length === 0) {
      throw new BadRequestException("Cart is empty");
    }
    return cart;
  }

  /**
   * When the client sends a coupon code, load the row and validate.
   * No code → no DB call.
   */
  private async loadCouponRowIfCodePresent(
    couponCode: string | null | undefined,
  ): Promise<Coupon | null> {
    const trimmed = couponCode?.trim();
    if (!trimmed) {
      return null;
    }
    const row = await this.prisma.coupon.findUnique({
      where: { code: trimmed.toUpperCase() },
    });
    assertCouponUsable(row);
    return row;
  }

  private assertSubtotalMeetsCouponMinimum(
    subtotal: number,
    pricingSource: OrderPricingSource | null,
  ) {
    if (pricingSource?.minOrderAmount == null) {
      return;
    }
    if (subtotal < Number(pricingSource.minOrderAmount)) {
      throw new BadRequestException("Order subtotal is below coupon minimum");
    }
  }

  private async resolveShippingSnapshot(
    shippingAddressId: number | undefined,
    customerId: number,
  ): Promise<{
    snapshot: Prisma.InputJsonValue | undefined;
    shippingId: number | undefined;
  }> {
    if (shippingAddressId == null) {
      return { snapshot: undefined, shippingId: undefined };
    }
    const addr = await this.prisma.customerAddress.findFirst({
      where: { id: shippingAddressId, customerId },
    });
    if (!addr) {
      throw new BadRequestException(
        `Shipping address #${shippingAddressId} not found for this customer`,
      );
    }
    return {
      shippingId: shippingAddressId,
      snapshot: {
        name: addr.name,
        phone: addr.phone,
        addressLine1: addr.addressLine1,
        addressLine2: addr.addressLine2,
        city: addr.city,
        state: addr.state,
        postalCode: addr.postalCode,
        country: addr.country,
      },
    };
  }

  private async applyInventoryForPaymentMode(
    tx: Prisma.TransactionClient,
    items: CartForPlaceOrder["items"],
    paymentMethod: "ONLINE" | "COD",
  ): Promise<
    Map<
      number,
      {
        units: number;
        stockBefore: number;
        stockAfter: number;
        reservedBefore: number;
        reservedAfter: number;
      }
    >
  > {
    if (paymentMethod === "COD") {
      return this.deductStockImmediate(tx, items);
    }
    await this.reserveStockForOnlineCheckout(tx, items);
    return new Map();
  }

  /** COD: permanently reduce product-level pool. */
  private async deductStockImmediate(
    tx: Prisma.TransactionClient,
    items: CartForPlaceOrder["items"],
  ) {
    const byProduct = this.aggregateProductPoolUnits(
      items.map((item) => ({
        productId: item.variant.product.id,
        stockUnit: item.variant.product.stockUnit,
        quantity: item.quantity,
        packSize: item.variant.packSize,
        variantName: item.variant.variantName,
      })),
    );
    const stockByProduct = new Map<
      number,
      {
        units: number;
        stockBefore: number;
        stockAfter: number;
        reservedBefore: number;
        reservedAfter: number;
      }
    >();
    const T = quoteSqlIdentifier("Product");
    const stockCol = quoteSqlIdentifier("stock");
    const reservedCol = quoteSqlIdentifier("reservedStock");
    for (const [productId, neededBase] of byProduct) {
      const before = await tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: { stock: true, reservedStock: true, stockUnit: true },
      });
      const availableBase = poolAvailableInBase(
        before.stock,
        before.reservedStock,
        before.stockUnit,
      );
      if (neededBase > availableBase) {
        throw new BadRequestException(
          `Insufficient stock for product #${productId}`,
        );
      }
      const deduct = unitsToDeductFromStoredPool(neededBase, before.stockUnit);
      const rowsAffected = await tx.$executeRawUnsafe(
        `UPDATE ${T} SET ${stockCol} = ${stockCol} - ? WHERE id = ? AND (${stockCol} - ${reservedCol}) >= ?`,
        deduct,
        productId,
        deduct,
      );
      if (affectedRowsCount(rowsAffected) !== 1) {
        throw new BadRequestException(
          `Insufficient stock for product #${productId}`,
        );
      }
      const after = await tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: { stock: true, reservedStock: true },
      });
      stockByProduct.set(productId, {
        units: deduct,
        stockBefore: before.stock,
        stockAfter: after.stock,
        reservedBefore: before.reservedStock,
        reservedAfter: after.reservedStock,
      });
    }
    return stockByProduct;
  }

  /** ONLINE: hold units on product pool until payment clears or cancel. */
  private async reserveStockForOnlineCheckout(
    tx: Prisma.TransactionClient,
    items: CartForPlaceOrder["items"],
  ) {
    const byProduct = this.aggregateProductPoolUnits(
      items.map((item) => ({
        productId: item.variant.product.id,
        stockUnit: item.variant.product.stockUnit,
        quantity: item.quantity,
        packSize: item.variant.packSize,
        variantName: item.variant.variantName,
      })),
    );
    const T = quoteSqlIdentifier("Product");
    const stockCol = quoteSqlIdentifier("stock");
    const reservedCol = quoteSqlIdentifier("reservedStock");
    for (const [productId, neededBase] of byProduct) {
      const before = await tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: { stock: true, reservedStock: true, stockUnit: true },
      });
      const availableBase = poolAvailableInBase(
        before.stock,
        before.reservedStock,
        before.stockUnit,
      );
      if (neededBase > availableBase) {
        throw new BadRequestException(
          `Insufficient stock to reserve for product #${productId}`,
        );
      }
      const units = unitsToDeductFromStoredPool(neededBase, before.stockUnit);
      const rowsAffected = await tx.$executeRawUnsafe(
        `UPDATE ${T} SET ${reservedCol} = ${reservedCol} + ? WHERE id = ? AND (${stockCol} - ${reservedCol}) >= ?`,
        units,
        productId,
        units,
      );
      if (affectedRowsCount(rowsAffected) !== 1) {
        throw new BadRequestException(
          `Insufficient stock to reserve for product #${productId}`,
        );
      }
      const after = await tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: { stock: true, reservedStock: true },
      });
      await recordStockMovement(tx, {
        productId,
        type: "reserve",
        quantityChange: units,
        stockBefore: before.stock,
        stockAfter: after.stock,
        reservedBefore: before.reservedStock,
        reservedAfter: after.reservedStock,
        reason: "online_checkout_reserve",
        referenceType: "checkout",
        actorType: "system",
      });
    }
  }

  /** Persist sell ledger + stock movements when product pool stock is deducted. */
  private async writeSaleLedger(
    tx: Prisma.TransactionClient,
    opts: {
      orderId: number;
      paymentMethod: "COD" | "ONLINE";
      items: Array<{
        id: number;
        quantity: number;
        price: Prisma.Decimal | number;
        subtotal: Prisma.Decimal | number;
        productName: string;
        sizeLabel: string;
        variantId: number;
        variant: {
          sku?: string;
          variantName: string | null;
          packSize: {
            size: { toString(): string } | number;
            unit: string;
            label: string;
          } | null;
          product: { id: number; stockUnit: string | null };
        };
      }>;
      stockByProduct: Map<
        number,
        {
          units: number;
          stockBefore: number;
          stockAfter: number;
          reservedBefore: number;
          reservedAfter: number;
        }
      >;
    },
  ) {
    const saleLines: SaleLineInput[] = [];
    for (const item of opts.items) {
      const productId = item.variant.product.id;
      const stock = opts.stockByProduct.get(productId);
      if (!stock) continue;
      const unitsConsumed = unitsToConsume({
        quantity: item.quantity,
        stockUnit: item.variant.product.stockUnit,
        packSize: item.variant.packSize,
        variantName: item.variant.variantName,
      });
      saleLines.push({
        orderId: opts.orderId,
        orderItemId: item.id,
        productId,
        variantId: item.variantId,
        productName: item.productName,
        sizeLabel: item.sizeLabel,
        sku: item.variant.sku ?? null,
        quantity: item.quantity,
        unitsConsumed,
        unitPrice: item.price,
        subtotal: item.subtotal,
        paymentMethod: opts.paymentMethod,
        stockBefore: stock.stockBefore,
        stockAfter: stock.stockAfter,
      });
    }
    await recordSaleTransactions(tx, saleLines);

    for (const [productId, stock] of opts.stockByProduct) {
      await recordStockMovement(tx, {
        productId,
        type: "sale",
        quantityChange: -stock.units,
        stockBefore: stock.stockBefore,
        stockAfter: stock.stockAfter,
        reservedBefore: stock.reservedBefore,
        reservedAfter: stock.reservedAfter,
        reason:
          opts.paymentMethod === "COD"
            ? "cod_sale"
            : "online_payment_sale_commit",
        referenceType: "order",
        referenceId: opts.orderId,
        actorType: "system",
      });
    }
  }

  private async validateStockForCheckout(
    items: Array<{ variantId: number; quantity: number }>,
    paymentMethod: "ONLINE" | "COD",
  ) {
    void paymentMethod;
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: items.map((i) => i.variantId) } },
      include: {
        packSize: true,
        product: {
          select: {
            id: true,
            stock: true,
            reservedStock: true,
            stockUnit: true,
          },
        },
      },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));
    const lines: Array<{
      productId: number;
      stockUnit: string | null;
      quantity: number;
      packSize: (typeof variants)[0]["packSize"];
      variantName: string | null;
    }> = [];
    for (const item of items) {
      const v = byId.get(item.variantId);
      if (!v) {
        throw new NotFoundException(`Variant #${item.variantId} not found`);
      }
      lines.push({
        productId: v.product.id,
        stockUnit: v.product.stockUnit,
        quantity: item.quantity,
        packSize: v.packSize,
        variantName: v.variantName,
      });
    }
    const needed = this.aggregateProductPoolUnits(lines);
    for (const [productId, units] of needed) {
      const product = byId.get(
        items.find((i) => byId.get(i.variantId)?.product.id === productId)!
          .variantId,
      )!.product;
      const sellable = poolAvailableInBase(
        product.stock,
        product.reservedStock,
        product.stockUnit,
      );
      if (units > sellable) {
        throw new BadRequestException(
          `Insufficient stock for product #${productId}. Need ${units}, available ${sellable}`,
        );
      }
    }
  }

  /** Sum pool units per productId for multi-line carts of the same product. */
  private aggregateProductPoolUnits(
    lines: Array<{
      productId: number;
      stockUnit: string | null;
      quantity: number;
      packSize: {
        size: { toString(): string } | number;
        unit: string;
        label: string;
      } | null;
      variantName: string | null;
    }>,
  ): Map<number, number> {
    const map = new Map<number, number>();
    for (const line of lines) {
      const units = unitsToConsume({
        quantity: line.quantity,
        stockUnit: line.stockUnit,
        packSize: line.packSize,
        variantName: line.variantName,
      });
      map.set(line.productId, (map.get(line.productId) ?? 0) + units);
    }
    return map;
  }

  /** Flatten HSN + tax onto each line (snapshot, else live product fallback). */
  private mapOrderDetail(order: any) {
    const itemsRaw = order.items ?? [];
    const merchandiseSubtotal = itemsRaw.reduce(
      (sum: number, item: any) =>
        sum + Number(item.price ?? 0) * Number(item.quantity ?? 0),
      0,
    );
    const orderDiscount = Number(order.discountAmount ?? 0);

    const items = itemsRaw.map((item: any) => {
      const { variant, subtotal: _subtotal, ...rest } = item;
      void _subtotal;

      const taxPercent = Number(
        rest.taxPercent ?? variant?.product?.taxPercent ?? 0,
      );
      let taxAmount = rest.taxAmount != null ? Number(rest.taxAmount) : null;
      if (taxAmount == null) {
        const lineGross = Number(rest.price ?? 0) * Number(rest.quantity ?? 0);
        const share =
          merchandiseSubtotal > 0 ? lineGross / merchandiseSubtotal : 0;
        const lineAfterDiscount = Math.max(
          0,
          lineGross - orderDiscount * share,
        );
        taxAmount = extractInclusiveTax(lineAfterDiscount, taxPercent);
      }

      const mapped: Record<string, unknown> = {
        ...rest,
        hsnCode: rest.hsnCode ?? variant?.product?.hsnCode ?? null,
        taxPercent,
        taxAmount,
      };
      return mapped;
    });

    const discountPercent =
      order.discountPercent != null ? Number(order.discountPercent) : null;

    const result: Record<string, unknown> = {
      ...order,
      items,
    };

    // Prefer coupon % when known; otherwise keep discountAmount only.
    if (discountPercent != null && discountPercent > 0) {
      result.discountPercent = discountPercent;
    } else {
      delete result.discountPercent;
    }

    return result;
  }
}

function decimalToNumberOrUndefined(
  d: Prisma.Decimal | null | undefined,
): number | undefined {
  return d != null ? Number(d) : undefined;
}

function decimalToNumberOrNull(
  d: Prisma.Decimal | null | undefined,
): number | null {
  return d != null ? Number(d) : null;
}
