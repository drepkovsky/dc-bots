import type { VoiceConnection } from '@discordjs/voice'
import { generateText, streamText, tool } from 'ai'
import { Client, GatewayIntentBits, type Message } from 'discord.js'
import { MODELS } from '../lib/ai'
import { Logger } from '../logger'
import type { BotConfig, BotContext, Plugin, ProgressUpdate } from '../types/config'

type DiscordAIBotProps = {
  config: BotConfig
  discordToken: string
}

type ConversationState = {
  lastInteractionTime: number
  context: string
  channelId: string
}

type MessagePart =
  | {
      type: 'text-delta'
      text: string
    }
  | {
      type: 'tool-call'
      toolName: string
      toolId: string
      args: Record<string, any>
    }

export class DiscordAIBot {
  private client: Client
  private config: BotConfig
  private pluginTools: Record<string, any> = {}
  private logger: Logger
  private voiceConnections: Map<string, VoiceConnection> = new Map()
  private conversations: Map<string, ConversationState> = new Map()
  private readonly CONVERSATION_TIMEOUT = 5 * 60 * 1000 // 5 minutes
  private readonly MAX_CONTEXT_LENGTH = 12000

  constructor(props: DiscordAIBotProps) {
    this.logger = new Logger({ context: 'DiscordAIBot' })
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
      ],
    })
    this.config = props.config
    this.initializeBot(props.discordToken)
  }

  private async initializeBot(token: string): Promise<void> {
    this.logger.info('Initializing bot', { name: this.config.name })

    this.registerCoreTools()

    for (const plugin of this.config.plugins) {
      this.logger.debug('Initializing plugin', { pluginName: plugin.name })
      if (plugin.initialize) {
        await plugin.initialize()
      }
      this.registerPluginTools(plugin)
    }

    this.client.on('messageCreate', this.handleMessage.bind(this))

    this.client.on('shutdown', async () => {
      this.logger.info('Bot shutting down, cleaning up')
      await this.cleanupVoiceConnections()
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
      this.pluginTools[`${plugin.name}_${funcName}`] = {
        description: funcConfig.description,
        parameters: funcConfig.params,
        execute: async (params: Record<string, any>) => {
          const context = params.__context
          params.__context = undefined
          return funcConfig.handler(params, context)
        },
        formatDisplay: funcConfig.formatDisplay,
      }
    }
  }

  private createTools(message: Message, pendingMessage: Message) {
    return Object.entries(this.pluginTools).reduce(
      (acc, [name, toolDef]) => {
        acc[name] = tool({
          description: toolDef.description,
          parameters: toolDef.parameters,
          execute: async (params: Record<string, any>) => {
            const context: BotContext = {
              guildId: message.guildId!,
              channelId: message.channelId,
              userId: message.author.id,
              username: message.author.username,
              member: message.member!,
              message: message,
              pendingMessage: pendingMessage,
              bot: this,
            }
            return toolDef.execute({ ...params, __context: context })
          },
        })
        return acc
      },
      {} as Record<string, any>,
    )
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return

    this.cleanExpiredConversations()

    const conversationKey = this.getConversationKey(message.channelId)
    const conversation = this.conversations.get(conversationKey)
    const currentTime = Date.now()

    const isInConversation =
      conversation && currentTime - conversation.lastInteractionTime < this.CONVERSATION_TIMEOUT
    const isRelevant = isInConversation || (await this.checkMessageRelevance(message.content))

    if (!isRelevant) {
      this.logger.debug('Message not relevant, skipping')
      return
    }

    const updatedContext = this.updateConversationContext(
      conversation?.context || '',
      `${message.author.username}: ${message.content}`,
    )

    this.conversations.set(conversationKey, {
      lastInteractionTime: currentTime,
      context: updatedContext,
      channelId: message.channelId,
    })

    this.logger.debug('Received message', {
      content: message.content,
      author: message.author.username,
      channelId: message.channelId,
      guildId: message.guildId,
      timestamp: new Date().toISOString(),
    })

    const needsDetailedResponse = await this.needsDetailedProcessing(message.content)
    this.logger.debug('Message processing type', {
      needsDetailedResponse,
      content: message.content,
    })

    const pendingMessage = await message.reply(
      this.config.processingMessages[
        Math.floor(Math.random() * this.config.processingMessages.length)
      ],
    )
    const tools = this.createTools(message, pendingMessage)
    this.logger.debug('Available tools', {
      toolNames: Object.keys(tools),
    })

    try {
      this.logger.debug('Starting AI generation', {
        model: needsDetailedResponse ? MODELS.DETAILED.model : MODELS.FAST.model,
        content: message.content,
      })

      const { textStream, fullStream, toolCalls, toolResults } = streamText({
        model: needsDetailedResponse
          ? MODELS.DETAILED.provider(MODELS.DETAILED.model)
          : MODELS.FAST.provider(MODELS.FAST.model),
        system: `You are a helpful Discord bot named ${this.config.name}.
			But you are also listening to ${this.config.nameAliases.join(', ')}.
			Your behavior is defined by the following prompt: ${this.config.basePrompt}
			Your language is ${this.config.forceLanguage} even if the user speaks in other language.

			You have access to the following tools:
			${Object.entries(tools)
        .map(([name, tool]) => `- ${name}: ${(tool as any).description}`)
        .join('\n')}

			Always engage with the user in a conversational manner, even if no specific function is requested.
			Previous context of conversation: ${updatedContext}`,
        prompt: message.content,
        tools,
        maxSteps: needsDetailedResponse ? 5 : 2,
        temperature: needsDetailedResponse ? 0.7 : 0.4,
        toolChoice: 'auto',
      })

      const messageParts: MessagePart[] = []
      let lastEdit = Date.now()
      let needsEdit = false

      const editInterval = setInterval(() => {
        if (needsEdit && Date.now() - lastEdit >= 1000) {
          pendingMessage.edit(this.renderMessage(messageParts))
          lastEdit = Date.now()
          needsEdit = false
        }
      }, 100)

      for await (const chunk of fullStream) {
        if (chunk.type === 'text-delta') {
          messageParts.push({
            type: 'text-delta',
            text: chunk.textDelta,
          })
          needsEdit = true
        } else if (chunk.type === 'tool-call') {
          messageParts.push({
            type: 'tool-call',
            toolName: chunk.toolName,
            toolId: chunk.toolCallId,
            args: chunk.args,
          })
          needsEdit = true
        }
      }

      clearInterval(editInterval)
      // Final edit to ensure last changes are shown
      await pendingMessage.edit(this.renderMessage(messageParts))

      const fullText = this.renderMessage(messageParts)

      this.logger.debug('AI response', {
        text: fullText,
        toolCalls,
        toolResults,
      })

      if (!fullText) {
        this.logger.debug('AI response is empty, skipping')
        await pendingMessage.delete()
        return
      }

      this.logger.debug('AI response completed', {
        originalMessage: message.content,
        response: fullText,
        actions: toolCalls || [],
        processingTime: Date.now() - message.createdTimestamp,
      })

      const updatedContextWithResponse = this.updateConversationContext(
        this.conversations.get(conversationKey)?.context || '',
        `${this.config.name}: ${fullText}`,
      )

      this.conversations.set(conversationKey, {
        lastInteractionTime: currentTime,
        context: updatedContextWithResponse,
        channelId: message.channelId,
      })
    } catch (error) {
      this.logger.error('Error processing message', {
        error,
        content: message.content,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      })
      await pendingMessage.edit('Sorry, I encountered an error while processing your message.')
    }
  }

  private renderMessage(messageParts: MessagePart[]): string {
    let renderedMessage = ''
    let currentText = ''

    for (const part of messageParts) {
      if (part.type === 'text-delta') {
        currentText += part.text
      } else if (part.type === 'tool-call') {
        if (currentText) {
          renderedMessage += currentText
          currentText = ''
        }

        // Find the tool in pluginTools
        const toolDef = this.pluginTools[part.toolName]
        if (toolDef?.formatDisplay) {
          // Use the formatDisplay function to display the tool call
          const display = toolDef.formatDisplay(part.args)
          renderedMessage += `\n> **${display}** \n `
        } else {
          // Fallback if tool not found in pluginTools
          renderedMessage += `\n> **${part.toolName}** \n `
        }
      }
    }

    if (currentText) {
      renderedMessage += currentText
    }

    return renderedMessage
  }

  private async checkMessageRelevance(content: string): Promise<boolean> {
    const nameMatches = [
      this.config.name.toLowerCase(),
      ...this.config.nameAliases.map((alias) => alias.toLowerCase()),
    ]

    const contentLower = content.toLowerCase()
    if (nameMatches.some((name) => contentLower.includes(name))) {
      this.logger.debug('Message relevant by name match', {
        content,
        matches: nameMatches.filter((name) => contentLower.includes(name)),
      })
      return true
    }

    this.logger.debug('Checking message relevance with AI', { content })
    const { text } = await generateText({
      model: MODELS.FAST.provider(MODELS.FAST.model),
      system: `You are ${this.config.name}. Your task is to determine if the message is directed at you. You respond to: ${nameMatches.join(', ')}. Respond with true or false only.`,
      prompt: content,
      maxTokens: 5,
      temperature: 0.1,
    })

    const isRelevant = text.toLowerCase().includes('true')
    this.logger.debug('AI relevance check result', {
      content,
      aiResponse: text,
      isRelevant,
    })
    return isRelevant
  }

  private async needsDetailedProcessing(content: string): Promise<boolean> {
    this.logger.debug('Checking if message needs detailed processing', { content })
    const { text } = await generateText({
      model: MODELS.FAST.provider(MODELS.FAST.model),
      system:
        'Determine if this request requires complex processing (like function calls, multi-step reasoning, or detailed explanations). Respond with true or false only.',
      prompt: content,
      maxTokens: 5,
      temperature: 0.1,
    })

    const needsDetailed = text.toLowerCase().includes('true')
    this.logger.debug('Detailed processing check result', {
      content,
      aiResponse: text,
      needsDetailed,
    })
    return true
  }

  private registerCoreTools(): void {}

  private async cleanupVoiceConnections(): Promise<void> {
    for (const [guildId, connection] of this.voiceConnections) {
      connection.destroy()
      this.voiceConnections.delete(guildId)
    }
  }

  private getConversationKey(channelId: string): string {
    return channelId
  }

  private updateConversationContext(previousContext: string, newMessage: string): string {
    const contextParts = previousContext ? previousContext.split('\n') : []
    contextParts.push(newMessage)

    while (contextParts.join('\n').length > this.MAX_CONTEXT_LENGTH && contextParts.length > 0) {
      contextParts.shift()
    }

    return contextParts.join('\n')
  }

  private cleanExpiredConversations(): void {
    const currentTime = Date.now()
    for (const [key, conversation] of this.conversations.entries()) {
      if (currentTime - conversation.lastInteractionTime >= this.CONVERSATION_TIMEOUT) {
        this.conversations.delete(key)
      }
    }
  }

  // public async updatePendingMessage(update: ProgressUpdate): Promise<string> {
  //   try {
  //     // Language: ${update.language || 'English'}`,
  //     const response = await generateText({
  //       model: MODELS.FAST.provider(MODELS.FAST.model),
  //       system: `You are generating status messages for a Discord bot.
  //                 Keep responses short, casual and fun.`,
  //       prompt: `Generate a short status message (max 2 sentences) for this action: ${update.action}
  //                 Additional context: ${JSON.stringify(update.details)}`,
  //       maxTokens: 50,
  //       temperature: 0.7,
  //     })
  //     return response.text
  //   } catch (error) {
  //     this.logger.error('Error generating status message', error)
  //     return this.config.processingMessages[
  //       Math.floor(Math.random() * this.config.processingMessages.length)
  //     ]
  //   }
  // }
}
