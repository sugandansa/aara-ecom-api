import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiParam,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { CustomersService } from "./customers.service";
import {
  CreateCustomerDto,
  CustomerLoginDto,
  CustomerForgotPasswordDto,
  CustomerResetPasswordDto,
  CreateCustomerAddressDto,
  UpdateCustomerAddressDto,
} from "../dto/customer.dto";
import { Public } from "../../auth/public.decorator";
import { CurrentCustomerId } from "../decorators/current-customer.decorator";

@ApiBearerAuth()
@ApiTags("Customers")
@Controller(["customers", "customer"])
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Public()
  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Register a new customer" })
  @ApiBody({ type: CreateCustomerDto })
  @ApiResponse({ status: 201, description: "Customer registered successfully" })
  @ApiResponse({ status: 400, description: "Email already registered" })
  register(@Body() dto: CreateCustomerDto) {
    return this.customersService.register(dto);
  }

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Customer login — returns JWT token" })
  @ApiBody({ type: CustomerLoginDto })
  @ApiResponse({
    status: 200,
    description: "Login successful, returns JWT token",
  })
  @ApiResponse({ status: 400, description: "Invalid credentials" })
  login(@Body() dto: CustomerLoginDto) {
    return this.customersService.login(dto);
  }

  @Public()
  @Post("forgot-password")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Generate password reset token for a customer email",
  })
  @ApiBody({ type: CustomerForgotPasswordDto })
  @ApiResponse({
    status: 200,
    description: "Reset token generated",
  })
  @ApiResponse({ status: 404, description: "Customer email not found" })
  forgotPassword(@Body() dto: CustomerForgotPasswordDto) {
    return this.customersService.forgotPassword(dto.email);
  }

  @Public()
  @Patch("reset-password/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reset customer password by ID" })
  @ApiParam({ name: "id", type: Number })
  @ApiBody({ type: CustomerResetPasswordDto })
  @ApiResponse({ status: 200, description: "Password updated successfully" })
  @ApiResponse({ status: 404, description: "Customer not found" })
  resetPassword(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: CustomerResetPasswordDto,
  ) {
    return this.customersService.resetPassword(id, dto.new_password);
  }

  @Get("me")
  @ApiOperation({ summary: "Get current customer profile + addresses" })
  @ApiResponse({ status: 200, description: "Customer profile" })
  getMe(@CurrentCustomerId() customerId: number) {
    return this.customersService.getMe(customerId);
  }

  @Get("me/addresses")
  @ApiOperation({ summary: "List shipping addresses for current customer" })
  @ApiResponse({ status: 200, description: "Address list" })
  listAddresses(@CurrentCustomerId() customerId: number) {
    return this.customersService.listAddresses(customerId);
  }

  @Post("me/addresses")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a shipping address for current customer" })
  @ApiBody({ type: CreateCustomerAddressDto })
  @ApiResponse({ status: 201, description: "Address created" })
  createAddress(
    @CurrentCustomerId() customerId: number,
    @Body() dto: CreateCustomerAddressDto,
  ) {
    return this.customersService.createAddress(customerId, dto);
  }

  @Put("me/addresses/:addressId")
  @ApiOperation({ summary: "Update a shipping address" })
  @ApiParam({ name: "addressId", type: Number })
  @ApiBody({ type: UpdateCustomerAddressDto })
  @ApiResponse({ status: 200, description: "Address updated" })
  @ApiResponse({ status: 404, description: "Address not found" })
  updateAddress(
    @CurrentCustomerId() customerId: number,
    @Param("addressId", ParseIntPipe) addressId: number,
    @Body() dto: UpdateCustomerAddressDto,
  ) {
    return this.customersService.updateAddress(customerId, addressId, dto);
  }

  @Delete("me/addresses/:addressId")
  @ApiOperation({ summary: "Delete a shipping address" })
  @ApiParam({ name: "addressId", type: Number })
  @ApiResponse({ status: 200, description: "Address deleted" })
  @ApiResponse({ status: 404, description: "Address not found" })
  removeAddress(
    @CurrentCustomerId() customerId: number,
    @Param("addressId", ParseIntPipe) addressId: number,
  ) {
    return this.customersService.removeAddress(customerId, addressId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get customer profile by ID" })
  @ApiParam({ name: "id", type: Number })
  @ApiResponse({ status: 200, description: "Customer profile" })
  @ApiResponse({ status: 404, description: "Customer not found" })
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.customersService.findOne(id);
  }
}
