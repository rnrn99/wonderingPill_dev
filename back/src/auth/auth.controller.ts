import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { User as UserModel } from '@prisma/client';
import * as config from 'config';
import { Response } from 'express';
import {
  GetCurrentUser,
  GetCurrentUserId,
  Public,
} from 'src/common/decorators';
import { AccessGuard, RefreshGuard } from 'src/common/guards';
import { AuthService } from './auth.service';
import {
  CreateUserDto,
  CreateUserResponse,
  LogoutResponse,
  RecapchaResponse,
  RefreshResponse,
  SigninResponse,
  SigninUserDto,
  UseRecapchaDto,
} from './dto';
import { Tokens } from './types';

@ApiTags('Auth API')
@Controller('auth')
export class AuthController {
  private logger = new Logger(`AuthController`);
  constructor(private readonly authService: AuthService) {}

  @Public()
  @HttpCode(200)
  @Post('signup')
  @UsePipes(new ValidationPipe())
  @ApiOperation({
    summary: '유저 생성(회원가입) API',
    description: '유저를 생성한다.',
  })
  @ApiResponse({
    status: 200,
    description: '회원가입 성공',
    type: CreateUserResponse,
  })
  @ApiBody({ type: CreateUserDto })
  async signupUser(
    @Body() createUserDto: CreateUserDto,
  ): Promise<CreateUserResponse> {
    const user: UserModel = await this.authService.createUser(createUserDto);
    this.logger.verbose(`User ${user.email} Sign-Up Success!`);
    return {
      statusCode: 200,
      message: '회원가입에 성공했습니다.',
      user: { id: user.id, email: user.email },
    };
  }

  @Public()
  @HttpCode(200)
  @Post('signin')
  @ApiOperation({
    summary: '유저 로그인 API',
    description:
      '유저의 accessToken, refreshToken을 발행하여 cookie에 저장하고 로그인한다.',
  })
  @ApiResponse({
    status: 200,
    description: '로그인 성공',
    type: SigninResponse,
  })
  @ApiBody({ type: SigninUserDto })
  async signinUser(
    @Body() signinUserDto: SigninUserDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SigninResponse> {
    const { accessToken, refreshToken }: Tokens =
      await this.authService.localSignin(signinUserDto);

    // redis: save refresh-token
    // 일단은 db에 저장
    const user: UserModel = await this.authService.saveRefreshToken(
      signinUserDto.email,
      refreshToken,
    );
    let httpOnlyValue;
    if (process.env.NODE_ENV === 'production') {
      httpOnlyValue = true;
    } else {
      httpOnlyValue = false;
    }

    // cookie에 accessToken, refreshToken 저장
    res.cookie('AccessToken', accessToken, {
      maxAge: process.env.JWT_EXPIRESIN || config.get('jwt').expiresIn,
      httpOnly: httpOnlyValue,
    });

    let maxAge;
    if (signinUserDto.isSignin) {
      maxAge =
        process.env.JWT_REFRESH_EXPIRESIN_AUTOSAVE ||
        config.get('jwt-refresh').expiresIn_autosave;
    } else {
      maxAge =
        process.env.JWT_REFRESH_EXPIRESIN ||
        config.get('jwt-refresh').expiresIn;
    }
    res.cookie('RefreshToken', refreshToken, {
      maxAge,
      httpOnly: httpOnlyValue,
    });

    this.logger.verbose(`User ${signinUserDto.email} Sign-In Success!`);

    return {
      statusCode: 200,
      message: '정상적으로 로그인되었습니다.',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        profileImg: user.profileImg,
      },
    };
  }

  @Public()
  @HttpCode(200)
  @Get('refresh')
  @UseGuards(RefreshGuard)
  @ApiOperation({
    summary: 'accessToken 재발행 API',
    description: 'refreshToken이 만료되지 않았다면 accessToken을 재발행한다.',
  })
  @ApiResponse({
    status: 200,
    description: 'Access Token 발행 성공',
    type: RefreshResponse,
  })
  @ApiCookieAuth('accessToken')
  @ApiCookieAuth('refreshToken')
  async refresh(
    @GetCurrentUserId() id: string,
    @GetCurrentUser('refreshToken') refreshToken: string,
  ): Promise<RefreshResponse> {
    const accessToken: string = await this.authService.updateAccessToken(
      id,
      refreshToken,
    );

    let message;
    if (accessToken) {
      message = '정상적으로 access token이 발행되었습니다.';
    } else {
      message = '로그인이 유지되지 않습니다.';
    }
    this.logger.verbose(`User ${id} keep login Success!`);
    return {
      statusCode: 200,
      message,
      accessToken: { accessToken },
    };
  }

  @Get('logout')
  @UseGuards(AccessGuard)
  @ApiOperation({
    summary: '로그아웃 API',
    description: 'refreshToken과 accessToken을 삭제하고 로그아웃한다.',
  })
  @ApiResponse({
    status: 200,
    description: '로그아웃 성공',
    type: LogoutResponse,
  })
  @ApiCookieAuth('refreshToken')
  @ApiCookieAuth('accessToken')
  async logout(
    @GetCurrentUserId() id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LogoutResponse> {
    const checkLogout = await this.authService.logout(id);

    let message;
    if (checkLogout) {
      res.clearCookie('AccessToken');
      res.clearCookie('RefreshToken');

      message = '로그아웃이 완료되었습니다.';
    } else {
      message = '로그아웃에 실패하였습니다.';
    }
    this.logger.verbose(`User ${id} logout Success!`);
    return {
      statusCode: 200,
      message,
      checkLogout: { checkLogout },
    };
  }

  @Get('current')
  @UseGuards(RefreshGuard)
  @ApiOperation({
    summary: '현재 로그인 API',
    description: '현재 로그인되어있는 유저를 불러온다.',
  })
  @ApiResponse({
    status: 200,
    description: '현재 로그인 유저 조회 성공',
  })
  @ApiCookieAuth('refreshToken')
  @ApiCookieAuth('accessToken')
  async current(@GetCurrentUserId() id: string) {
    const user = await this.authService.getUserById(id);
    // 현재 로그인한 유저의 accesstoken 확인하고 재발행하는 pipe/guard 필요
    return {
      statusCode: 200,
      message: '현재 로그인 유저 조회에 성공했습니다.',
      user: {
        id,
        email: user.email,
        name: user.name,
        profileImg: user.profileImg,
      },
    };
  }

  // recaptcha를 guard로 대체 가능! 비용 절감
  // 일단은 api로 놔둠
  @HttpCode(200)
  @Post('recaptcha-v2')
  @ApiOperation({
    summary: 'Recaptcha v2 요청 API',
    description: 'Recaptcha v2에 인증을 요청하고 판별한다.',
  })
  @ApiResponse({
    status: 200,
    description: '회원가입 성공',
    type: RecapchaResponse,
  })
  @ApiBody({ type: UseRecapchaDto })
  async verifyRecaptchaV2(@Body() useRecapchaDto: UseRecapchaDto) {
    const success = await this.authService.sendRecaptchaV2(useRecapchaDto);

    this.logger.verbose(`recaptcha v3 verify human Success!
    Payload: ${JSON.stringify({ success })}`);

    return {
      statusCode: 200,
      message: '정상적인 트래픽 활동입니다.',
      recaptchav2: { success },
    };
  }

  // @Post('kakao')
  // async kakao() {}

  // @Post('google')
  // async google() {}

  // @Post('send-sms')
  // async sendSMS() {}

  // @Post('verify-code')
  // async verifyCode() {}

  // @Get('get-user')
  // async getUser() {}

  // @Post('send-email')
  // async sendEmail() {}
}
