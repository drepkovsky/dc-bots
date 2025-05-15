import {
  type AudioPlayer,
  type VoiceConnection,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
} from '@discordjs/voice'
import { ytmp3 } from '@vreden/youtube_scraper'
import type { VoiceChannel } from 'discord.js'
import https from 'node:https'
import { PassThrough } from 'node:stream'
import yts from 'yt-search'
import { z } from 'zod'
import { Logger } from '../logger'
import { type Plugin, createBotFunction } from '../types/config'

// Track authentication state
const isAuthenticated = false
const authPendingData: { verification_url: string; user_code: string } | null = null

// Define types for youtube-dl-exec responses
type YoutubeTrack = {
  title: string
  webpage_url: string
  url: string
  duration: number
}

type YoutubeSearchResult = {
  entries?: YoutubeTrack[]
  title?: string
  webpage_url?: string
  url?: string
  duration?: number
}

// Progress configuration
const isInitialized = true

function formatDuration(duration: number): string {
  const minutes = Math.floor(duration / 60)
  const seconds = Math.floor(duration % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

// Format yt-search duration to seconds
function parseDuration(timestamp: string): number {
  const parts = timestamp.split(':').map(Number)
  if (parts.length === 3) {
    // Hours:Minutes:Seconds
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  if (parts.length === 2) {
    // Minutes:Seconds
    return parts[0] * 60 + parts[1]
  }
  return 0
}

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
      player: createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Play,
        },
      }),
      items: [],
      currentItem: null,
      volume: 100,
    }
    this.queues.set(guildId, queue)
    return queue
  }

  getOrCreateQueue(guildId: string): GuildQueue {
    return this.queues.get(guildId) || this.createGuildQueue(guildId)
  }

  private extractVideoId(url: string): string | null {
    const match = url.match(
      /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/(watch\?v=)?([^&?/]+)/,
    )
    return match ? match[5] : null
  }

  private extractListId(url: string): string | null {
    const match = url.match(
      /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/(playlist\?list=)?([^&?/]+)/,
    )
    return match ? match[5] : null
  }

  private videoUrlFromId(id: string): string {
    return `https://www.youtube.com/watch?v=${id}`
  }

  async findSong(url: string): Promise<Omit<QueueItem, 'requestedBy'>[]> {
    this.logger.debug('Searching for song', { query: url })

    try {
      // Check if query is a YouTube URL
      if (url.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/)) {
        this.logger.debug('Query is a direct YouTube URL, using youtube-dl-exec', { query: url })

        const videoId = this.extractVideoId(url)
        const listId = this.extractListId(url)

        if (videoId) {
          const result = await yts({ videoId })
          if (result) {
            return [
              {
                title: result.title,
                url: result.url,
                duration: `${result.duration.seconds} seconds`,
              },
            ]
          }
        } else if (listId) {
          const result = await yts({ listId })
          if (result) {
            return result.videos?.map((entry) => ({
              title: entry.title,
              url: this.videoUrlFromId(entry.videoId),
              duration: `${entry.duration.seconds} seconds`,
            }))
          }
        }
      }

      // Use yt-search for regular queries
      this.logger.debug('Searching with yt-search', { query: url })
      const searchResults = await yts(url)

      if (searchResults.videos && searchResults.videos.length > 0) {
        const video = searchResults.videos[0]

        this.logger.debug('Found song via yt-search', {
          title: video.title,
          url: video.url,
          duration: video.timestamp,
        })

        return [
          {
            title: video.title,
            url: video.url,
            duration: video.timestamp,
          },
        ]
      }

      this.logger.warn('No results found with yt-search', {
        query: url,
      })

      return []
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorStack = error instanceof Error ? error.stack : undefined

      this.logger.error('Error searching for song', {
        error: {
          message: errorMessage,
          stack: errorStack,
        },
        query: url,
      })

      return []
    }
  }

  async joinChannel(channel: VoiceChannel, guildId: string): Promise<boolean> {
    this.logger.debug('Attempting to join voice channel', { channelId: channel.id, guildId })
    try {
      const queue = this.getOrCreateQueue(guildId)

      // Get existing connection or create new one
      let connection = getVoiceConnection(guildId)
      if (connection) {
        connection.destroy()
      }

      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      })

      queue.connection = connection

      // Wait for the connection to be ready
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000)

        connection.on('stateChange', (_, newState) => {
          if (newState.status === 'ready') {
            clearTimeout(timeout)
            resolve()
          }
        })
      })

      // Subscribe player only after connection is ready
      const subscription = connection.subscribe(queue.player)
      if (!subscription) {
        throw new Error('Failed to subscribe player to connection')
      }

      this.logger.info('Successfully joined voice channel', {
        channelId: channel.id,
        guildId,
        connectionStatus: connection.state.status,
      })

      return true
    } catch (error) {
      this.logger.error('Error joining voice channel', error)
      return false
    }
  }

  async playSong(guildId: string, song: QueueItem): Promise<string> {
    this.logger.debug('Attempting to play song', {
      guildId,
      song: { title: song.title, url: song.url },
    })

    const queue = this.getOrCreateQueue(guildId)

    try {
      const connection = getVoiceConnection(guildId)
      if (!connection || connection.state.status !== 'ready') {
        this.logger.error('Voice connection not ready', {
          guildId,
          connectionStatus: connection?.state.status,
        })
        throw new Error('Voice connection not ready')
      }

      this.logger.debug('Creating audio stream', { url: song.url })

      // Use youtube-dl-exec to get the audio stream
      const result = await ytmp3(song.url)
      if (!result.status) {
        throw new Error('Failed to get audio stream')
      }
      const passThrough = new PassThrough()
      https.get(result.download.url, (res) => {
        res.pipe(passThrough)
      })
      const { stream: demuxedStream, type } = await demuxProbe(passThrough)
      const resource = createAudioResource(demuxedStream, { inputType: type })

      queue.currentItem = song

      // Setup player event listeners
      queue.player.removeAllListeners()

      queue.player.on('error', (error) => {
        this.logger.error('Player error', {
          error,
          song: song.title,
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        })
        this.skipCurrent(guildId)
      })

      queue.player.on('stateChange', (oldState, newState) => {
        this.logger.debug('Player state changed', {
          guildId,
          song: song.title,
          oldState: oldState.status,
          newState: newState.status,
        })

        // If playback has ended, play the next song automatically
        if (oldState.status === 'playing' && newState.status === 'idle') {
          this.logger.info('Song ended, playing next if available', {
            guildId,
            finishedSong: song.title,
          })

          // Get the next song in the queue
          const nextSong = queue.items.shift()
          if (nextSong) {
            // Auto-play next song
            this.playSong(guildId, nextSong).catch((error) => {
              this.logger.error('Error auto-playing next song', {
                error,
                nextSong: nextSong.title,
              })
            })
          } else {
            queue.currentItem = null
            this.logger.info('Queue finished, no more songs', { guildId })
          }
        }
      })

      queue.player.play(resource)
      connection.subscribe(queue.player)

      this.logger.info('Started playing song', {
        guildId,
        song: {
          title: song.title,
          duration: song.duration,
          requestedBy: song.requestedBy,
        },
      })

      return `Now playing: ${song.title} (${song.duration})`
    } catch (error) {
      this.logger.error('Error playing song', {
        error,
        guildId,
        song: song.title,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      })
      return 'Error playing the song. Please try another song or check the URL.'
    }
  }

  addToQueue(guildId: string, item: QueueItem): void {
    this.logger.debug('Adding song to queue', {
      guildId,
      song: { title: item.title, url: item.url },
    })
    const queue = this.getOrCreateQueue(guildId)
    queue.items.push(item)
    this.logger.info('Song added to queue', {
      guildId,
      queueLength: queue.items.length,
      song: { title: item.title, position: queue.items.length },
    })
  }

  skipCurrent(guildId: string): QueueItem | null {
    this.logger.debug('Skipping current song', { guildId })
    const queue = this.getOrCreateQueue(guildId)
    const currentSong = queue.currentItem
    queue.player.stop(true)
    queue.currentItem = null
    const nextSong = queue.items.shift()

    this.logger.info('Skipped song', {
      guildId,
      skippedSong: currentSong?.title,
      nextSong: nextSong?.title,
      remainingInQueue: queue.items.length,
    })

    return nextSong || null
  }

  getQueue(guildId: string): QueueItem[] {
    return this.getOrCreateQueue(guildId).items
  }

  setVolume(guildId: string, volume: number): void {
    this.logger.debug('Setting volume', { guildId, volume })
    const queue = this.getOrCreateQueue(guildId)
    const oldVolume = queue.volume
    queue.volume = Math.max(0, Math.min(100, volume))

    if (queue.player.state.status === 'playing') {
      const resource = queue.player.state.resource
      if (resource?.volume) {
        resource.volume.setVolume(queue.volume / 100)
        this.logger.info('Volume changed', {
          guildId,
          oldVolume,
          newVolume: queue.volume,
          currentSong: queue.currentItem?.title,
        })
      }
    }
  }

  cleanup(guildId: string): void {
    this.logger.debug('Cleaning up guild resources', { guildId })
    const queue = this.queues.get(guildId)
    if (queue) {
      queue.player.stop()
      queue.connection?.destroy()
      this.queues.delete(guildId)
      this.logger.info('Cleaned up guild resources', {
        guildId,
        queueLength: queue.items.length,
        currentSong: queue.currentItem?.title,
      })
    }
  }

  getCurrentSong(guildId: string): QueueItem | null {
    const queue = this.getOrCreateQueue(guildId)
    return queue.currentItem
  }
}

export function createMusicPlugin(): Plugin {
  const logger = new Logger({ context: 'MusicPlugin' })
  const playerManager = new MusicPlayerManager()

  return {
    name: 'MusicPlugin',
    initialize: async () => {
      logger.info('Initializing MusicPlugin')
      logger.info('MusicPlugin initialized successfully')
    },
    functions: {
      query: createBotFunction(
        'Search for a song and add it to the queue',
        z.object({
          query: z.string().describe('URL or search query for the song'),
        }),
        async (params, context) => {
          logger.debug('Processing query command', {
            query: params.query,
            userId: context.userId,
            guildId: context.guildId,
          })

          const songs = await playerManager.findSong(params.query)
          if (!songs.length) {
            logger.warn('Song not found', { query: params.query })
            return { error: 'Could not find the song.' }
          }

          for (const song of songs) {
            playerManager.addToQueue(context.guildId, {
              ...song,
              requestedBy: context.username,
            })
          }

          const queue = playerManager.getQueue(context.guildId)
          logger.info('Song queued', {
            song: songs[0].title,
            position: queue.length,
            requestedBy: context.username,
            guildId: context.guildId,
          })

          return {
            status: 'queued',
            message: `Added to queue: ${songs[0].title} ${songs.length > 1 ? `and ${songs.length - 1} more` : ''}`,
            position: queue.length,
          }
        },
      ),

      play: createBotFunction(
        'Play songs from the queue',
        z.object({}),
        async (_params, context) => {
          const voiceChannel = context.member.voice.channel as VoiceChannel
          if (!voiceChannel) {
            return { error: 'You need to be in a voice channel!' }
          }

          const queue = playerManager.getQueue(context.guildId)
          if (queue.length === 0) {
            return { error: 'Queue is empty. Use /query to add songs first.' }
          }

          // Update status while joining channel
          await context.pendingMessage.edit(
            await context.bot.updatePendingMessage({
              action: 'joining_voice',
              details: {
                channelName: voiceChannel.name,
                guildName: voiceChannel.guild.name,
              },
              language: 'English', // Optional
            }),
          )

          const joined = await playerManager.joinChannel(voiceChannel, context.guildId)

          if (!joined) {
            return { error: 'Failed to join voice channel.' }
          }

          const song = queue[0]
          queue.shift()

          // Update status while preparing song
          await context.pendingMessage.edit(
            await context.bot.updatePendingMessage({
              action: 'preparing_song',
              details: {
                songTitle: song.title,
                duration: song.duration,
              },
            }),
          )

          const playResponse = await playerManager.playSong(context.guildId, song)
          return {
            status: 'playing',
            song: {
              title: song.title,
              url: song.url,
              duration: song.duration,
              requestedBy: song.requestedBy,
            },
            message: playResponse,
          }
        },
      ),

      playAt: createBotFunction(
        'Play specific song from queue by position',
        z.object({
          position: z.number().min(1).describe('Position in queue (1-based)'),
        }),
        async (params, context) => {
          const queue = playerManager.getQueue(context.guildId)
          const position = params.position - 1 // Convert to 0-based index

          if (position >= queue.length) {
            return { error: `Queue only has ${queue.length} songs.` }
          }

          const song = queue[position]
          queue.splice(position, 1) // Remove song from its position
          const playResponse = await playerManager.playSong(context.guildId, song)

          return {
            status: 'playing',
            song: {
              title: song.title,
              url: song.url,
              duration: song.duration,
              requestedBy: song.requestedBy,
            },
            message: playResponse,
          }
        },
      ),

      playNext: createBotFunction(
        'Play next song in queue',
        z.object({}),
        async (_params, context) => {
          const nextSong = playerManager.skipCurrent(context.guildId)
          if (!nextSong) {
            return { error: 'Queue is empty.' }
          }

          const playResponse = await playerManager.playSong(context.guildId, nextSong)
          return {
            status: 'playing',
            song: {
              title: nextSong.title,
              url: nextSong.url,
              duration: nextSong.duration,
              requestedBy: nextSong.requestedBy,
            },
            message: playResponse,
          }
        },
      ),

      pause: createBotFunction('Pause current song', z.object({}), async (_params, context) => {
        const queue = playerManager.getOrCreateQueue(context.guildId)
        queue.player.pause()
        return {
          status: 'paused',
          message: 'Playback paused.',
        }
      }),

      resume: createBotFunction('Resume paused song', z.object({}), async (_params, context) => {
        const queue = playerManager.getOrCreateQueue(context.guildId)
        queue.player.unpause()
        return {
          status: 'playing',
          message: 'Playback resumed.',
        }
      }),

      stop: createBotFunction(
        'Stop playback and clear queue',
        z.object({}),
        async (_params, context) => {
          playerManager.cleanup(context.guildId)
          return {
            status: 'stopped',
            message: 'Playback stopped and queue cleared.',
          }
        },
      ),

      queue: createBotFunction('Show current queue', z.object({}), async (_params, context) => {
        const queue = playerManager.getQueue(context.guildId)
        const currentSong = playerManager.getCurrentSong(context.guildId)

        if (!currentSong && queue.length === 0) {
          return {
            status: 'empty',
            message: 'No songs in queue.',
          }
        }

        return {
          status: 'success',
          nowPlaying: currentSong
            ? {
                title: currentSong.title,
                url: currentSong.url,
                duration: currentSong.duration,
                requestedBy: currentSong.requestedBy,
              }
            : null,
          queue: queue.map((song, index) => ({
            position: index + 1,
            title: song.title,
            url: song.url,
            duration: song.duration,
            requestedBy: song.requestedBy,
          })),
        }
      }),

      addToQueue: createBotFunction(
        'Add a song to the queue',
        z.object({ query: z.string() }),
        async (params, context) => {
          const songs = await playerManager.findSong(params.query)
          if (!songs.length) {
            return { error: 'Could not find the song.' }
          }

          for (const song of songs) {
            playerManager.addToQueue(context.guildId, {
              ...song,
              requestedBy: context.username,
            })
          }

          return {
            status: 'queued',
            message: `Added to queue: ${songs[0].title}`,
          }
        },
      ),
    },
    cleanup: async () => {
      logger.info('Cleaning up MusicPlugin')
      // Log out of YouTube if needed
      if (isAuthenticated) {
      }
      logger.info('MusicPlugin cleanup completed')
    },
  }
}
