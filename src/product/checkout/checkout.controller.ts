import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiBearerAuth,
  ApiHeader,
  ApiQuery,
} from "@nestjs/swagger";
import { CheckoutService } from "./checkout.service";
import { ApplyCouponDto, PlaceOrderDto } from "../dto/checkout.dto";
import { CurrentCustomerId } from "../decorators/current-customer.decorator";

@ApiBearerAuth()
@ApiTags("Checkout")
@Controller("checkout")
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Get("summary")
  @ApiOperation({
    summary:
      "Checkout summary — prices, tax, courier shipping by destination state",
  })
  @ApiQuery({
    name: "addressId",
    required: false,
    type: Number,
    description:
      "Shipping address id (defaults to customer's default / latest address)",
  })
  @ApiResponse({ status: 200, description: "Pricing breakdown" })
  getSummary(
    @CurrentCustomerId() customerId: number,
    @Query("addressId") addressId?: string,
  ) {
    return this.checkoutService.getSummary(
      customerId,
      addressId != null && addressId !== "" ? Number(addressId) : undefined,
    );
  }

  @Post("apply-coupon")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Apply a coupon to the checkout session (24h TTL)" })
  @ApiBody({ type: ApplyCouponDto })
  @ApiResponse({ status: 200, description: "Coupon stored for checkout" })
  @ApiResponse({ status: 400, description: "Invalid coupon" })
  applyCoupon(
    @CurrentCustomerId() customerId: number,
    @Body() dto: ApplyCouponDto,
  ) {
    return this.checkoutService.applyCoupon(customerId, dto);
  }

  @Post("place-order")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Place order — idempotent with Idempotency-Key header; reserves stock until payment (non-COD)",
  })
  @ApiHeader({
    name: "idempotency-key",
    required: false,
    description:
      "Stable key for safe retries (same customer + key returns same order)",
  })
  @ApiBody({ type: PlaceOrderDto })
  @ApiResponse({ status: 201, description: "Order created" })
  placeOrder(
    @CurrentCustomerId() customerId: number,
    @Body() dto: PlaceOrderDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.checkoutService.placeOrder(customerId, dto, idempotencyKey);
  }
}
