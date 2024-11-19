import type { z, ZodObject } from 'zod'

type BotFunction = {
  description: string
  params: ZodObject<any, any, any, any>
  handler: (params: Record<string, any>) => Promise<void>
}

export function createBotFunction<TSchema extends ZodObject<any, any, any, any>>(
  description: string,
  params: TSchema,
  handler: (params: z.infer<TSchema>) => Promise<any> | Promise<void>,
): BotFunction {
  return { description, params, handler }
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
