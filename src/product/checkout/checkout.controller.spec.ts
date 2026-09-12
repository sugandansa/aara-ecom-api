import { Test, TestingModule } from "@nestjs/testing";
import { CheckoutController } from "./checkout.controller";
import { CheckoutService } from "./checkout.service";
import { IS_PUBLIC_KEY } from "../../auth/public.decorator";

const mockCheckoutService = {
  getSummary: jest.fn(),
  applyCoupon: jest.fn(),
  placeOrder: jest.fn(),
};

describe("CheckoutController", () => {
  let controller: CheckoutController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [{ provide: CheckoutService, useValue: mockCheckoutService }],
    }).compile();

    controller = module.get<CheckoutController>(CheckoutController);
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("getSummary()", () => {
    it("should return checkout summary for customer", async () => {
      const payload = {
        items: [],
        subtotal: 100,
        discount: 0,
        tax: 5,
        shipping: 50,
        total: 155,
        couponCode: null,
      };
      mockCheckoutService.getSummary.mockResolvedValue(payload);

      const result = await controller.getSummary(7);

      expect(mockCheckoutService.getSummary).toHaveBeenCalledWith(7, undefined);
      expect(result).toEqual(payload);
    });
  });

  describe("applyCoupon()", () => {
    it("should apply coupon via checkout session", async () => {
      mockCheckoutService.applyCoupon.mockResolvedValue({
        applied: true,
        couponCode: "SAVE10",
      });

      const result = await controller.applyCoupon(3, {
        couponCode: "save10",
      });

      expect(mockCheckoutService.applyCoupon).toHaveBeenCalledWith(3, {
        couponCode: "save10",
      });
      expect(result).toEqual({ applied: true, couponCode: "SAVE10" });
    });
  });

  describe("placeOrder()", () => {
    it("should place order with optional idempotency header", async () => {
      const order = {
        id: 42,
        orderNumber: "ORD-abc",
        status: "PENDING_PAYMENT",
      };
      mockCheckoutService.placeOrder.mockResolvedValue(order);

      const dto = {
        addressId: 1,
        paymentMethod: "CARD" as const,
        couponCode: "SAVE10",
      };

      const result = await controller.placeOrder(3, dto, "idem-key-1");

      expect(mockCheckoutService.placeOrder).toHaveBeenCalledWith(
        3,
        dto,
        "idem-key-1",
      );
      expect(result).toEqual(order);
    });

    it("should pass undefined idempotency when header omitted", async () => {
      mockCheckoutService.placeOrder.mockResolvedValue({ id: 1 });

      await controller.placeOrder(2, {
        paymentMethod: "COD",
      } as any);

      expect(mockCheckoutService.placeOrder).toHaveBeenCalledWith(
        2,
        { paymentMethod: "COD" },
        undefined,
      );
    });
  });

  describe("auth decorators", () => {
    it("should have @ApiBearerAuth() on the controller", () => {
      const metadata = Reflect.getMetadata(
        "swagger/apiSecurity",
        CheckoutController,
      );
      expect(metadata).toEqual([{ bearer: [] }]);
    });

    it("should NOT mark getSummary as @Public()", () => {
      expect(
        Reflect.getMetadata(
          IS_PUBLIC_KEY,
          CheckoutController.prototype.getSummary,
        ),
      ).toBeUndefined();
    });
  });
});
