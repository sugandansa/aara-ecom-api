import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsEmail,
  IsOptional,
  IsBoolean,
  MinLength,
} from "class-validator";
import { Transform, Type } from "class-transformer";

export class CreateCustomerDto {
  @ApiProperty({ example: "John Doe" })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: "john@gmail.com" })
  @IsEmail()
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  email: string;

  @ApiPropertyOptional({ example: "9876543210" })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ example: "Secret@123" })
  @IsString()
  @IsNotEmpty()
  password: string;
}

export class CustomerLoginDto {
  @ApiProperty({ example: "john@gmail.com" })
  @IsEmail()
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  email: string;

  @ApiProperty({ example: "Secret@123" })
  @IsString()
  @IsNotEmpty()
  password: string;
}

export class CustomerForgotPasswordDto {
  @ApiProperty({ example: "sarmi19@gmail.com" })
  @IsEmail()
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  email: string;
}

export class CustomerResetPasswordDto {
  @ApiProperty({
    example: "Sarmi@123",
    description: "New password (min 6 chars)",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  @Transform(({ obj }) => {
    const v = obj?.new_password ?? obj?.newPassword;
    return typeof v === "string" ? v : obj?.new_password;
  })
  new_password: string;
}

/**
 * Accepts both canonical API fields and website checkout aliases.
 * Canonical: name, addressLine1, postalCode
 * Website: firstName+lastName, houseNo+areaStreet, pincode, isDefault
 */
export class CreateCustomerAddressDto {
  @ApiPropertyOptional({ example: "Ramnath sekar" })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: "Ramnath" })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: "sekar" })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ example: "9876543210" })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: "12 MG Road" })
  @IsOptional()
  @IsString()
  addressLine1?: string;

  @ApiPropertyOptional({ example: "Near City Mall" })
  @IsOptional()
  @IsString()
  addressLine2?: string;

  @ApiPropertyOptional({ example: "35" })
  @IsOptional()
  @IsString()
  houseNo?: string;

  @ApiPropertyOptional({
    example: "35, Balaji Arcade, Nalliyampalyam, Tindal, Erode",
  })
  @IsOptional()
  @IsString()
  areaStreet?: string;

  @ApiProperty({ example: "Erode" })
  @IsString()
  @IsNotEmpty()
  city: string;

  @ApiProperty({ example: "TamilNadu" })
  @IsString()
  @IsNotEmpty()
  state: string;

  @ApiPropertyOptional({ example: "638012" })
  @IsOptional()
  @IsString()
  postalCode?: string;

  @ApiPropertyOptional({ example: "638012" })
  @IsOptional()
  @IsString()
  pincode?: string;

  @ApiProperty({ example: "India" })
  @IsString()
  @IsNotEmpty()
  country: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === "true" || value === 1)
  @Type(() => Boolean)
  isDefault?: boolean;
}

export class UpdateCustomerAddressDto {
  @ApiPropertyOptional({ example: "Ramnath sekar" })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: "Ramnath" })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: "sekar" })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ example: "9876543210" })
  @IsOptional()
  @IsString()
  phone?: string | null;

  @ApiPropertyOptional({ example: "12 MG Road" })
  @IsOptional()
  @IsString()
  addressLine1?: string;

  @ApiPropertyOptional({ example: "Near City Mall" })
  @IsOptional()
  @IsString()
  addressLine2?: string | null;

  @ApiPropertyOptional({ example: "35" })
  @IsOptional()
  @IsString()
  houseNo?: string;

  @ApiPropertyOptional({ example: "Balaji Arcade" })
  @IsOptional()
  @IsString()
  areaStreet?: string;

  @ApiPropertyOptional({ example: "Erode" })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: "TamilNadu" })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ example: "638012" })
  @IsOptional()
  @IsString()
  postalCode?: string;

  @ApiPropertyOptional({ example: "638012" })
  @IsOptional()
  @IsString()
  pincode?: string;

  @ApiPropertyOptional({ example: "India" })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === "true" || value === 1)
  @Type(() => Boolean)
  isDefault?: boolean;
}
