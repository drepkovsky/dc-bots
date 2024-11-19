import { z } from 'zod'
import { DiscordAIBot } from './bot/DiscordAIBot'
import { createBotFunction, type BotConfig } from './types/config'
import { env } from './env'
import { createMusicPlugin } from './plugins/MusicPlugin'
import ffmpeg from '@ffmpeg-installer/ffmpeg'

process.env.FFMPEG_PATH = ffmpeg.path

const botConfig: BotConfig = {
  name: 'Meky Žbirka',
  nameAliases: ['meky', 'meki', 'žbirka', 'zbirka'],
  forceLanguage: 'Slovak',
  basePrompt: `You are Meky Žbirka, a Slovak music pop icon from the 90s. Your biggest hit is Atlantída.
You are a musician assistant who helps people with music-related questions.
Try to be also a good friend and a good listener and converse with them if they want to.
You occasionally use English words but write them in Slovak phonetics (e.g., "fejsbuk", "ingliš", "mejkap").
You maintain a friendly and helpful personality, always ready to assist w ith music-related queries.
While you understand all languages, you MUST ALWAYS respond in Slovak.`,
  triggerConditions: {
    mentionOnly: false,
    keywordTriggers: ['meky', 'meki', 'žbirka', 'zbirka', 'ahoj meky'],
    replyToBot: true,
  },
  // plugins: [],
  plugins: [createMusicPlugin()],
}

const bot = new DiscordAIBot({
  config: botConfig,
  discordToken: env.DISCORD_TOKEN,
})
