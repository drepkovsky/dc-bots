import {
  type AudioPlayer,
  type VoiceConnection,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
} from '@discordjs/voice'
import type { VoiceChannel } from 'discord.js'
// import ffmpeg from 'ffmpeg-static'
import play from 'play-dl'
import { z } from 'zod'
import { Logger } from '../logger'
import { type Plugin, createBotFunction } from '../types/config'

// Add this near the top of the file, after imports
// if (ffmpeg) {
//   process.env.FFMPEG_PATH = ffmpeg
// }

let isInitialized = false

async function initializeSoundCloud(): Promise<void> {
  try {
    const clientID = await play.getFreeClientID()
    await play.setToken({
      soundcloud: {
        client_id: clientID,
      },
    })
    isInitialized = true
  } catch (error) {
    throw new Error('Failed to initialize SoundCloud client: ' + error)
  }
}

function formatDuration(duration: number): string {
  const minutes = Math.floor(duration / 60)
  const seconds = duration % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
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

  private async ensureInitialized(): Promise<void> {
    if (!isInitialized) {
      this.logger.debug('Initializing SoundCloud client')
      await initializeSoundCloud()
    }
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

  async findSong(query: string): Promise<QueueItem | null> {
    await this.ensureInitialized()
    this.logger.debug('Searching for song', { query })
    try {
      // Try SoundCloud as primary source
      const soundcloudSearch = await play.search(query, {
        limit: 1,
        source: { soundcloud: 'tracks' },
      })

      if (soundcloudSearch[0]) {
        const track = soundcloudSearch[0]
        return {
          title: track.name || 'Unknown Title',
          url: track.url,
          requestedBy: '',
          duration: formatDuration(track.durationInSec),
        }
      }

      // If nothing found on SoundCloud, try Deezer
      const deezerSearch = await play.search(query, {
        limit: 1,
        source: { deezer: 'track' },
      })

      if (deezerSearch[0]) {
        const track = deezerSearch[0]
        return {
          title: track.title || 'Unknown Title',
          url: track.url,
          requestedBy: '',
          duration: formatDuration(track.durationInSec),
        }
      }

      this.logger.warn('No track found on any platform', { query })
      return null
    } catch (error) {
      this.logger.error('Error searching for song', error)
      return null
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
    this.logger.debug('Attempting to play song', { guildId, song })
    const queue = this.getOrCreateQueue(guildId)

    try {
      // Verify connection exists and is ready
      const connection = getVoiceConnection(guildId)
      if (!connection || connection.state.status !== 'ready') {
        throw new Error('Voice connection not ready')
      }

      const stream = await play.stream(song.url, {
        quality: 1,
        discordPlayerCompatibility: true,
      })

      const resource = createAudioResource(stream.stream, {
        inputType: stream.type,
        // inlineVolume: true,
      })

      //   resource.volume?.setVolume(queue.volume / 100)
      queue.currentItem = song

      // Setup player event listeners
      queue.player.removeAllListeners()

      queue.player.on('error', (error) => {
        this.logger.error('Player error', error)
        this.skipCurrent(guildId)
      })

      queue.player.on('stateChange', (oldState, newState) => {
        this.logger.debug('Player state changed', {
          oldState: oldState.status,
          newState: newState.status,
        })
      })

      // Stop any existing playback
      //   queue.player.stop(true)
      // Play the new resource
      queue.player.play(resource)
      connection.subscribe(queue.player)

      return `Now playing: ${song.title}`
    } catch (error) {
      this.logger.error('Error playing song', error)
      return 'Error playing the song. Please try another song or check the URL.'
    }
  }

  addToQueue(guildId: string, item: QueueItem): void {
    const queue = this.getOrCreateQueue(guildId)
    queue.items.push(item)
  }

  skipCurrent(guildId: string): QueueItem | null {
    const queue = this.getOrCreateQueue(guildId)
    queue.player.stop(true) // Add true to force stop
    queue.currentItem = null
    return queue.items.shift() || null
  }

  getQueue(guildId: string): QueueItem[] {
    return this.getOrCreateQueue(guildId).items
  }

  setVolume(guildId: string, volume: number): void {
    const queue = this.getOrCreateQueue(guildId)
    queue.volume = Math.max(0, Math.min(100, volume))

    if (queue.player.state.status === 'playing') {
      const resource = queue.player.state.resource
      if (resource?.volume) {
        resource.volume.setVolume(queue.volume / 100)
      }
    }
  }

  cleanup(guildId: string): void {
    const queue = this.queues.get(guildId)
    if (queue) {
      queue.player.stop()
      queue.connection?.destroy()
      this.queues.delete(guildId)
    }
  }

  getCurrentSong(guildId: string): QueueItem | null {
    const queue = this.getOrCreateQueue(guildId)
    return queue.currentItem
  }
}

export function createMusicPlugin(): Plugin {
  const playerManager = new MusicPlayerManager()

  return {
    name: 'MusicPlugin',
    initialize: async () => {
      await initializeSoundCloud()
    },
    functions: {
      query: createBotFunction(
        'Search for a song and add it to the queue',
        z.object({
          query: z.string().describe('URL or search query for the song'),
        }),
        async (params, context) => {
          const song = await playerManager.findSong(params.query)
          if (!song) {
            return { error: 'Could not find the song.' }
          }

          song.requestedBy = context.username
          playerManager.addToQueue(context.guildId, song)

          const queue = playerManager.getQueue(context.guildId)
          return {
            status: 'queued',
            message: `Added to queue: ${song.title}`,
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

          const joined = await playerManager.joinChannel(voiceChannel, context.guildId)
          if (!joined) {
            return { error: 'Failed to join voice channel.' }
          }

          const song = queue[0]
          queue.shift() // Remove the first song from queue

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
          const song = await playerManager.findSong(params.query)
          if (!song) {
            return { error: 'Could not find the song.' }
          }

          playerManager.addToQueue(context.guildId, song)
          return {
            status: 'queued',
            message: `Added to queue: ${song.title}`,
          }
        },
      ),
    },
    cleanup: async () => {
      // Cleanup logic
    },
  }
}
