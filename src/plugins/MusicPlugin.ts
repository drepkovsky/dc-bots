import {
  type AudioPlayer,
  type VoiceConnection,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  StreamType,
} from '@discordjs/voice'
import type { Message, VoiceChannel } from 'discord.js'
import ytSearch from 'yt-search'
import ytdl from 'ytdl-core'
import { z } from 'zod'
import { type Plugin, createBotFunction } from '../types/config'
import { Logger } from '../logger'

type QueueItem = {
  title: string
  url: string
  requestedBy: string
  duration: string
}

type GuildQueue = {
  connection: VoiceConnection | null
  player: AudioPlayer
  items: QueueItem[]
  currentItem: QueueItem | null
  volume: number
}

class MusicPlayerManager {
  private logger: Logger
  private queues: Map<string, GuildQueue> = new Map()

  constructor() {
    this.logger = new Logger({ context: 'MusicPlayerManager' })
  }

  private createGuildQueue(guildId: string): GuildQueue {
    this.logger.debug('Creating new guild queue', { guildId })
    const queue: GuildQueue = {
      connection: null,
      player: createAudioPlayer(),
      items: [],
      currentItem: null,
      volume: 100,
    }
    this.queues.set(guildId, queue)
    return queue
  }

  private getOrCreateQueue(guildId: string): GuildQueue {
    return this.queues.get(guildId) || this.createGuildQueue(guildId)
  }

  async findSong(query: string): Promise<QueueItem | null> {
    this.logger.debug('Searching for song', { query })
    try {
      const searchResult = await ytSearch(query)
      const video = searchResult.videos[0]
      if (!video) {
        this.logger.warn('No video found for query', { query })
        return null
      }

      this.logger.debug('Found video', { video })
      return {
        title: video.title,
        url: video.url,
        requestedBy: '',
        duration: video.duration.timestamp,
      }
    } catch (error) {
      this.logger.error('Error searching for song', error)
      return null
    }
  }

  async joinChannel(channel: VoiceChannel, guildId: string): Promise<boolean> {
    this.logger.debug('Attempting to join voice channel', { channelId: channel.id, guildId })
    try {
      const queue = this.getOrCreateQueue(guildId)
      queue.connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
      })
      queue.connection.subscribe(queue.player)
      this.logger.info('Successfully joined voice channel', { channelId: channel.id, guildId })
      return true
    } catch (error) {
      this.logger.error('Error joining voice channel', error)
      return false
    }
  }

  async playSong(guildId: string, song: QueueItem): Promise<string> {
    this.logger.debug('Attempting to play song', { guildId, song })
    const queue = this.getOrCreateQueue(guildId)

    try {
      const stream = ytdl(song.url, {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
      })

      const resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary,
      })

      queue.currentItem = song
      queue.player.play(resource)

      this.logger.info('Started playing song', { guildId, song })
      return `Now playing: ${song.title}`
    } catch (error) {
      this.logger.error('Error playing song', error)
      return 'Error playing the song'
    }
  }

  addToQueue(guildId: string, item: QueueItem): void {
    const queue = this.getOrCreateQueue(guildId)
    queue.items.push(item)
  }

  skipCurrent(guildId: string): QueueItem | null {
    const queue = this.getOrCreateQueue(guildId)
    queue.player.stop()
    return queue.items.shift() || null
  }

  getQueue(guildId: string): QueueItem[] {
    return this.getOrCreateQueue(guildId).items
  }

  setVolume(guildId: string, volume: number): void {
    const queue = this.getOrCreateQueue(guildId)
    queue.volume = Math.max(0, Math.min(100, volume))
    // Implement volume control logic here
  }

  cleanup(guildId: string): void {
    const queue = this.queues.get(guildId)
    if (queue) {
      queue.player.stop()
      queue.connection?.destroy()
      this.queues.delete(guildId)
    }
  }
}

export function createMusicPlugin(): Plugin {
  const playerManager = new MusicPlayerManager()

  return {
    name: 'MusicPlugin',
    functions: {
      findSong: createBotFunction(
        'Find a song by name or URL',
        z.object({
          query: z.string(),
          message: z.custom<Message>(),
        }),
        async (params) => {
          const song = await playerManager.findSong(params.query)
          if (!song) {
            return 'Could not find the song.'
          }
          return `Found: ${song.title} (${song.duration})`
        },
      ),

      play: createBotFunction(
        'Play a song in voice channel',
        z.object({
          query: z.string(),
          message: z.custom<Message>(),
        }),
        async (params) => {
          const { message } = params
          const voiceChannel = message.member?.voice.channel as VoiceChannel

          if (!voiceChannel) {
            return 'You need to be in a voice channel!'
          }

          const song = await playerManager.findSong(params.query)
          if (!song) {
            return 'Could not find the song.'
          }

          song.requestedBy = message.author.username

          await playerManager.joinChannel(voiceChannel, message.guildId!)
          const queue = playerManager.getQueue(message.guildId!)

          if (queue.length === 0) {
            return playerManager.playSong(message.guildId!, song)
          }
          playerManager.addToQueue(message.guildId!, song)
          return `Added to queue: ${song.title}`
        },
      ),

      skip: createBotFunction(
        'Skip current song',
        z.object({
          message: z.custom<Message>(),
        }),
        async (params) => {
          const nextSong = playerManager.skipCurrent(params.message.guildId!)
          if (!nextSong) {
            return 'Queue is empty.'
          }
          return playerManager.playSong(params.message.guildId!, nextSong)
        },
      ),

      queue: createBotFunction(
        'Show current queue',
        z.object({
          message: z.custom<Message>(),
        }),
        async (params) => {
          const queue = playerManager.getQueue(params.message.guildId!)
          if (queue.length === 0) {
            return 'Queue is empty.'
          }
          return queue
            .map((item, i) => `${i + 1}. ${item.title} (requested by ${item.requestedBy})`)
            .join('\n')
        },
      ),

      volume: createBotFunction(
        'Set volume (0-100)',
        z.object({
          volume: z.number().min(0).max(100),
          message: z.custom<Message>(),
        }),
        async (params) => {
          playerManager.setVolume(params.message.guildId!, params.volume)
          return `Volume set to ${params.volume}%`
        },
      ),
    },

    cleanup: async () => {
      // Cleanup logic for plugin shutdown
    },
  }
}
