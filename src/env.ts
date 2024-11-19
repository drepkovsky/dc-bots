import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const env = createEnv({
  server: {
    DISCORD_TOKEN: z.string().min(1),
    GROQ_API_KEY: z.string().min(1),
    ANTHROPIC_API_KEY: z.string().min(1),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  },
  client: {},
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  clientPrefix: 'PUBLIC_',
})
