import { Test, TestingModule } from "@nestjs/testing";
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { IS_PUBLIC_KEY } from "../../auth/public.decorator";

const mockOrdersService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOneForCustomer: jest.fn(),
  updateStatus: jest.fn(),
  cancel: jest.fn(),
  requestReturn: jest.fn(),
};

describe("OrdersController", () => {
  let controller: OrdersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [{ provide: OrdersService, useValue: mockOrdersService }],
    }).compile();

    controller = module.get<OrdersController>(OrdersController);
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("create()", () => {
    it("should create an order from a cart", async () => {
      const dto = { customerId: 1, cartId: 2 };
      const order = {
        id: 10,
        orderNumber: "ORD-123456",
        status: "PENDING_PAYMENT",
      };
      mockOrdersService.create.mockResolvedValue(order);

      const result = await controller.create(dto as any, 1);

      expect(mockOrdersService.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual(order);
    });

    it("should reject customerId mismatch", () => {
      expect(() =>
        controller.create({ customerId: 2, cartId: 1 } as any, 1),
      ).toThrow(ForbiddenException);
      expect(mockOrdersService.create).not.toHaveBeenCalled();
    });

    it("should throw BadRequestException when cart is empty", async () => {
      mockOrdersService.create.mockRejectedValue(
        new BadRequestException("Cart is empty"),
      );

      await expect(
        controller.create({ customerId: 1, cartId: 99 } as any, 1),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("findAll()", () => {
    it("should return orders for the authenticated customer", async () => {
      const orders = [{ id: 1 }, { id: 2 }];
      mockOrdersService.findAll.mockResolvedValue(orders);

      const result = await controller.findAll(5);

      expect(mockOrdersService.findAll).toHaveBeenCalledWith(5);
      expect(result).toEqual(orders);
    });
  });

  describe("findOne()", () => {
    it("should return an order by ID", async () => {
      const order = { id: 1, orderNumber: "ORD-111", items: [] };
      mockOrdersService.findOneForCustomer.mockResolvedValue(order);

      const result = await controller.findOne(1, 5);

      expect(mockOrdersService.findOneForCustomer).toHaveBeenCalledWith(1, 5);
      expect(result).toEqual(order);
    });

    it("should throw NotFoundException for a non-existent order", async () => {
      mockOrdersService.findOneForCustomer.mockRejectedValue(
        new NotFoundException("Order not found"),
      );

      await expect(controller.findOne(999, 5)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("cancel()", () => {
    it("should cancel an order", async () => {
      const cancelled = {
        status: 200,
        message: "Order cancelled successfully",
      };
      mockOrdersService.cancel.mockResolvedValue(cancelled);

      const result = await controller.cancel(1, 5);

      expect(mockOrdersService.cancel).toHaveBeenCalledWith(1, 5);
      expect(result).toEqual(cancelled);
    });
  });

  describe("requestReturn()", () => {
    it("should request a return", async () => {
      const payload = { status: 200, message: "Return requested successfully" };
      mockOrdersService.requestReturn.mockResolvedValue(payload);
      const dto = {
        reason: "DAMAGED_PRODUCT" as const,
        description: "Product was damaged when received",
      };

      const result = await controller.requestReturn(64, 21, dto as any);

      expect(mockOrdersService.requestReturn).toHaveBeenCalledWith(64, 21, dto);
      expect(result).toEqual(payload);
    });
  });

  describe("updateStatus()", () => {
    it("should update the order status", async () => {
      const updated = { id: 1, status: "SHIPPED" };
      mockOrdersService.updateStatus.mockResolvedValue(updated);

      const result = await controller.updateStatus(1, {
        status: "SHIPPED",
      } as any);

      expect(mockOrdersService.updateStatus).toHaveBeenCalledWith(1, "SHIPPED");
      expect(result).toEqual(updated);
    });

    it("should throw NotFoundException when order does not exist", async () => {
      mockOrdersService.updateStatus.mockRejectedValue(
        new NotFoundException("Order not found"),
      );

      await expect(
        controller.updateStatus(999, { status: "SHIPPED" } as any),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("auth decorators", () => {
    it("should have @ApiBearerAuth() on the controller", () => {
      const metadata = Reflect.getMetadata(
        "swagger/apiSecurity",
        OrdersController,
      );
      expect(metadata).toEqual([{ bearer: [] }]);
    });

    it("should NOT mark create as @Public()", () => {
      const isPublic = Reflect.getMetadata(
        IS_PUBLIC_KEY,
        OrdersController.prototype.create,
      );
      expect(isPublic).toBeUndefined();
    });

    it("should NOT mark findAll as @Public()", () => {
      const isPublic = Reflect.getMetadata(
        IS_PUBLIC_KEY,
        OrdersController.prototype.findAll,
      );
      expect(isPublic).toBeUndefined();
    });

    it("should NOT mark findOne as @Public()", () => {
      const isPublic = Reflect.getMetadata(
        IS_PUBLIC_KEY,
        OrdersController.prototype.findOne,
      );
      expect(isPublic).toBeUndefined();
    });

    it("should NOT mark updateStatus as @Public()", () => {
      const isPublic = Reflect.getMetadata(
        IS_PUBLIC_KEY,
        OrdersController.prototype.updateStatus,
      );
      expect(isPublic).toBeUndefined();
    });
  });
});
