import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CartService } from "../cart/cart.service";
import { OrdersService } from "../orders/orders.service";
import {
  computeCheckoutTotals,
  toCartLineInputs,
} from "./checkout-pricing.util";
import {
  ApplyCouponDto,
  PlaceOrderDto,
  CheckoutPaymentMethod,
} from "../dto/checkout.dto";
import { assertCouponUsable } from "./assert-coupon-usable";
import { CHECKOUT_SESSION_TTL_MS } from "./checkout.constants";
import {
  estimateCartWeightKg,
  quoteCourierShipping,
  type CourierForShipping,
  type ShippingQuote,
} from "./courier-shipping.util";

/**
 * Orchestrates checkout UX: summaries use server prices; coupons sit on a short-lived session;
 * place-order delegates persistence and inventory rules to {@link OrdersService}.
 * Shipping is quoted from admin courier rate cards by destination state + cart weight.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cartService: CartService,
    private readonly ordersService: OrdersService,
  ) {}

  async getSummary(customerId: number, addressId?: number) {
    const cart = await this.cartService.getOrCreate(customerId);
    await this.expireStaleSessionIfNeeded(customerId);

    const coupon = await this.resolveActiveCouponForCustomer(customerId);
    const address = await this.resolveShippingAddress(customerId, addressId);
    const quote = await this.quoteShippingForCart(
      cart.items,
      address?.state ?? null,
      // merchandise after discount computed below — provisional quote uses
      // pre-discount then re-quoted after totals when free-ship threshold applies.
      0,
    );

    const lines = toCartLineInputs(cart.items);
    const totals = computeCheckoutTotals(lines, {
      shippingFlat: quote.shipping,
      discountPercent: coupon?.percentOff
        ? Number(coupon.percentOff)
        : undefined,
      maxDiscountAmount: coupon?.maxDiscountAmount
        ? Number(coupon.maxDiscountAmount)
        : null,
      minOrderAmount: coupon?.minOrderAmount
        ? Number(coupon.minOrderAmount)
        : null,
    });

    // Re-quote with merchandise after discount so ₹2000 free-ship still applies.
    const finalQuote = await this.quoteShippingForCart(
      cart.items,
      address?.state ?? null,
      Math.max(0, totals.subtotal - totals.discount),
    );
    const shipping = finalQuote.shipping;
    const total =
      Math.round((totals.subtotal - totals.discount + shipping) * 100) / 100;

    return {
      items: totals.items.map((i) => ({
        variantId: i.variantId,
        productId: i.productId,
        name: i.productName,
        sizeLabel: i.sizeLabel,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineSubtotal: i.lineSubtotal,
        taxAmount: i.taxAmount,
        taxPercent: i.taxPercent,
      })),
      subtotal: totals.subtotal,
      discount: totals.discount,
      ...(coupon?.percentOff != null && Number(coupon.percentOff) > 0
        ? { discountPercent: Number(coupon.percentOff) }
        : {}),
      tax: totals.tax,
      shipping,
      total,
      couponCode: coupon?.code ?? null,
      shippingAddressId: address?.id ?? null,
      shippingState: address?.state ?? null,
      shippingWeightKg: finalQuote.weightKg,
      shippingCourier: finalQuote.courierCode,
    };
  }

  async applyCoupon(customerId: number, dto: ApplyCouponDto) {
    const code = dto.couponCode.trim().toUpperCase();
    const coupon = await this.prisma.coupon.findUnique({
      where: { code },
    });
    assertCouponUsable(coupon);

    const expiresAt = new Date(Date.now() + CHECKOUT_SESSION_TTL_MS);
    await this.prisma.checkoutSession.upsert({
      where: { customerId },
      create: {
        customerId,
        couponCode: coupon.code,
        expiresAt,
      },
      update: {
        couponCode: coupon.code,
        expiresAt,
      },
    });

    return { applied: true, couponCode: coupon.code };
  }

  async placeOrder(
    customerId: number,
    dto: PlaceOrderDto,
    idempotencyKey?: string,
  ) {
    const cart = await this.cartService.getOrCreate(customerId);
    await this.expireStaleSessionIfNeeded(customerId);

    const session = await this.prisma.checkoutSession.findUnique({
      where: { customerId },
    });

    const couponCode =
      dto.couponCode?.trim().toUpperCase() ?? session?.couponCode ?? undefined;

    const couponRow = couponCode
      ? await this.fetchCouponRowOrThrow(couponCode)
      : null;

    const paymentMethod =
      dto.paymentMethod === CheckoutPaymentMethod.COD ? "COD" : "ONLINE";

    const address = await this.resolveShippingAddress(
      customerId,
      dto.addressId,
    );

    // Provisional merchandise for free-ship threshold (coupon applied in placeOrder too).
    const lines = toCartLineInputs(cart.items);
    const provisional = computeCheckoutTotals(lines, {
      shippingFlat: 0,
      discountPercent: couponRow?.percentOff
        ? Number(couponRow.percentOff)
        : undefined,
      maxDiscountAmount: couponRow?.maxDiscountAmount
        ? Number(couponRow.maxDiscountAmount)
        : null,
      minOrderAmount: couponRow?.minOrderAmount
        ? Number(couponRow.minOrderAmount)
        : null,
    });
    const quote = await this.quoteShippingForCart(
      cart.items,
      address?.state ?? null,
      Math.max(0, provisional.subtotal - provisional.discount),
    );

    return this.ordersService.placeOrder({
      customerId,
      cartId: cart.id,
      shippingAddressId: dto.addressId ?? address?.id,
      couponCode,
      paymentMethod,
      idempotencyKey: idempotencyKey ?? null,
      shippingFlat: quote.shipping,
      couponPricing: couponRow
        ? {
            percentOff: couponRow.percentOff,
            maxDiscountAmount: couponRow.maxDiscountAmount,
            minOrderAmount: couponRow.minOrderAmount,
          }
        : null,
    });
  }

  /**
   * Loads coupon tied to session; if the session references a stale/invalid code, clears the session.
   */
  private async resolveActiveCouponForCustomer(customerId: number) {
    const session = await this.prisma.checkoutSession.findUnique({
      where: { customerId },
    });
    if (!session?.couponCode) {
      return null;
    }
    const coupon = await this.prisma.coupon.findUnique({
      where: { code: session.couponCode },
    });
    const usable =
      coupon?.active &&
      (coupon.expiresAt == null || coupon.expiresAt >= new Date());
    if (!usable) {
      await this.prisma.checkoutSession.deleteMany({ where: { customerId } });
      return null;
    }
    return coupon;
  }

  private async fetchCouponRowOrThrow(code: string) {
    const row = await this.prisma.coupon.findUnique({
      where: { code },
    });
    assertCouponUsable(row);
    return row;
  }

  private async expireStaleSessionIfNeeded(customerId: number) {
    const session = await this.prisma.checkoutSession.findUnique({
      where: { customerId },
    });
    if (session != null && session.expiresAt.getTime() < Date.now()) {
      await this.prisma.checkoutSession.delete({ where: { customerId } });
    }
  }

  private async resolveShippingAddress(
    customerId: number,
    addressId?: number,
  ): Promise<{ id: number; state: string } | null> {
    if (addressId != null) {
      const row = await this.prisma.customerAddress.findFirst({
        where: { id: addressId, customerId },
        select: { id: true, state: true },
      });
      return row;
    }
    const preferred = await this.prisma.customerAddress.findFirst({
      where: { customerId, isDefault: true },
      select: { id: true, state: true },
    });
    if (preferred) return preferred;
    return this.prisma.customerAddress.findFirst({
      where: { customerId },
      orderBy: { id: "desc" },
      select: { id: true, state: true },
    });
  }

  private async loadCouriersForShipping(): Promise<CourierForShipping[]> {
    const rows = await this.prisma.courier.findMany({
      where: { status: "ACTIVE" },
      include: {
        states: true,
        rateRules: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code,
      status: c.status,
      states: c.states.map((s) => ({ name: s.name, code: s.code })),
      rateRules: c.rateRules.map((r) => ({
        minWeight: Number(r.minWeight),
        maxWeight: r.maxWeight != null ? Number(r.maxWeight) : null,
        ratePerKg: Number(r.ratePerKg),
        freeShipping: r.freeShipping,
      })),
    }));
  }

  private async quoteShippingForCart(
    items: Array<{
      quantity: number;
      variant: {
        variantName?: string | null;
        packSize?: {
          size: { toString(): string } | number;
          unit: string;
          label: string;
        } | null;
        product?: { stockUnit?: string | null };
      };
    }>,
    state: string | null,
    merchandiseTotal: number,
  ): Promise<ShippingQuote> {
    const couriers = await this.loadCouriersForShipping();
    const weightKg = estimateCartWeightKg(
      items.map((i) => ({
        quantity: i.quantity,
        variantName: i.variant.variantName ?? null,
        packSize: i.variant.packSize ?? null,
        stockUnit: i.variant.product?.stockUnit ?? null,
      })),
    );
    return quoteCourierShipping({
      state,
      weightKg,
      merchandiseTotal,
      couriers,
      flatFallback: this.ordersService.getShippingFlat(),
    });
  }
}
