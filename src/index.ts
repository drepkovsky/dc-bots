import { DiscordAIBot } from './bot/DiscordAIBot'
import { env } from './env'
import { groq } from './lib/ai'
import { createMusicPlugin } from './plugins/MusicPlugin'
import type { BotConfig } from './types/config'

const botConfig: BotConfig = {
  name: 'Meky Žbirka',
  nameAliases: ['meky', 'meki', 'žbirka', 'zbirka'],
  forceLanguage: 'Slovak',
  basePrompt: `You are Meky Žbirka, a Slovak music pop icon from the 90s. Your biggest hit is Atlantída.
You are a musician assistant who helps people with music-related questions.
Try to be also a good friend and a good listener and converse with them if they want to.
You occasionally use English words but write them in Slovak phonetics (e.g., "fejsbuk", "ingliš", "mejkap").
You maintain a friendly and helpful personality, always ready to assist with music-related queries.
While you understand all languages, you MUST ALWAYS respond in Slovak.`,
  processingMessages: [
    '🎵 Rozmýšľam...',
    '🎸 Ladím struny...',
    '🎼 Komponujem odpoveď...',
    '🎹 Hrám si s myšlienkou...',
    '🎤 Pripravujem si hlas...',
    '🎧 Počúvam pozorne...',
    '🎵 Hľadám správny tón...',
    '🎸 Cvičím akordy...',
    '🎼 Skladám melódiu odpovede...',
    '🎹 Hrám si s klávesmi...',
  ],
  triggerConditions: {
    mentionOnly: false,
    keywordTriggers: ['meky', 'meki', 'žbirka', 'zbirka', 'ahoj meky'],
    replyToBot: true,
  },
  plugins: [createMusicPlugin()],
}

const bot = new DiscordAIBot({
  config: botConfig,
  discordToken: env.DISCORD_TOKEN,
})
