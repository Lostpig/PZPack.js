import * as path from 'path'
import * as fs from 'fs'
import { isVideoFile, type codecType } from './base'
import { PZNotify, waitObservable } from '../base/subscription'
import { nextTick, ensureEmptyDir } from '../base/utils'
import { PZBuilder, type BuildProgress } from '../pzbuilder'
import { PZIndexBuilder } from '../base/indices'
import { createDash, type FFMpegProgress } from './ffmpeg'
import { taskManager as TM, type AsyncTask, type CancelToken } from '../base/task'
import { sha256Hex } from '../base/hash'
import { PZHelper } from '../helper'

interface PZMVIndexFile {
  name: string
  source: string
  size: number
}
export class PZMVIndexBuilder {
  private list: PZMVIndexFile[] = []
  private notify: PZNotify<void> = new PZNotify()
  get subscriber() {
    return this.notify.asObservable()
  }

  private updateFlag: boolean = false
  private update() {
    if (this.updateFlag) return

    this.updateFlag = true
    nextTick().then(() => {
      this.notify.next()
      this.updateFlag = false
    })
  }
  private isExists(filename: string) {
    const found = this.list.find((f) => f.source === filename)
    return !!found
  }

  addVideo(filename: string, rename?: string) {
    if (!isVideoFile(filename)) {
      throw new Error('not support video format file')
    }
    if (this.isExists(filename)) {
      throw new Error('this file is already exists')
    }
    if (!fs.existsSync(filename)) {
      throw new Error('file not found')
    }
    const stats = fs.statSync(filename)
    if (!stats.isFile()) {
      throw new Error(`PZMVBuilder add file failed: source "${filename}" is not a file`)
    }

    const parsedName = path.parse(filename)
    const vname = rename ?? parsedName.name

    this.list.push({
      name: vname,
      source: filename,
      size: stats.size,
    })

    this.update()
  }
  removeVideo(filename: string) {
    const index = this.list.findIndex((f) => f.source === filename)
    if (index >= 0) {
      this.list.splice(index, 1)
    }

    this.update()
  }
  getList() {
    return [...this.list]
  }
}

type PZMVProgressStage = 'ffmpeg' | 'pzbuild'
type FfmpegProgressProps = {
  stage: Extract<PZMVProgressStage, 'ffmpeg'>
  count: number
  total: number
  progress: FFMpegProgress
}
type PZbuildProgressProps = {
  stage: Extract<PZMVProgressStage, 'pzbuild'>
  progress: BuildProgress
}
export type PZMVProgress = FfmpegProgressProps | PZbuildProgressProps

export interface PZMVBuilderOptions {
  password: string
  indexBuilder: PZMVIndexBuilder
  tempDir: string
  ffmpegDir: string
  codec?: codecType
}
export class PZMVBuilder {
  private indexBuilder: PZMVIndexBuilder
  private tempDir: string
  private password: string
  private ffmpegDir: string
  private codec: codecType

  constructor(options: PZMVBuilderOptions) {
    this.indexBuilder = options.indexBuilder
    this.password = options.password
    this.tempDir = options.tempDir
    this.ffmpegDir = options.ffmpegDir
    this.codec = options.codec ?? 'copy'
  }
  private excuteFfmpeg(mvfile: PZMVIndexFile) {
    const hashname = sha256Hex(mvfile.name)
    const output = path.join(this.tempDir, hashname, 'output.mpd')
    const singleTask = createDash({ input: mvfile.source, output, ffmpegPath: this.ffmpegDir, codec: this.codec })
    return singleTask
  }
  private ffmpegProcess(outerTask: AsyncTask<PZMVProgress>, outerToken: CancelToken) {
    ensureEmptyDir(this.tempDir)
    const list = this.indexBuilder.getList()
    const completeNotify = new PZNotify<void>()
    const next = (i: number) => {
      if (i < list.length) {
        const st = this.excuteFfmpeg(list[i])
        st.addReporter((p) => {
          TM.postReport(outerTask, {
            stage: 'ffmpeg',
            count: i + 1,
            total: list.length,
            progress: p,
          })
          if (outerToken.value) st.cancel()
        })
        st.complete.then(() => next(i + 1))
      } else {
        completeNotify.complete()
      }
    }
    next(0)

    return completeNotify.asObservable()
  }
  private async createIndexBuilder() {
    const idxBuilder = new PZIndexBuilder()
    const list = this.indexBuilder.getList()

    for (const f of list) {
      const hashname = sha256Hex(f.name)
      const folder = idxBuilder.addFolder(f.name, idxBuilder.rootId)
      const fileTempDir = path.join(this.tempDir, hashname)
      const tempFiles = await PZHelper.scanDirectory(fileTempDir)

      for (const tmpFile of tempFiles) {
        const basename = path.basename(tmpFile)
        idxBuilder.addFile(tmpFile, folder.id, basename)
      }
    }

    return idxBuilder
  }
  private async buildProcess(output: string, outerTask: AsyncTask<PZMVProgress>, outerToken: CancelToken) {
    const idxBuilder = await this.createIndexBuilder()
    const pzbuilder = new PZBuilder({ indexBuilder: idxBuilder, password: this.password, type: 'PZVIDEO' })
    const pzTask = pzbuilder.buildTo(output)

    pzTask.addReporter((p) => {
      TM.postReport(outerTask, {
        stage: 'pzbuild',
        progress: p,
      })
      if (outerToken.value) pzTask.cancel()
    })

    return pzTask.complete
  }

  buildTo(output: string) {
    const [task, cancelToken] = TM.create<PZMVProgress>()
    const ffmpegNotify = this.ffmpegProcess(task, cancelToken)
    waitObservable(ffmpegNotify)
      .then(() => {
        return this.buildProcess(output, task, cancelToken)
      })
      .then(() => {
        TM.complete(task)
      })
      .catch((err) => {
        TM.throwError(task, err)
      })

    return task
  }
}
