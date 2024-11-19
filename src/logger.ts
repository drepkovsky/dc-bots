import { env } from './env'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LoggerOptions = {
  context: string
}

export class Logger {
  private context: string
  private static level: LogLevel = env.LOG_LEVEL

  constructor(props: LoggerOptions) {
    this.context = props.context
  }

  private formatMessage(level: LogLevel, message: string, data?: any): string {
    const timestamp = new Date().toISOString()
    const dataString = data ? `\n${JSON.stringify(data, null, 2)}` : ''
    return `[${timestamp}] [${level.toUpperCase()}] [${this.context}] ${message}${dataString}`
  }

  debug(message: string, data?: any): void {
    if (Logger.level === 'debug') {
      console.debug(this.formatMessage('debug', message, data))
    }
  }

  info(message: string, data?: any): void {
    if (['debug', 'info'].includes(Logger.level)) {
      console.info(this.formatMessage('info', message, data))
    }
  }

  warn(message: string, data?: any): void {
    if (['debug', 'info', 'warn'].includes(Logger.level)) {
      console.warn(this.formatMessage('warn', message, data))
    }
  }

  error(message: string, error?: Error | any): void {
    if (['debug', 'info', 'warn', 'error'].includes(Logger.level)) {
      console.error(
        this.formatMessage('error', message, {
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                }
              : error,
        }),
      )
    }
  }
}
