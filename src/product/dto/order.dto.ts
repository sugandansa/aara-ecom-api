import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from "class-validator";
import { Type } from "class-transformer";

export class CreateOrderDto {
  @ApiProperty({ example: 1, description: "Customer ID" })
  @IsInt()
  @Type(() => Number)
  customerId: number;

  @ApiProperty({ example: 1, description: "Cart ID to convert to order" })
  @IsInt()
  @Type(() => Number)
  cartId: number;
}

export class UpdateOrderStatusDto {
  @ApiProperty({
    example: "SHIPPED",
    description:
      "Fulfillment status. Use PROCESSING, SHIPPED, DELIVERED, CANCELLED, FAILED (legacy rows may still show pending).",
    enum: [
      "pending",
      "PENDING_PAYMENT",
      "PROCESSING",
      "SHIPPED",
      "DELIVERED",
      "CANCELLED",
      "FAILED",
    ],
  })
  @IsString()
  status: string;
}

export enum CustomerReturnReason {
  DAMAGED_PRODUCT = "DAMAGED_PRODUCT",
  WRONG_ITEM = "WRONG_ITEM",
  MISSING_ITEM = "MISSING_ITEM",
  QUALITY_ISSUE = "QUALITY_ISSUE",
  NOT_AS_DESCRIBED = "NOT_AS_DESCRIBED",
  OTHER = "OTHER",
}

export class ReturnOrderDto {
  @ApiProperty({
    example: "DAMAGED_PRODUCT",
    enum: CustomerReturnReason,
  })
  @IsEnum(CustomerReturnReason)
  reason: CustomerReturnReason;

  @ApiProperty({
    example: "Product was damaged when received",
    description: "Customer description of the return request",
  })
  @IsString()
  @MinLength(3)
  description: string;
}

export class CreatePaymentDto {
  @ApiProperty({ example: 1, description: "Order ID" })
  @IsInt()
  @Type(() => Number)
  orderId: number;

  @ApiProperty({ example: "UPI", enum: ["UPI", "COD", "CARD", "NETBANKING"] })
  @IsString()
  paymentMethod: string;

  @ApiPropertyOptional({ example: "TXN123456" })
  @IsOptional()
  @IsString()
  transactionId?: string;
}
