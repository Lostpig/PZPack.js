import * as fs from 'fs'
import * as path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { type codecType } from './base'
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

type codecSetter = (proc: ffmpeg.FfmpegCommand) => ffmpeg.FfmpegCommand
const codecLibx265 = (proc: ffmpeg.FfmpegCommand) => {
  return proc.videoCodec('libx265')
  .audioCodec('copy')
  .outputOptions(['-preset slow', '-seg_duration 10', '-use_template 1', '-use_timeline 1'])
}
const codecNvenc = (proc: ffmpeg.FfmpegCommand) => {
  return proc.videoCodec('hevc_nvenc')
  .audioCodec('copy')
  .outputOptions(['-preset slow', '-rc vbr_hq', '-cq 31', '-seg_duration 10', '-use_template 1', '-use_timeline 1'])
}
const codecCopy = (proc: ffmpeg.FfmpegCommand) => {
  return proc.videoCodec('copy')
  .audioCodec('copy')
  .outputOptions(['-seg_duration 10', '-use_template 1', '-use_timeline 1'])
}
const getCodec = (codec: codecType): codecSetter => {
  if (codec === 'libx265') return codecLibx265
  if (codec === 'nvenc') return codecNvenc

  return codecCopy
}

export interface DashOptions {
  input: string
  output: string
  ffmpegPath: string
  codec: codecType
}
export const createDash = (options: DashOptions) => {
  const { input, output, ffmpegPath, codec } = options

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
  }).output(output).format('dash')
  const codecSet = getCodec(codec)
  codecSet(proc)

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
