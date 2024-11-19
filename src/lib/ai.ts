import { createGroq } from '@ai-sdk/groq'
import { env } from '../env'

export const groq = createGroq({
  baseURL: 'https://api.groq.com/openai/v1',
  apiKey: env.GROQ_API_KEY,
})

export const MODELS = {
  FAST: 'llama-3.1-8b-chat', // For quick completions
  DETAILED: 'llama-3.1-70b-versatile', // For complex responses
} as const
