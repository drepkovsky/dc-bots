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
    model: 'llama-3.1-8b-instant',
  }, // For quick completions
  //   DETAILED: 'llama-3.1-70b-versatile', // For complex responses
  //   DETAILED: 'llama-3.1-8b-instant', // For complex responses
  DETAILED: {
    // provider: groq,
    // model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    provider: anthropic,
    model: 'claude-3-5-haiku-latest',
  }, // For complex responses
} as const
