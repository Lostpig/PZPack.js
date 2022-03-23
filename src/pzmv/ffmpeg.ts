import * as fs from 'fs'
import * as path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { logger } from '../base/logger'
import { taskManager } from '../base/task'
import { ensureDir } from '../base/utils'

export interface FFMpegProgress {
  frames: number
  currentFps: number
  currentKbps: number
  targetSize: number
  timemark: number
  percent: number
}
type FFMpegVideoEncode = 'nvenc' | 'libx265' | 'copy'
export interface VideoEncodeParams {
  encoder: FFMpegVideoEncode
}
export interface VCopyParams extends VideoEncodeParams {
  encoder: 'copy'
}
export interface VNvencParams extends VideoEncodeParams {
  encoder: 'nvenc'
  preset?:
    | 'default'
    | 'slow'
    | 'medium'
    | 'fast'
    | 'hp'
    | 'hq'
    | 'bd'
    | 'll'
    | 'llhq'
    | 'llhp'
    | 'lossless'
    | 'losslesshp'
  profile?: 'main' | 'main10' | 'rext'
  tier?: 'main' | 'high'
  rc?: 'constqp' | 'vbr' | 'cbr' | 'cbr_ld_hq' | 'cbr_hq' | 'vbr_hq'
  cq?: number
  qp?: number
  bitrate?: number
}
export interface VLibx265Params extends VideoEncodeParams {
  encoder: 'libx265'
  preset?:
    | 'ultrafast'
    | 'superfast'
    | 'veryfast'
    | 'faster'
    | 'fast'
    | 'medium'
    | 'slow'
    | 'slower'
    | 'veryslow'
    | 'placebo'
  profile?: 'main' | 'main444-8' | 'main10' | 'main422-10' | 'main444-10'
  tune?: 'none' | 'psnr' | 'ssim' | 'grain' | 'fastdecode' | 'zerolatency' | 'animation'
  crf?: number
}
export type VideoCodecParam = VCopyParams | VNvencParams | VLibx265Params
type FFMpegAudioEncode = 'aac' | 'libmp3lame' | 'copy'
export type AudioCodecParam = {
  encoder: FFMpegAudioEncode
  bitrate: '128' | '192' | '256' | '320'
}

export const defaultNvenvParams: Required<VNvencParams> = {
  encoder: 'nvenc',
  preset: 'slow',
  profile: 'main',
  tier: 'main',
  rc: 'vbr_hq',
  cq: 29,
  qp: 23,
  bitrate: 2000,
}
export const defaultLibx265Params: Required<VLibx265Params> = {
  encoder: 'libx265',
  preset: 'slow',
  profile: 'main',
  tune: 'none',
  crf: 26
}

const videoLibx265 = (proc: ffmpeg.FfmpegCommand, params: VLibx265Params) => {
  const p = Object.assign({}, defaultLibx265Params, params) as Required<VLibx265Params>
  if (p.crf > 51 || p.crf < 0) p.crf = defaultLibx265Params.crf

  proc.videoCodec('libx265')
  const options: string[] = [
    '-seg_duration 10',
    '-use_template 1',
    '-use_timeline 1',
    `-preset ${p.preset}`,
    `-profile ${p.profile}`,
    `-crf ${p.crf}`
  ]
  if (p.tune !== 'none') {
    options.push(`-tune ${p.tune}`)
  }

  return proc.outputOptions(options)
}
const videoNvenc = (proc: ffmpeg.FfmpegCommand, params: VNvencParams) => {
  const p = Object.assign({}, defaultNvenvParams, params) as Required<VNvencParams>
  if (p.cq > 51 || p.cq < 0) p.cq = defaultNvenvParams.cq
  if (p.qp > 51 || p.qp < -1) p.qp = defaultNvenvParams.qp

  proc.videoCodec('hevc_nvenc')
  const options: string[] = [
    '-seg_duration 10',
    '-use_template 1',
    '-use_timeline 1',
    `-preset ${p.preset}`,
    `-profile ${p.profile}`,
    `-rc ${p.rc}`,
  ]
  if (p.rc === 'vbr' || p.rc === 'vbr_hq') {
    options.push(`-cq ${p.cq}`)
  } else if (p.rc === 'constqp') {
    options.push(`-qp ${p.qp}`)
  } else {
    proc.videoBitrate(p.bitrate)
  }

  return proc.outputOptions(options)
}
const videoCopy = (proc: ffmpeg.FfmpegCommand) => {
  return proc
    .videoCodec('copy')
    .outputOptions(['-seg_duration 10', '-use_template 1', '-use_timeline 1'])
}
const setVideoCodec = (proc: ffmpeg.FfmpegCommand, codec: VideoCodecParam): ffmpeg.FfmpegCommand => {
  if (codec.encoder === 'libx265') return videoLibx265(proc, codec)
  if (codec.encoder === 'nvenc') return videoNvenc(proc, codec)
  return videoCopy(proc)
}
const setAudioCodec = (proc: ffmpeg.FfmpegCommand, codec: AudioCodecParam): ffmpeg.FfmpegCommand => {
  proc.audioCodec(codec.encoder)
  if (codec.encoder !== 'copy') {
    proc.audioBitrate(codec.bitrate)
  }
  return proc
}

export interface DashOptions {
  input: string
  output: string
  ffmpegPath: string
  videoCodec: VideoCodecParam
  audioCodec: AudioCodecParam
}
export const createDash = (options: DashOptions) => {
  const { input, output, ffmpegPath, videoCodec, audioCodec } = options

  const binPath = path.join(ffmpegPath, 'ffmpeg.exe')
  const ffprobePath = path.join(ffmpegPath, 'ffprobe.exe')
  const binExists = fs.existsSync(binPath)
  const ffprobeExists = fs.existsSync(ffprobePath)
  if (!binExists || !ffprobeExists) {
    throw new Error('ffmpeg not found')
  }

  ffmpeg.setFfmpegPath(binPath)
  ffmpeg.setFfprobePath(ffprobePath)
  logger.debug('find ffmpeg in ' + binPath)

  const inputExists = fs.existsSync(input)
  if (!inputExists) {
    throw new Error(`PZVideo: create dash failed, input file "${input}" not found`)
  }

  const outputDir = path.dirname(output)
  ensureDir(outputDir)

  const proc = ffmpeg({
    source: input,
    cwd: outputDir,
  })
    .output(output)
    .format('dash')
  setVideoCodec(proc, videoCodec)
  setAudioCodec(proc, audioCodec)

  const [task, cancelToken] = taskManager.create<FFMpegProgress>()
  proc
    .on('start', (command) => {
      logger.debug('pzvideo start ffmpeg child process with command:\n' + command)
    })
    .on('progress', (progress: FFMpegProgress) => {
      taskManager.postReport(task, progress)

      if (cancelToken.value) {
        proc.kill('SIGKILL')
      }
    })
    .on('end', function () {
      taskManager.complete(task)
      logger.debug('pzvideo ffmpeg process complete')
    })
    .on('error', function (err) {
      logger.error(err)
      taskManager.throwError(task, err)
    })

  proc.run()
  return task
}
