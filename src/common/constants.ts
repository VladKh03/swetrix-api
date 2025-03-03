import { ClickHouse } from 'clickhouse'
import Redis from 'ioredis'
import { hash } from 'blake3'
import * as _toNumber from 'lodash/toNumber'

import { getSelfhostedUUID } from './utils'

require('dotenv').config()

const redis = new Redis(
  _toNumber(process.env.REDIS_PORT),
  process.env.REDIS_HOST,
  {
    password: process.env.REDIS_PASSWORD,
    username: process.env.REDIS_USER,
  },
)

redis.defineCommand('countKeysByPattern', {
  numberOfKeys: 0,
  lua: "return #redis.call('keys', ARGV[1])",
})

const clickhouse = new ClickHouse({
  url: process.env.CLICKHOUSE_HOST,
  port: _toNumber(process.env.CLICKHOUSE_PORT),
  debug: false,
  basicAuth: {
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
  },
  isUseGzip: false,
  format: 'json',
  raw: false,
  config: {
    session_timeout: 60,
    output_format_json_quote_64bit_integers: 0,
    enable_http_compression: 0,
    database: process.env.CLICKHOUSE_DATABASE,
  },
})

const isSelfhosted = Boolean(process.env.SELFHOSTED)
const isTgTokenPresent = Boolean(process.env.TG_BOT_TOKEN)
const isNewRelicEnabled = Boolean(process.env.USE_NEW_RELIC)
const isDevelopment = process.env.NODE_ENV === 'development'
const PRODUCTION_ORIGIN = process.env.CLIENT_URL || 'https://swetrix.com'

const CLICKHOUSE_INIT_QUERIES = [
  'CREATE DATABASE IF NOT EXISTS analytics',

  // The traffic data table
  `CREATE TABLE IF NOT EXISTS analytics.analytics
  (
    sid Nullable(String),
    pid FixedString(12),
    pg Nullable(String),
    dv Nullable(String),
    br Nullable(String),
    os Nullable(String),
    lc Nullable(String),
    ref Nullable(String),
    so Nullable(String),
    me Nullable(String),
    ca Nullable(String),
    cc Nullable(FixedString(2)),
    sdur Nullable(UInt32), 
    unique UInt8,
    created DateTime
  )
  ENGINE = MergeTree()
  PARTITION BY toYYYYMM(created)
  ORDER BY (pid, created);`,

  // Custom events table
  `CREATE TABLE IF NOT EXISTS analytics.customEV
  (
    pid FixedString(12),
    ev String,
    pg Nullable(String),
    dv Nullable(String),
    br Nullable(String),
    os Nullable(String),
    lc Nullable(String),
    ref Nullable(String),
    so Nullable(String),
    me Nullable(String),
    ca Nullable(String),
    cc Nullable(FixedString(2)),
    created DateTime
  )
  ENGINE = MergeTree()
  PARTITION BY toYYYYMM(created)
  ORDER BY (pid, created);`,

  // The performance data table
  `CREATE TABLE IF NOT EXISTS analytics.performance
  (
    pid FixedString(12),
    pg Nullable(String),
    dv Nullable(String),
    br Nullable(String),
    cc Nullable(FixedString(2)),
    dns Nullable(UInt32),
    tls Nullable(UInt32),
    conn Nullable(UInt32),
    response Nullable(UInt32),
    render Nullable(UInt32),
    domLoad Nullable(UInt32),
    pageLoad Nullable(UInt32),
    ttfb Nullable(UInt32),
    created DateTime
  )
  ENGINE = MergeTree()
  PARTITION BY toYYYYMM(created)
  ORDER BY (pid, created);`,

  // Project data table (used for self-hosted only)
  isSelfhosted &&
    `CREATE TABLE IF NOT EXISTS analytics.project
  (
      id FixedString(12),
      name String,
      origins String,
      active Int8,
      public Int8,
      created DateTime
  )
  ENGINE = MergeTree()
  PARTITION BY toYYYYMM(created)
  ORDER BY (created);`,
]

const initialiseClickhouse = async () => {
  console.log('Initialising Clickhouse')

  for (const query of CLICKHOUSE_INIT_QUERIES) {
    if (query) {
      await clickhouse.query(query).toPromise()
    }
  }

  console.log('Initialising Clickhouse: DONE')
  console.log(`Swetrix API version is: ${process.env.npm_package_version}`)
}

initialiseClickhouse()

const SELFHOSTED_EMAIL = process.env.EMAIL
const SELFHOSTED_PASSWORD = process.env.PASSWORD
const UUIDV5_NAMESPACE = '912c64c1-73fd-42b6-859f-785f839a9f68'
const DEFAULT_SELFHOSTED_UUID = 'deadbeef-dead-beef-dead-beefdeadbeef'

const SELFHOSTED_UUID = isSelfhosted
  ? getSelfhostedUUID()
  : ''

const TWO_FACTOR_AUTHENTICATION_APP_NAME =
  process.env.TWO_FACTOR_AUTHENTICATION_APP_NAME

const JWT_LIFE_TIME = 7 * 24 * 60 * 60
const HISTORY_LIFE_TIME_DAYS = 30

const ORIGINS_REGEX =
  /^(?=.{1,255}$)[0-9A-Za-z\:](?:(?:[0-9A-Za-z\:]|-){0,61}[0-9A-Za-z])?(?:\.[0-9A-Za-z\:](?:(?:[0-9A-Za-z]|-){0,61}[0-9A-Za-z])?)*\.?$/
const IP_REGEX =
  /^(([12]?[0-9]{1,2}|2[0-4][0-9]|25[0-5])(\.|\/)){4}([1-2]?[0-9]|3[0-2])$/
const PID_REGEX = /^(?!.*--)[a-zA-Z0-9-]{12}$/
const isValidPID = (pid: string) => PID_REGEX.test(pid)

// redis keys
const getRedisProjectKey = (pid: string) => `pid_${pid}`
const getRedisUserCountKey = (uid: string) => `user_c_${uid}`
const getRedisCaptchaKey = (token: string) => `captcha_${hash(token)}`

const REDIS_LOG_DATA_CACHE_KEY = 'log_cache'
const REDIS_LOG_CAPTCHA_CACHE_KEY = 'log:captcha'
const REDIS_LOG_PERF_CACHE_KEY = 'perf_cache'
const REDIS_LOG_CUSTOM_CACHE_KEY = 'log_custom_cache_v2'
const REDIS_SESSION_SALT_KEY = 'log_salt' // is updated every 24 hours
const REDIS_USERS_COUNT_KEY = 'stats:users_count'
const REDIS_PROJECTS_COUNT_KEY = 'stats:projects_count'
const REDIS_PAGEVIEWS_COUNT_KEY = 'stats:pageviews'
const REDIS_PERFORMANCE_COUNT_KEY = 'stats:performance'

// Captcha service
const CAPTCHA_SALT = process.env.CAPTCHA_SALT
const CAPTCHA_ENCRYPTION_KEY = process.env.CAPTCHA_ENCRYPTION_KEY

// 3600 sec -> 1 hour
const redisProjectCacheTimeout = 3600

// 15 minutes
const redisProjectCountCacheTimeout = 900

// 30 minues -> the amount of time analytics requests within one session are counted as non-unique
const UNIQUE_SESSION_LIFE_TIME = 1800

// 35 seconds
const HEARTBEAT_SID_LIFE_TIME = 35

// how often can user request a fresh GDPR export of their data; in days.
const GDPR_EXPORT_TIMEFRAME = 14

// send email warning when 85% of events in tier are used
const SEND_WARNING_AT_PERC = 85

const PROJECT_INVITE_EXPIRE = 48

const CAPTCHA_COOKIE_KEY = 'swetrix-captcha-token'
const CAPTCHA_TOKEN_LIFETIME = 300 // seconds (5 minutes).
const CAPTCHA_SECRET_KEY_LENGTH = 50

export {
  clickhouse,
  JWT_LIFE_TIME,
  HISTORY_LIFE_TIME_DAYS,
  redis,
  isValidPID,
  getRedisProjectKey,
  redisProjectCacheTimeout,
  UNIQUE_SESSION_LIFE_TIME,
  REDIS_LOG_DATA_CACHE_KEY,
  REDIS_LOG_CAPTCHA_CACHE_KEY,
  GDPR_EXPORT_TIMEFRAME,
  getRedisUserCountKey,
  redisProjectCountCacheTimeout,
  REDIS_LOG_CUSTOM_CACHE_KEY,
  REDIS_SESSION_SALT_KEY,
  HEARTBEAT_SID_LIFE_TIME,
  isSelfhosted,
  UUIDV5_NAMESPACE,
  SELFHOSTED_EMAIL,
  SELFHOSTED_PASSWORD,
  SELFHOSTED_UUID,
  CLICKHOUSE_INIT_QUERIES,
  REDIS_USERS_COUNT_KEY,
  REDIS_PROJECTS_COUNT_KEY,
  REDIS_PAGEVIEWS_COUNT_KEY,
  SEND_WARNING_AT_PERC,
  PROJECT_INVITE_EXPIRE,
  TWO_FACTOR_AUTHENTICATION_APP_NAME,
  IP_REGEX,
  isNewRelicEnabled,
  ORIGINS_REGEX,
  REDIS_LOG_PERF_CACHE_KEY,
  REDIS_PERFORMANCE_COUNT_KEY,
  CAPTCHA_SALT,
  CAPTCHA_ENCRYPTION_KEY,
  isDevelopment,
  getRedisCaptchaKey,
  CAPTCHA_COOKIE_KEY,
  CAPTCHA_TOKEN_LIFETIME,
  PID_REGEX,
  CAPTCHA_SECRET_KEY_LENGTH,
  PRODUCTION_ORIGIN,
  isTgTokenPresent,
  DEFAULT_SELFHOSTED_UUID,
}
