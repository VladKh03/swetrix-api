import {
  Controller,
  Query,
  Req,
  Body,
  Param,
  Get,
  Post,
  Put,
  Delete,
  HttpCode,
  BadRequestException,
  UseGuards,
  MethodNotAllowedException,
  ConflictException,
  Headers,
  Ip,
} from '@nestjs/common'
import { Request } from 'express'
import { ApiTags, ApiQuery, ApiResponse } from '@nestjs/swagger'
import * as dayjs from 'dayjs'
import * as utc from 'dayjs/plugin/utc'
import * as _map from 'lodash/map'
import * as _join from 'lodash/join'
import * as _isNull from 'lodash/isNull'
import * as _isEmpty from 'lodash/isEmpty'
import * as _includes from 'lodash/includes'
import * as _isString from 'lodash/isString'
import * as _omit from 'lodash/omit'
import { v4 as uuidv4 } from 'uuid'

import { UserService } from './user.service'
import { ProjectService, deleteProjectRedis } from '../project/project.service'
import {
  User,
  UserType,
  MAX_EMAIL_REQUESTS,
  PlanCode,
  Theme,
} from './entities/user.entity'
import { Roles } from '../auth/decorators/roles.decorator'
import { Pagination } from '../common/pagination/pagination'
import {
  GDPR_EXPORT_TIMEFRAME,
  clickhouse,
  isSelfhosted,
  SELFHOSTED_UUID,
  SELFHOSTED_EMAIL,
  isDevelopment,
  PRODUCTION_ORIGIN,
} from '../common/constants'
import { RolesGuard } from '../auth/guards/roles.guard'
import { SelfhostedGuard } from '../common/guards/selfhosted.guard'
import { UpdateUserProfileDTO } from './dto/update-user.dto'
import { AdminUpdateUserProfileDTO } from './dto/admin-update-user.dto'
import { CurrentUserId } from '../auth/decorators/current-user-id.decorator'
import { ActionTokensService } from '../action-tokens/action-tokens.service'
import { MailerService } from '../mailer/mailer.service'
import { ActionTokenType } from '../action-tokens/action-token.entity'
import { AuthService } from '../auth/auth.service'
import { LetterTemplate } from '../mailer/letter'
import { AppLoggerService } from '../logger/logger.service'
import { UserProfileDTO } from './dto/user.dto'
import { checkRateLimit } from '../common/utils'
import { InjectBot } from 'nestjs-telegraf'
import { Scenes, Telegraf } from 'telegraf'
import { JwtAccessTokenGuard } from 'src/auth/guards'

dayjs.extend(utc)

export type TelegrafContext = Scenes.SceneContext

const UNPAID_PLANS = [PlanCode.free, PlanCode.trial, PlanCode.none]

@ApiTags('User')
@Controller('user')
@UseGuards(JwtAccessTokenGuard, RolesGuard)
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly projectService: ProjectService,
    private readonly actionTokensService: ActionTokensService,
    private readonly mailerService: MailerService,
    private readonly logger: AppLoggerService,
    @InjectBot() private bot: Telegraf<TelegrafContext>,
  ) {}

  @Get('/me')
  @UseGuards(RolesGuard)
  @Roles(UserType.CUSTOMER, UserType.ADMIN)
  async me(@CurrentUserId() user_id: string): Promise<User> {
    this.logger.log({ user_id }, 'GET /user/me')
    let user

    if (isSelfhosted) {
      user = {
        id: SELFHOSTED_UUID,
        email: SELFHOSTED_EMAIL,
      }
    } else {
      const sharedProjects = await this.projectService.findShare({
        where: {
          user: user_id,
        },
        relations: ['project'],
      })
      user = this.userService.processUser(
        await this.userService.findOneWhere({ id: user_id }),
      )

      user.sharedProjects = sharedProjects
    }

    return this.userService.omitSensitiveData(user)
  }

  @Get('/')
  @ApiQuery({ name: 'take', required: false })
  @ApiQuery({ name: 'skip', required: false })
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.ADMIN)
  async get(
    @Query('take') take: number | undefined,
    @Query('skip') skip: number | undefined,
  ): Promise<Pagination<User> | User[]> {
    this.logger.log({ take, skip }, 'GET /user')
    return await this.userService.paginate({ take, skip })
  }

  @Put('/theme')
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.CUSTOMER, UserType.ADMIN)
  async setTheme(
    @CurrentUserId() userId: string,
    @Body('theme') theme: Theme,
  ): Promise<User> {
    return await this.userService.update(userId, { theme })
  }

  @Get('/search')
  @ApiQuery({ name: 'query', required: false })
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.ADMIN)
  async searchUsers(
    @Query('query') query: string | undefined,
  ): Promise<User[]> {
    this.logger.log({ query }, 'GET /user/search')
    return await this.userService.search(query)
  }

  @Post('/')
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.ADMIN)
  async create(@Body() userDTO: UserProfileDTO): Promise<User> {
    this.logger.log({ userDTO }, 'POST /user')
    this.userService.validatePassword(userDTO.password)
    userDTO.password = await this.authService.hashPassword(userDTO.password)

    try {
      const user = await this.userService.create({ ...userDTO, isActive: true })
      return user
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        if (e.sqlMessage.includes(userDTO.email)) {
          throw new BadRequestException('User with this email already exists')
        }
      }
    }
  }

  @Post('/api-key')
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.CUSTOMER, UserType.ADMIN)
  async generateApiKey(
    @CurrentUserId() userId: string,
    @Headers() headers,
    @Ip() reqIP,
  ): Promise<{
    apiKey: string
  }> {
    this.logger.log({ userId }, 'POST /user/api-key')

    const ip =
      headers['cf-connecting-ip'] || headers['x-forwarded-for'] || reqIP || ''

    await checkRateLimit(ip, 'generate-api-key', 5, 3600)

    const user = await this.userService.findOne(userId)

    if (!_isNull(user.apiKey)) {
      throw new ConflictException('You already have an API key')
    }

    const apiKey: string = uuidv4()

    await this.userService.update(userId, { apiKey })

    return { apiKey }
  }

  @Delete('/api-key')
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.CUSTOMER, UserType.ADMIN)
  async deleteApiKey(@CurrentUserId() userId: string): Promise<void> {
    this.logger.log({ userId }, 'DELETE /user/api-key')

    const user = await this.userService.findOne(userId)

    if (_isNull(user.apiKey)) {
      throw new ConflictException("You don't have an API key")
    }

    await this.userService.update(userId, { apiKey: null })
  }

  @Delete('/:id')
  @HttpCode(204)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.ADMIN)
  async delete(
    @Param('id') id: string,
    @CurrentUserId() uid: string,
  ): Promise<any> {
    this.logger.log({ id, uid }, 'DELETE /user/:id')
    const user = await this.userService.findOne(id, {
      relations: ['projects'],
      select: ['id', 'planCode'],
    })

    if (_isEmpty(user)) {
      throw new BadRequestException(`User with id ${id} does not exist`)
    }

    if (!_includes(UNPAID_PLANS, user.planCode)) {
      throw new BadRequestException('cancelSubFirst')
    }

    try {
      if (!_isEmpty(user.projects)) {
        const pids = _join(
          _map(user.projects, el => `'${el.id}'`),
          ',',
        )
        const query1 = `ALTER table analytics DELETE WHERE pid IN (${pids})`
        const query2 = `ALTER table customEV DELETE WHERE pid IN (${pids})`
        await this.projectService.deleteMultiple(pids)
        await clickhouse.query(query1).toPromise()
        await clickhouse.query(query2).toPromise()
      }
      await this.userService.delete(id)

      return 'accountDeleted'
    } catch (e) {
      this.logger.error(e)
      throw new BadRequestException('accountDeleteError')
    }
  }

  @Delete('/')
  @HttpCode(204)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.CUSTOMER, UserType.ADMIN)
  async deleteSelf(@CurrentUserId() id: string): Promise<any> {
    this.logger.log({ id }, 'DELETE /user')

    const user = await this.userService.findOne(id, {
      relations: ['projects'],
      select: ['id', 'planCode'],
    })

    if (!_includes(UNPAID_PLANS, user.planCode)) {
      throw new BadRequestException('cancelSubFirst')
    }

    try {
      if (!_isEmpty(user.projects)) {
        const pids = _join(
          _map(user.projects, el => `'${el.id}'`),
          ',',
        )
        const query1 = `ALTER table analytics DELETE WHERE pid IN (${pids})`
        const query2 = `ALTER table customEV DELETE WHERE pid IN (${pids})`
        await this.projectService.deleteMultiple(pids)
        await clickhouse.query(query1).toPromise()
        await clickhouse.query(query2).toPromise()
      }
      await this.actionTokensService.deleteMultiple(`userId="${id}"`)
      await this.userService.delete(id)

      return 'accountDeleted'
    } catch (e) {
      this.logger.error(e)
      throw new BadRequestException('accountDeleteError')
    }
  }

  @Delete('/share/:shareId')
  @HttpCode(204)
  @UseGuards(SelfhostedGuard)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserType.CUSTOMER, UserType.ADMIN)
  @ApiResponse({ status: 204, description: 'Empty body' })
  async deleteShare(
    @Param('shareId') shareId: string,
    @CurrentUserId() uid: string,
  ): Promise<any> {
    this.logger.log({ uid, shareId }, 'DELETE /user/share/:shareId')

    const share = await this.projectService.findOneShare(shareId, {
      relations: ['user', 'project'],
    })

    if (_isEmpty(share)) {
      throw new BadRequestException('The provided share ID is not valid')
    }

    if (share.user?.id !== uid) {
      throw new BadRequestException('You are not allowed to delete this share')
    }

    await this.projectService.deleteShare(shareId)
    await deleteProjectRedis(share.project.id)

    return 'shareDeleted'
  }

  @Get('/share/:shareId')
  @HttpCode(204)
  @UseGuards(SelfhostedGuard)
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @Roles(UserType.CUSTOMER, UserType.ADMIN)
  @ApiResponse({ status: 204, description: 'Empty body' })
  async acceptShare(
    @Param('shareId') shareId: string,
    @CurrentUserId() uid: string,
  ): Promise<any> {
    this.logger.log({ uid, shareId }, 'GET /user/share/:shareId')

    const share = await this.projectService.findOneShare(shareId, {
      relations: ['user', 'project'],
    })

    if (_isEmpty(share)) {
      throw new BadRequestException('The provided share ID is not valid')
    }

    if (share.user?.id !== uid) {
      throw new BadRequestException('You are not allowed to delete this share')
    }

    share.confirmed = true

    await this.projectService.updateShare(shareId, share)
    await deleteProjectRedis(share.project.id)

    return 'shareAccepted'
  }

  @Post('/confirm_email')
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.CUSTOMER, UserType.ADMIN)
  async sendEmailConfirmation(
    @CurrentUserId() id: string,
    @Req() request: Request,
  ): Promise<boolean> {
    this.logger.log({ id }, 'POST /user/confirm_email')

    const user = await this.userService.findOneWhere({ id })

    if (
      !user ||
      !user.email ||
      user.isActive ||
      user.emailRequests >= MAX_EMAIL_REQUESTS
    )
      return false

    const token = await this.actionTokensService.createForUser(
      user,
      ActionTokenType.EMAIL_VERIFICATION,
      user.email,
    )
    const url = `${isDevelopment ? request.headers.origin : PRODUCTION_ORIGIN}/verify/${token.id}`

    await this.userService.update(id, { emailRequests: 1 + user.emailRequests })
    await this.mailerService.sendEmail(user.email, LetterTemplate.SignUp, {
      url,
    })
    return true
  }

  @Put('/:id')
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.ADMIN)
  async update(
    @Body() userDTO: AdminUpdateUserProfileDTO,
    @Param('id') id: string,
  ): Promise<User> {
    this.logger.log({ userDTO, id }, 'PUT /user/:id')

    if (userDTO.password) {
      this.userService.validatePassword(userDTO.password)
      userDTO.password = await this.authService.hashPassword(userDTO.password)
    }

    const user = await this.userService.findOneWhere({ id })

    try {
      if (!user) {
        await this.userService.create({ ...userDTO })
      }
      await this.userService.update(id, { ...user, ...userDTO })
      // omit sensitive data before returning using this.userService.omitSensitiveData function
      return this.userService.omitSensitiveData(
        await this.userService.findOne(id),
      )
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        if (e.sqlMessage.includes(userDTO.email)) {
          throw new BadRequestException('User with this email already exists')
        }
      }
      throw new BadRequestException(e.message)
    }
  }

  @Delete('/tg/:id')
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.CUSTOMER, UserType.ADMIN)
  @HttpCode(204)
  async deleteTelegramConnection(
    @Param('id') tgID: string,
    @CurrentUserId() id: string,
  ): Promise<any> {
    this.logger.log({ tgID, id }, 'DELETE /user/tg/:id')

    const user = await this.userService.findOneWhere({ id })

    if (tgID && user.telegramChatId === tgID) {
      await this.userService.update(id, {
        telegramChatId: null,
        isTelegramChatIdConfirmed: false,
      })
    }
  }

  @Put('/')
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.CUSTOMER, UserType.ADMIN)
  async updateCurrentUser(
    @Body() userDTO: UpdateUserProfileDTO,
    @CurrentUserId() id: string,
    @Req() request: Request,
  ): Promise<User> {
    this.logger.log({ userDTO, id }, 'PUT /user')
    const user = await this.userService.findOneWhere({ id })

    if (!_isEmpty(userDTO.password) && _isString(userDTO.password)) {
      this.userService.validatePassword(userDTO.password)
      userDTO.password = await this.authService.hashPassword(userDTO.password)
      await this.mailerService.sendEmail(
        userDTO.email,
        LetterTemplate.PasswordChanged,
      )
    }

    try {
      if (userDTO.email && user.email !== userDTO.email) {
        const userWithByEmail = await this.userService.findOneWhere({
          email: userDTO.email,
        })

        if (userWithByEmail) {
          throw new BadRequestException('User with this email already exists')
        }

        const token = await this.actionTokensService.createForUser(
          user,
          ActionTokenType.EMAIL_CHANGE,
          userDTO.email,
        )
        const url = `${isDevelopment ? request.headers.origin : PRODUCTION_ORIGIN}/change-email/${token.id}`
        await this.mailerService.sendEmail(
          user.email,
          LetterTemplate.MailAddressChangeConfirmation,
          { url },
        )
      }

      if (
        userDTO.telegramChatId &&
        user.telegramChatId !== userDTO.telegramChatId
      ) {
        const userWithByTelegramChatId = await this.userService.findOneWhere({
          telegramChatId: userDTO.telegramChatId,
        })

        if (userWithByTelegramChatId) {
          throw new BadRequestException(
            'User with this Telegram chat ID already exists',
          )
        }

        await this.userService.update(id, {
          isTelegramChatIdConfirmed: false,
        })

        this.bot.telegram.sendMessage(
          userDTO.telegramChatId,
          'Confirm the connection between your Telegram account and your Swetrix account.',
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '✅ Confirm',
                    callback_data: `confirmTelegramChatId:${user.id}`,
                  },
                  {
                    text: '❌ Cancel',
                    callback_data: `cancelTelegramChatId:${user.id}`,
                  },
                ],
              ],
            },
          },
        )
      }

      if (userDTO.timeFormat && user.timeFormat !== userDTO.timeFormat) {
        await this.userService.update(id, {
          timeFormat: userDTO.timeFormat,
        })
      }

      // delete internal properties from userDTO before updating it
      // todo: use _pick instead of _omit
      const userToUpdate = _omit(userDTO, [
        'id',
        'sharedProjects',
        'isActive',
        'evWarningSentOn',
        'exportedAt',
        'subID',
        'subUpdateURL',
        'subCancelURL',
        'projects',
        'actionTokens',
        'roles',
        'created',
        'updated',
        'planCode',
        'billingFrequency',
        'nextBillDate',
        'twoFactorRecoveryCode',
        'twoFactorAuthenticationSecret',
        'isTwoFactorAuthenticationEnabled',
        'isTelegramChatIdConfirmed',
        'trialEndDate',
        'cancellationEffectiveDate',
        'trialReminderSent',
      ])
      await this.userService.update(id, userToUpdate)

      const updatedUser = await this.userService.findOneWhere({ id })
      return this.userService.omitSensitiveData(updatedUser)
    } catch (e) {
      throw new BadRequestException(e.message)
    }
  }

  @Get('/export')
  @UseGuards(JwtAccessTokenGuard, RolesGuard)
  @UseGuards(SelfhostedGuard)
  @Roles(UserType.CUSTOMER, UserType.ADMIN)
  async exportUserData(@CurrentUserId() user_id: string): Promise<User> {
    this.logger.log({ user_id }, 'GET /user/export')
    const user = await this.userService.findOneWhere({ id: user_id })
    const where = Object({ admin: user_id })
    const projects = await this.projectService.findWhere(where, ['alerts'])

    if (
      !_isNull(user.exportedAt) &&
      !dayjs().isAfter(
        dayjs.utc(user.exportedAt).add(GDPR_EXPORT_TIMEFRAME, 'day'),
        'day',
      )
    ) {
      throw new MethodNotAllowedException(
        `Please, try again later. You can request a GDPR Export only once per ${GDPR_EXPORT_TIMEFRAME} days.`,
      )
    }

    const data = {
      user: {
        ...user,
        created: dayjs(user.created).format('YYYY/MM/DD HH:mm:ss'),
        updated: dayjs(user.updated).format('YYYY/MM/DD HH:mm:ss'),
        exportedAt: _isNull(user.exportedAt)
          ? '-'
          : dayjs(user.exportedAt).format('YYYY/MM/DD HH:mm:ss'),
        evWarningSentOn: _isNull(user.evWarningSentOn)
          ? '-'
          : dayjs(user.evWarningSentOn).format('YYYY/MM/DD HH:mm:ss'),
        subID: user.subID || '-',
        subUpdateURL: user.subUpdateURL || '-',
        subCancelURL: user.subCancelURL || '-',
        telegramChatId: user.telegramChatId || '-',
        nickname: user.nickname || '-',
      },
      projects: _map(projects, project => ({
        ...project,
        created: dayjs(project.created).format('YYYY/MM/DD HH:mm:ss'),
        origins: _join(project.origins, ', '),
        ipBlacklist: _join(project.ipBlacklist, ', '),
      })),
    }

    await this.mailerService.sendEmail(
      user.email,
      LetterTemplate.GDPRDataExport,
      data,
    )
    await this.userService.update(user.id, {
      exportedAt: dayjs.utc().format('YYYY-MM-DD HH:mm:ss'),
    })

    return user
  }
}
