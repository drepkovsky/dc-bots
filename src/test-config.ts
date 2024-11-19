import { z } from 'zod'
import type { BotConfig } from './types/config'
import { createMusicPlugin } from './plugins/MusicPlugin'

export const testConfig: BotConfig = {
  name: 'Test Bot',
  nameAliases: ['test', 'testbot'],
  forceLanguage: 'English',
  basePrompt: `You are a test bot. You help with testing functionality.
You should respond in a way that makes it clear you're a test instance.
Always prefix your responses with [TEST]`,
  triggerConditions: {
    mentionOnly: false,
    keywordTriggers: ['test', 'testbot'],
    replyToBot: true,
  },
  plugins: [createMusicPlugin()],
}
