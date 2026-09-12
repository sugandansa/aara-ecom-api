import {
  BadRequestException,
  Injectable,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
  InternalServerErrorException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  CreateCustomerDto,
  CustomerLoginDto,
  CreateCustomerAddressDto,
  UpdateCustomerAddressDto,
} from "../dto/customer.dto";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import * as jwt from "jsonwebtoken";

type NormalizedAddress = {
  name: string;
  phone?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
  /** Website-friendly aliases echoed in responses */
  firstName: string;
  lastName: string;
  houseNo: string;
  areaStreet: string;
  pincode: string;
};

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** Canonical customer email for storage and lookup. */
export function normalizeCustomerEmail(email: string): string {
  return email.trim().toLowerCase();
}

function mapAddressResponse(addr: {
  id: number;
  customerId: number;
  name: string;
  phone: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
}) {
  const { firstName, lastName } = splitName(addr.name);
  // Best-effort split of addressLine1 into houseNo + areaStreet for website UI
  const comma = addr.addressLine1.indexOf(",");
  const houseNo =
    comma > 0 ? addr.addressLine1.slice(0, comma).trim() : addr.addressLine1;
  const areaStreet =
    comma > 0 ? addr.addressLine1.slice(comma + 1).trim() : addr.addressLine1;

  return {
    ...addr,
    firstName,
    lastName,
    houseNo,
    areaStreet,
    pincode: addr.postalCode,
  };
}

function normalizeCreateAddress(
  dto: CreateCustomerAddressDto,
): NormalizedAddress {
  const name = (
    dto.name?.trim() ||
    [dto.firstName, dto.lastName].filter(Boolean).join(" ").trim()
  ).trim();
  const addressLine1 = (
    dto.addressLine1?.trim() ||
    (() => {
      const house = dto.houseNo?.trim() || "";
      const street = dto.areaStreet?.trim() || "";
      if (house && street) {
        // Website often sends houseNo again inside areaStreet — avoid "35, 35, ..."
        if (
          street === house ||
          street.startsWith(`${house},`) ||
          street.startsWith(`${house} `)
        ) {
          return street;
        }
        return `${house}, ${street}`;
      }
      return house || street;
    })()
  ).trim();
  const postalCode = (
    dto.postalCode?.trim() ||
    dto.pincode?.trim() ||
    ""
  ).trim();

  if (!name) {
    throw new BadRequestException("Provide name, or firstName/lastName");
  }
  if (!addressLine1) {
    throw new BadRequestException(
      "Provide addressLine1, or houseNo/areaStreet",
    );
  }
  if (!postalCode) {
    throw new BadRequestException("Provide postalCode or pincode");
  }

  const { firstName, lastName } = splitName(name);
  return {
    name,
    phone: dto.phone ?? null,
    addressLine1,
    addressLine2: dto.addressLine2 ?? null,
    city: dto.city.trim(),
    state: dto.state.trim(),
    postalCode,
    country: dto.country.trim(),
    isDefault: Boolean(dto.isDefault),
    firstName: dto.firstName?.trim() || firstName,
    lastName: dto.lastName?.trim() || lastName,
    houseNo: dto.houseNo?.trim() || "",
    areaStreet: dto.areaStreet?.trim() || addressLine1,
    pincode: postalCode,
  };
}

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async register(dto: CreateCustomerDto) {
    const email = normalizeCustomerEmail(dto.email);
    const existing = await this.prisma.customer.findUnique({
      where: { email },
    });
    if (existing) throw new ConflictException("Email already registered");
    const passwordHash = await bcrypt.hash(dto.password, 10);
    return this.prisma.customer.create({
      data: {
        name: dto.name,
        email,
        phone: dto.phone,
        passwordHash,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
      },
    });
  }

  async login(dto: CustomerLoginDto) {
    const email = normalizeCustomerEmail(dto.email);
    const customer = await this.prisma.customer.findUnique({
      where: { email },
    });
    if (!customer?.passwordHash) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const valid = await bcrypt.compare(dto.password, customer.passwordHash);
    if (!valid) throw new UnauthorizedException("Invalid credentials");
    if (customer.isBlocked) {
      throw new UnauthorizedException("Account is blocked");
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new InternalServerErrorException(
        "Authentication is not configured",
      );
    }
    const token = jwt.sign({ customerId: customer.id }, secret, {
      expiresIn: "7d",
    });
    return { token, customerId: customer.id, name: customer.name };
  }

  async forgotPassword(emailRaw: string) {
    const email = normalizeCustomerEmail(emailRaw);
    const customer = await this.prisma.customer.findUnique({
      where: { email },
      select: { id: true, isBlocked: true },
    });
    if (!customer) {
      throw new NotFoundException("No customer found with this email");
    }
    if (customer.isBlocked) {
      throw new UnauthorizedException("Account is blocked");
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.prisma.customer.update({
      where: { id: customer.id },
      data: { resetToken, resetTokenExpiry },
    });

    // Token returned for website reset flow (also store for server-side validation).
    return {
      message: "Reset token generated.",
      customerId: customer.id,
      resetToken,
    };
  }

  async resetPassword(id: number, newPassword: string) {
    const password = newPassword?.trim();
    if (!password || password.length < 6) {
      throw new BadRequestException("Password must be at least 6 characters");
    }
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException(`Customer #${id} not found`);

    const passwordHash = await bcrypt.hash(password, 10);
    await this.prisma.customer.update({
      where: { id },
      data: {
        passwordHash,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });
    return { message: "updated successfully." };
  }

  async findOne(id: number) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
        addresses: true,
      },
    });
    if (!customer) throw new NotFoundException(`Customer #${id} not found`);
    return {
      ...customer,
      addresses: customer.addresses.map(mapAddressResponse),
    };
  }

  getMe(customerId: number) {
    return this.findOne(customerId);
  }

  async listAddresses(customerId: number) {
    const rows = await this.prisma.customerAddress.findMany({
      where: { customerId },
      orderBy: [{ isDefault: "desc" }, { id: "desc" }],
    });
    return rows.map(mapAddressResponse);
  }

  async createAddress(customerId: number, dto: CreateCustomerAddressDto) {
    const n = normalizeCreateAddress(dto);

    const created = await this.prisma.$transaction(async (tx) => {
      if (n.isDefault) {
        await tx.customerAddress.updateMany({
          where: { customerId },
          data: { isDefault: false },
        });
      }
      return tx.customerAddress.create({
        data: {
          customerId,
          name: n.name,
          phone: n.phone,
          addressLine1: n.addressLine1,
          addressLine2: n.addressLine2,
          city: n.city,
          state: n.state,
          postalCode: n.postalCode,
          country: n.country,
          isDefault: n.isDefault,
        },
      });
    });

    return mapAddressResponse(created);
  }

  async updateAddress(
    customerId: number,
    addressId: number,
    dto: UpdateCustomerAddressDto,
  ) {
    await this.ensureAddressOwned(customerId, addressId);
    const data: Prisma.CustomerAddressUpdateInput = {};

    if (
      dto.name !== undefined ||
      dto.firstName !== undefined ||
      dto.lastName !== undefined
    ) {
      const name = (
        dto.name?.trim() ||
        [dto.firstName, dto.lastName].filter(Boolean).join(" ").trim()
      ).trim();
      if (name) data.name = name;
    }
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (
      dto.addressLine1 !== undefined ||
      dto.houseNo !== undefined ||
      dto.areaStreet !== undefined
    ) {
      const line = (
        dto.addressLine1?.trim() ||
        [dto.houseNo, dto.areaStreet].filter(Boolean).join(", ").trim()
      ).trim();
      if (line) data.addressLine1 = line;
    }
    if (dto.addressLine2 !== undefined) data.addressLine2 = dto.addressLine2;
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.state !== undefined) data.state = dto.state;
    if (dto.postalCode !== undefined || dto.pincode !== undefined) {
      const pc = (dto.postalCode?.trim() || dto.pincode?.trim() || "").trim();
      if (pc) data.postalCode = pc;
    }
    if (dto.country !== undefined) data.country = dto.country;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await tx.customerAddress.updateMany({
          where: { customerId },
          data: { isDefault: false },
        });
        data.isDefault = true;
      } else if (dto.isDefault === false) {
        data.isDefault = false;
      }
      return tx.customerAddress.update({
        where: { id: addressId },
        data,
      });
    });

    return mapAddressResponse(updated);
  }

  async removeAddress(customerId: number, addressId: number) {
    await this.ensureAddressOwned(customerId, addressId);
    await this.prisma.customerAddress.delete({ where: { id: addressId } });
    return { message: "Address deleted" };
  }

  private async ensureAddressOwned(customerId: number, addressId: number) {
    const addr = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!addr) {
      throw new NotFoundException(
        `Shipping address #${addressId} not found for this customer`,
      );
    }
    return addr;
  }
}
