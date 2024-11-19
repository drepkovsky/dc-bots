import { createGroq } from '@ai-sdk/groq'
import { env } from '../env'
import { createAnthropic } from '@ai-sdk/anthropic'

export const groq = createGroq({
  apiKey: env.GROQ_API_KEY,
})

export const anthropic = createAnthropic({
  apiKey: env.ANTHROPIC_API_KEY,
})

export const MODELS = {
  FAST: {
    provider: groq,
    model: 'llama-3.2-1b-preview',
  }, // For quick completions
  //   DETAILED: 'llama-3.1-70b-versatile', // For complex responses
  //   DETAILED: 'llama-3.1-8b-instant', // For complex responses
  DETAILED: {
    provider: anthropic,
    model: 'claude-3-5-sonnet-20241022',
  }, // For complex responses
} as const
