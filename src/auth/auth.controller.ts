import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginUserDto } from './dto/login-user';
import { CreatePasswordResetTokenDto } from './dto/create-password-reset-token.dto';
import { CreateVerificationTokenDto } from './dto/create-verification-token.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() loginUserDto: LoginUserDto) {
    return this.authService.login(loginUserDto);
  }

  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Get('verification-token')
  async getVerificationToken(
    @Query('email') email: string | undefined,
    @Query('token') token: string | undefined,
  ) {
    if (email) {
      return this.authService.getVerificationTokenByEmail(email);
    }
    if (token) {
      return this.authService.getVerificationTokenByToken(token);
    }

    throw new BadRequestException('Email or token must be provided');
  }

  @Get('password-reset-token')
  async getPasswordVerificationToken(
    @Query('token') token: string | undefined,
    @Query('email') email: string | undefined,
  ) {
    if (token) {
      return this.authService.getPasswordResetTokenByToken(token);
    }
    if (email) {
      return this.authService.getPasswordResetTokenByEmail(email);
    }

    throw new BadRequestException('Email or token must be provided');
  }

  @Post('password-reset-token')
  async createPasswordResetToken(
    @Body() createPasswordResetTokenDto: CreatePasswordResetTokenDto,
  ) {
    return this.authService.createPasswordResetToken(
      createPasswordResetTokenDto,
    );
  }

  @Post('verification-token')
  async createVerificationToken(
    @Body() createVerificationTokenDto: CreateVerificationTokenDto,
  ) {
    return this.authService.createVerificationToken(createVerificationTokenDto);
  }

  @Delete('password-reset-token/:id')
  async deletePasswordResetToken(@Param('id') id: string) {
    return this.authService.deletePasswordResetToken(id);
  }

  @Delete('verification-token/:id')
  async deleteVerificationToken(@Param('id') id: string) {
    return this.authService.deleteVerificationToken(id);
  }
}
