import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  CourierIntegrationType,
  CourierRateRuleInputDto,
  CourierStateInputDto,
  CourierStatus,
  CreateCourierDto,
  UpdateCourierDto,
} from "./dto/admin-courier.dto";

const courierDetailInclude = {
  states: { orderBy: { id: "asc" as const } },
  rateRules: {
    orderBy: [{ sortOrder: "asc" as const }, { id: "asc" as const }],
  },
} satisfies Prisma.CourierInclude;

type CourierWithRelations = Prisma.CourierGetPayload<{
  include: typeof courierDetailInclude;
}>;

@Injectable()
export class AdminLogisticsCouriersService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.courier.findMany({
      include: courierDetailInclude,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => this.mapCourier(row));
  }

  async findOne(id: number) {
    const row = await this.requireCourier(id);
    return this.mapCourier(row);
  }

  async create(dto: CreateCourierDto) {
    const code = dto.code.trim().toUpperCase();
    await this.assertCodeAvailable(code);

    const states = dto.states ?? [];
    const rateRules = dto.rateRules ?? [];
    this.assertUniqueStateCodes(states);
    this.assertValidRateRules(rateRules);

    const created = await this.prisma.courier.create({
      data: {
        name: dto.name.trim(),
        code,
        integrationType: dto.integrationType ?? CourierIntegrationType.MANUAL,
        status: dto.status ?? CourierStatus.ACTIVE,
        states: {
          create: states.map((s) => ({
            name: s.name.trim(),
            code: s.code.trim().toUpperCase(),
          })),
        },
        rateRules: {
          create: rateRules.map((r, index) => this.toRateRuleCreate(r, index)),
        },
      },
      include: courierDetailInclude,
    });

    return {
      message: "Courier created successfully",
      data: this.mapCourier(created),
    };
  }

  async update(id: number, dto: UpdateCourierDto) {
    await this.requireCourier(id);

    if (dto.code != null) {
      await this.assertCodeAvailable(dto.code.trim().toUpperCase(), id);
    }
    if (dto.states) {
      this.assertUniqueStateCodes(dto.states);
    }
    if (dto.rateRules) {
      this.assertValidRateRules(dto.rateRules);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.courier.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          ...(dto.code !== undefined && {
            code: dto.code.trim().toUpperCase(),
          }),
          ...(dto.integrationType !== undefined && {
            integrationType: dto.integrationType,
          }),
          ...(dto.status !== undefined && { status: dto.status }),
        },
      });

      if (dto.states) {
        await this.replaceStates(tx, id, dto.states);
      }
      if (dto.rateRules) {
        await this.replaceRateRules(tx, id, dto.rateRules);
      }

      return tx.courier.findUniqueOrThrow({
        where: { id },
        include: courierDetailInclude,
      });
    });

    return {
      message: "Courier updated successfully",
      data: this.mapCourier(updated),
    };
  }

  async remove(id: number) {
    await this.requireCourier(id);
    await this.prisma.courier.delete({ where: { id } });
    return { message: "Courier deleted successfully" };
  }

  private async requireCourier(id: number): Promise<CourierWithRelations> {
    const row = await this.prisma.courier.findUnique({
      where: { id },
      include: courierDetailInclude,
    });
    if (!row) throw new NotFoundException(`Courier #${id} not found`);
    return row;
  }

  private async assertCodeAvailable(code: string, excludeId?: number) {
    const existing = await this.prisma.courier.findUnique({ where: { code } });
    if (existing && existing.id !== excludeId) {
      throw new ConflictException(`Courier code "${code}" already exists`);
    }
  }

  private assertUniqueStateCodes(states: CourierStateInputDto[]) {
    const seen = new Set<string>();
    for (const s of states) {
      const code = s.code.trim().toUpperCase();
      if (seen.has(code)) {
        throw new BadRequestException(
          `Duplicate state code "${code}" in request`,
        );
      }
      seen.add(code);
    }
  }

  private assertValidRateRules(rules: CourierRateRuleInputDto[]) {
    const normalized = rules.map((r, index) => {
      const minWeight = Number(r.minWeight);
      const maxWeight =
        r.maxWeight === undefined || r.maxWeight === null
          ? null
          : Number(r.maxWeight);
      if (!Number.isFinite(minWeight) || minWeight < 0) {
        throw new BadRequestException(
          `rateRules[${index}].minWeight must be >= 0`,
        );
      }
      if (maxWeight != null) {
        if (!Number.isFinite(maxWeight) || maxWeight < 0) {
          throw new BadRequestException(
            `rateRules[${index}].maxWeight must be >= 0`,
          );
        }
        if (maxWeight < minWeight) {
          throw new BadRequestException(
            `rateRules[${index}].maxWeight must be >= minWeight`,
          );
        }
      }
      const ratePerKg = Number(r.ratePerKg);
      if (!Number.isFinite(ratePerKg) || ratePerKg < 0) {
        throw new BadRequestException(
          `rateRules[${index}].ratePerKg must be >= 0`,
        );
      }
      return { minWeight, maxWeight };
    });

    // Detect overlapping weight bands (open-ended treated as +Infinity).
    const sorted = [...normalized].sort((a, b) => a.minWeight - b.minWeight);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const prevMax = prev.maxWeight ?? Number.POSITIVE_INFINITY;
      if (curr.minWeight < prevMax) {
        throw new BadRequestException(
          "rateRules weight bands must not overlap",
        );
      }
    }
  }

  private toRateRuleCreate(r: CourierRateRuleInputDto, index: number) {
    return {
      minWeight: r.minWeight,
      maxWeight: r.maxWeight ?? null,
      ratePerKg: r.ratePerKg,
      freeShipping: r.freeShipping ?? false,
      sortOrder: index,
    };
  }

  private async replaceStates(
    tx: Prisma.TransactionClient,
    courierId: number,
    states: CourierStateInputDto[],
  ) {
    const existing = await tx.courierState.findMany({ where: { courierId } });
    const keepIds = new Set(
      states.filter((s) => s.id != null).map((s) => Number(s.id)),
    );

    const staleIds = existing
      .filter((e) => !keepIds.has(e.id))
      .map((e) => e.id);
    if (staleIds.length) {
      await tx.courierState.deleteMany({
        where: { courierId, id: { in: staleIds } },
      });
    }

    for (const s of states) {
      const data = {
        name: s.name.trim(),
        code: s.code.trim().toUpperCase(),
      };
      if (s.id != null) {
        const owned = existing.find((e) => e.id === s.id);
        if (!owned) {
          throw new BadRequestException(
            `State #${s.id} does not belong to courier #${courierId}`,
          );
        }
        await tx.courierState.update({ where: { id: s.id }, data });
      } else {
        await tx.courierState.create({
          data: { courierId, ...data },
        });
      }
    }
  }

  private async replaceRateRules(
    tx: Prisma.TransactionClient,
    courierId: number,
    rules: CourierRateRuleInputDto[],
  ) {
    const existing = await tx.courierRateRule.findMany({
      where: { courierId },
    });
    const keepIds = new Set(
      rules.filter((r) => r.id != null).map((r) => Number(r.id)),
    );
    const staleIds = existing
      .filter((e) => !keepIds.has(e.id))
      .map((e) => e.id);
    if (staleIds.length) {
      await tx.courierRateRule.deleteMany({
        where: { courierId, id: { in: staleIds } },
      });
    }

    for (let index = 0; index < rules.length; index++) {
      const r = rules[index];
      const data = this.toRateRuleCreate(r, index);
      if (r.id != null) {
        const owned = existing.find((e) => e.id === r.id);
        if (!owned) {
          throw new BadRequestException(
            `Rate rule #${r.id} does not belong to courier #${courierId}`,
          );
        }
        await tx.courierRateRule.update({ where: { id: r.id }, data });
      } else {
        await tx.courierRateRule.create({
          data: { courierId, ...data },
        });
      }
    }
  }

  private mapCourier(row: CourierWithRelations) {
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      integrationType: row.integrationType,
      status: row.status,
      states: row.states.map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
      })),
      rateRules: row.rateRules.map((r) => ({
        id: r.id,
        minWeight: Number(r.minWeight),
        maxWeight: r.maxWeight != null ? Number(r.maxWeight) : null,
        ratePerKg: Number(r.ratePerKg),
        freeShipping: r.freeShipping,
      })),
    };
  }
}
