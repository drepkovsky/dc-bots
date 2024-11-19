import { DiscordAIBot } from './bot/DiscordAIBot'
import { testConfig } from './test-config'
import { env } from './env'
import { Logger } from './logger'

const logger = new Logger({ context: 'DevEnvironment' })

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error)
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason)
})

async function startDevBot() {
  logger.info('Starting development bot...')

  const bot = new DiscordAIBot({
    config: testConfig,
    discordToken: env.DISCORD_TOKEN,
  })

  logger.info('Development bot initialized')
}

startDevBot().catch((error) => {
  logger.error('Failed to start development bot', error)
  process.exit(1)
})
