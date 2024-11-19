import type { z, ZodObject } from 'zod'

export type BotFunction = {
  description: string
  params: z.ZodType
  handler: (params: z.infer<z.ZodType>, context: BotContext) => Promise<any>
}

export function createBotFunction<TSchema extends z.ZodType>(
  description: string,
  params: TSchema,
  handler: (params: z.infer<TSchema>, context: BotContext) => Promise<any>,
): BotFunction {
  return { description, params, handler }
}

export type BotContext = {
  guildId: string
  channelId: string
  userId: string
  username: string
  member: import('discord.js').GuildMember
  message: import('discord.js').Message
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
  triggerConditions: {
    mentionOnly: boolean
    keywordTriggers: string[]
    replyToBot: boolean
  }
  plugins: Plugin[]
}
