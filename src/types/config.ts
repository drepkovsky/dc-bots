import type { z, ZodObject } from 'zod'
import type { MODELS } from '../lib/ai'
import type { DiscordAIBot } from '../bot/DiscordAIBot'

export type BotFunction = {
  description: string
  params: z.ZodType
  handler: (params: z.infer<z.ZodType>, context: BotContext) => Promise<any>
  formatDisplay: (params: z.infer<z.ZodType>) => string
}

export function createBotFunction<TSchema extends z.ZodType>(
  description: string,
  params: TSchema,
  handler: (params: z.infer<TSchema>, context: BotContext) => Promise<any>,
  formatDisplay: (params: z.infer<TSchema>) => string,
): BotFunction {
  return { description, params, handler, formatDisplay }
}

export type BotContext = {
  guildId: string
  channelId: string
  userId: string
  username: string
  member: import('discord.js').GuildMember
  message: import('discord.js').Message
  pendingMessage: import('discord.js').Message
  bot: DiscordAIBot
}

export type Plugin = {
  name: string
  functions: Record<string, BotFunction>
  initialize?: () => Promise<void>
  cleanup?: () => Promise<void>
}

export type BotConfig = {
  name: string
  nameAliases: string[]
  basePrompt: string
  forceLanguage: string
  processingMessages: string[]
  triggerConditions: {
    mentionOnly: boolean
    keywordTriggers: string[]
    replyToBot: boolean
  }
  plugins: Plugin[]
}

export type ProgressUpdate = {
  action: string
  details?: Record<string, any>
  language?: string
}
