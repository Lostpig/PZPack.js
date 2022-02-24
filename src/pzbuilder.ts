import * as path from 'path'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import { currentVersion, getSignHash, headLength } from './base/common'
import { getPZCrypto, type PZCrypto } from './base/crypto'
import {
  PZIndexBuilder,
  createPZFile,
  encodePZIndex,
  type PZFolder,
  type PZFile,
  type BuildingFile,
} from './base/indices'
import { ensureDir, fsCloseAsync, fsOpenAsync, fsWriteAsync } from './base/utils'
import { AsyncTask, CancelToken, taskManager } from './base/task'
import { FileAlreadyExistsError } from './base/exceptions'

export interface BuildProgress {
  phase: 'prepare' | 'process' | 'complete'
  current: [number, number]
  count: [number, number]
  total: [number, number]
}

export class PZBuilder {
  readonly indexBuilder: PZIndexBuilder
  private crypto: PZCrypto
  private description = ''
  constructor(password: string) {
    this.crypto = getPZCrypto(password, currentVersion)
    this.indexBuilder = new PZIndexBuilder()
  }
  setDescription(description: string) {
    this.description = description
  }

  private async ensureFiles() {
    const files = this.indexBuilder.getBuildingFiles()
    let totalSize = 0

    for (const f of files) {
      const fstat = await fsp.stat(f.source)
      if (!fstat.isFile()) {
        throw new Error(`PZBuilder error: source file "${f.source}" not found`)
      }
      f.size = fstat.size
      totalSize += f.size
    }

    return {
      files,
      totalSize,
    }
  }

  private async writePZHead(fd: number) {
    // write version
    const versionBuf = Buffer.alloc(4)
    versionBuf.writeInt32LE(currentVersion, 0)
    await fsWriteAsync(fd, versionBuf, 0, 4, 0)

    // write sign
    const signBuf = getSignHash()
    await fsWriteAsync(fd, signBuf, 0, 32, 4)

    // write password check
    await fsWriteAsync(fd, this.crypto.passwordHash, 0, 32, 36)
  }
  private async writePZInfo(fd: number) {
    let descBuf = this.description.length > 0 ? Buffer.from(this.description, 'utf8') : undefined
    const descLength = descBuf ? descBuf.length : 0

    const infoBuf = Buffer.alloc(descLength + 8)
    infoBuf.writeInt32LE(descLength, 0)
    infoBuf.writeInt32LE(0, 4)
    if (descBuf) {
      infoBuf.set(descBuf, 8)
    }
    const encryptBuf = this.crypto.encrypt(infoBuf)
    const encryptLength = Buffer.alloc(4)
    encryptLength.writeInt32LE(encryptBuf.length, 0)

    await fsWriteAsync(fd, encryptLength, 0, 4, headLength)
    await fsWriteAsync(fd, encryptBuf, 0, encryptBuf.length, headLength + 4)

    return encryptBuf.length + 4
  }
  private async writeIndices(fd: number, position: number, files: PZFile[], folders: PZFolder[]) {
    const indicesBuf = encodePZIndex(files, folders)
    const encryptBuf = this.crypto.encrypt(indicesBuf)

    await fsWriteAsync(fd, encryptBuf, 0, encryptBuf.length, position)
    return encryptBuf.length
  }
  async execBuild(fd: number, tasks: [AsyncTask<BuildProgress>, CancelToken, BuildProgress]) {
    await this.writePZHead(fd)
    const infoPartLength = await this.writePZInfo(fd)
    const indexOffsetPos = headLength + infoPartLength

    let positon = indexOffsetPos + 8
    const { files, totalSize } = await this.ensureFiles()

    const [task, cancelToken, cache] = tasks
    cache.phase = 'process'
    cache.count = [0, files.length]
    cache.total = [0, totalSize]
    const progressReport = (p: number) => {
      cache.current[0] = p
      const [t0, t1] = cache.total
      taskManager.postReport(task, {
        ...cache,
        total: [t0 + p, t1],
      })
    }
    const fileComplete = (f: BuildingFile) => {
      cache.count[0] += 1
      cache.total[0] += f.size
    }
    const fileStart = (f: BuildingFile) => {
      cache.current = [0, f.size]
    }

    const pzFiles: PZFile[] = []
    for (const f of files) {
      fileStart(f)
      const sourceFd = await fsOpenAsync(f.source, 'r')
      const written = await this.crypto.encryptFileAsync({
        sourceFd,
        targetFd: fd,
        offset: positon,
        size: f.size,
        position: 0,
        canceled: cancelToken,
        progress: progressReport,
      })
      await fsCloseAsync(sourceFd)
      fileComplete(f)
      const pzFile = createPZFile(f.name, f.folderId, positon, written)
      pzFiles.push(pzFile)

      positon += written
      if (cancelToken.value) {
        break
      }
    }

    if (!cancelToken.value) {
      const indexOffsetBuf = Buffer.alloc(8)
      indexOffsetBuf.writeBigInt64LE(BigInt(positon))
      await fsWriteAsync(fd, indexOffsetBuf, 0, 8, indexOffsetPos)

      const folders = this.indexBuilder.getFolders()
      await this.writeIndices(fd, positon, pzFiles, folders)
    }
  }
  buildTo(target: string) {
    const fileExists = fs.existsSync(target)
    if (fileExists) {
      throw new FileAlreadyExistsError()
    }
    const p = path.parse(target)
    ensureDir(p.dir)
    const tempPath = target + '.pztemp'

    const fd = fs.openSync(tempPath, 'w')
    const lockFd = fs.openSync(target, 'w')

    const progressCache: BuildProgress = {
      phase: 'prepare',
      current: [0, 1],
      count: [0, 1],
      total: [0, 1],
    }
    const [task, cancelToken] = taskManager.create<BuildProgress>(333)
    taskManager.postReport(task, progressCache)
    this.execBuild(fd, [task, cancelToken, progressCache])
      .then(() => {
        progressCache.phase = 'complete'
        taskManager.postReport(task, progressCache)

        fs.closeSync(fd)
        fs.closeSync(lockFd)
        fs.rmSync(target)
        fs.renameSync(tempPath, target)

        taskManager.complete(task, progressCache)
      })
      .catch((err) => {
        fs.closeSync(fd)
        fs.closeSync(lockFd)
        fs.rmSync(target)
        fs.rmSync(tempPath)

        taskManager.throwError(task, err)
      })

    return task
  }
}

const scanDirectory = async (dir: string) => {
  const dirs = [dir]
  const files: string[] = []

  while (dirs.length > 0) {
    const d = dirs.pop()!
    const list = await fsp.readdir(d)
    for (const f of list) {
      const fullname = path.join(d, f)
      const stats = await fsp.stat(fullname)
      if (stats.isDirectory()) {
        dirs.push(fullname)
      }
      if (stats.isFile()) {
        files.push(fullname)
      }
    }
  }

  return files
}
const scanDirectorySync = (dir: string) => {
  const dirs = [dir]
  const files: string[] = []

  while (dirs.length > 0) {
    const d = dirs.pop()!
    const list = fs.readdirSync(d)
    for (const f of list) {
      const fullname = path.join(d, f)
      const stats = fs.statSync(fullname)
      if (stats.isDirectory()) {
        dirs.push(fullname)
      }
      if (stats.isFile()) {
        files.push(fullname)
      }
    }
  }

  return files
}

export const helper = {
  scanDirectory,
  scanDirectorySync
}
