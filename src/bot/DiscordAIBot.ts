import { generateText, streamText, tool } from 'ai'
import { Client, type Message } from 'discord.js'
import { groq, MODELS } from '../lib/ai'
import type { BotConfig, Plugin } from '../types/config'
import type { CoreMessage } from 'ai'
import { Logger } from '../logger'

type DiscordAIBotProps = {
  config: BotConfig
  discordToken: string
}

export class DiscordAIBot {
  private client: Client
  private config: BotConfig
  private pluginTools: Record<string, any> = {}
  private logger: Logger

  constructor(props: DiscordAIBotProps) {
    this.logger = new Logger({ context: 'DiscordAIBot' })
    this.client = new Client({
      intents: ['GuildMessages', 'MessageContent', 'GuildVoiceStates'],
    })
    this.config = props.config
    this.initializeBot(props.discordToken)
  }

  private async initializeBot(token: string): Promise<void> {
    this.logger.info('Initializing bot', { name: this.config.name })

    for (const plugin of this.config.plugins) {
      this.logger.debug('Initializing plugin', { pluginName: plugin.name })
      if (plugin.initialize) {
        await plugin.initialize()
      }
      this.registerPluginTools(plugin)
    }

    this.client.on('messageCreate', this.handleMessage.bind(this))

    this.client.on('shutdown', async () => {
      this.logger.info('Bot shutting down, cleaning up plugins')
      for (const plugin of this.config.plugins) {
        if (plugin.cleanup) {
          await plugin.cleanup()
        }
      }
    })

    try {
      await this.client.login(token)
      this.logger.info('Bot successfully logged in')
    } catch (error) {
      this.logger.error('Failed to login to Discord', error)
      throw error
    }
  }

  private registerPluginTools(plugin: Plugin): void {
    for (const [funcName, funcConfig] of Object.entries(plugin.functions)) {
      this.pluginTools[`${plugin.name}_${funcName}`] = tool({
        description: funcConfig.description,
        parameters: funcConfig.params,
        execute: async (params: Record<string, any>) => {
          const result = await funcConfig.handler(params)
          return result
        },
      })
    }
  }

  private createTools() {
    return {
      ...this.pluginTools,
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return

    this.logger.debug('Received message', {
      content: message.content,
      author: message.author.username,
      channelId: message.channelId,
    })

    const isRelevant = await this.checkMessageRelevance(message.content)
    if (!isRelevant) {
      this.logger.debug('Message not relevant, skipping')
      return
    }

    const needsDetailedResponse = await this.needsDetailedProcessing(message.content)
    this.logger.debug('Message processing type determined', { needsDetailedResponse })

    const pendingMessage = await message.reply('Processing...')
    const tools = this.createTools()

    try {
      const result = await streamText({
        model: groq(needsDetailedResponse ? MODELS.DETAILED : MODELS.FAST),
        system: `${this.config.basePrompt}`,
        prompt: message.content,
        tools,
        maxSteps: needsDetailedResponse ? 5 : 2,
        temperature: needsDetailedResponse ? 0.7 : 0.4,
        onStepFinish: async ({ text }) => {
          if (text.trim()) {
            await pendingMessage.edit(text)
          }
        },
      })

      const finalResponse = await result.text
      await pendingMessage.edit(finalResponse)
      this.logger.debug('Successfully processed message', {
        originalMessage: message.content,
        response: finalResponse,
      })
    } catch (error) {
      this.logger.error('Error processing message', error)
      await pendingMessage.edit('Sorry, I encountered an error while processing your message.')
    }
  }

  private async checkMessageRelevance(content: string): Promise<boolean> {
    const nameMatches = [
      this.config.name.toLowerCase(),
      ...this.config.nameAliases.map((alias) => alias.toLowerCase()),
    ]

    const contentLower = content.toLowerCase()
    if (nameMatches.some((name) => contentLower.includes(name))) {
      return true
    }

    const { text } = await generateText({
      model: groq(MODELS.FAST),
      system: `You are ${this.config.name}. Your task is to determine if the message is directed at you. You respond to: ${nameMatches.join(', ')}. Respond with true or false only.`,
      prompt: content,
      maxTokens: 5,
      temperature: 0.1,
    })

    return text.toLowerCase().includes('true')
  }

  private async needsDetailedProcessing(content: string): Promise<boolean> {
    const { text } = await generateText({
      model: groq(MODELS.FAST),
      system:
        'Determine if this request requires complex processing (like function calls, multi-step reasoning, or detailed explanations). Respond with true or false only.',
      prompt: content,
      maxTokens: 5,
      temperature: 0.1,
    })

    return text.toLowerCase().includes('true')
  }
}
