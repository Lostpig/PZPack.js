import * as fs from 'fs'
import * as path from 'path'
import { performance } from 'node:perf_hooks'
import { isCompatible, headLength, checkSign, type ProgressReporter, type PZTypes } from './base/common'
import { bytesToHex, ensureDir, ensureEmptyDir, fsOpenAsync, fsCloseAsync, fsReadAsync } from './base/utils'
import { createPZCryptoByKey, createKey, type PZCrypto } from './base/crypto'
import { NotSupportedVersionError, IncorrectPasswordError, FileAlreadyExistsError } from './base/exceptions'
import { PZIndexReader, type PZFilePacked, type PZFolder } from './base/indices'
import { taskManager } from './base/task'

export interface ExtractProgress {
  /** 当前提取中的文件已提取的字节数 */
  current: number
  /** 当前提取中的文件大小 */
  currentSize: number

  /** 已提取的文件个数 */
  extractCount: number
  /** 需要提取的文件总个数 */
  totalCount: number

  /** 已提取的文件合计大小 */
  extractSize: number
  /** 需要提取的文件合计大小 */
  totalSize: number
}

class PZLoader {
  private _version?: number
  private _fd?: number
  private _fileStat?: fs.Stats
  private _type: PZTypes
  private readonly crypto: PZCrypto

  readonly filename
  get version() {
    if (this._version === undefined) {
      this._version = this.getVersion()
    }
    return this._version
  }
  private get fd() {
    if (this._fd === undefined) {
      this._fd = fs.openSync(this.filename, 'r')
    }
    return this._fd
  }
  private get fileStat() {
    if (!this._fileStat) {
      this._fileStat = fs.statSync(this.filename)
    }
    return this._fileStat
  }
  get size() {
    return this.fileStat.size
  }
  get type() {
    return this._type
  }

  private getVersion() {
    const buf = Buffer.alloc(4)
    fs.readSync(this.fd, buf, 0, 4, 0)
    const version = buf.readInt32LE(0)
    return version
  }
  private checkFile() {
    if (!isCompatible(this.version)) {
      throw new NotSupportedVersionError()
    }

    const tempBuffer = Buffer.alloc(32)
    fs.readSync(this.fd, tempBuffer, 0, 32, 4)
    const pzType = checkSign(tempBuffer)

    fs.readSync(this.fd, tempBuffer, 0, 32, 36)
    const pwHex = bytesToHex(tempBuffer)
    if (pwHex !== this.crypto.passwordHashHex) {
      throw new IncorrectPasswordError()
    }

    return pzType
  }

  constructor(filename: string, key: Buffer) {
    this.filename = filename
    this.crypto = createPZCryptoByKey(key, this.version)
    this._type = this.checkFile()
  }

  private _indexCache?: PZIndexReader
  loadIndexBuffer() {
    const infoLengthBuf = Buffer.alloc(4)
    fs.readSync(this.fd, infoLengthBuf, { position: headLength, offset: 0, length: 4 })
    const infoLength = infoLengthBuf.readInt32LE()

    const indexOffsetBuf = Buffer.alloc(8)
    fs.readSync(this.fd, indexOffsetBuf, { position: headLength + infoLength + 4, offset: 0, length: 8 })
    const indexOffset = Number(indexOffsetBuf.readBigInt64LE())
    const indexSize = this.fileStat.size - indexOffset

    const indexEncryptBuf = Buffer.alloc(indexSize)
    fs.readSync(this.fd, indexEncryptBuf, { position: indexOffset, offset: 0, length: indexSize })
    const indexBuf = this.crypto.decrypt(indexEncryptBuf)

    return indexBuf
  }
  loadIndex() {
    if (!this._indexCache) {
      const indexBuf = this.loadIndexBuffer()
      this._indexCache = new PZIndexReader()
      this._indexCache.decode(indexBuf, this.version)
    }

    return this._indexCache
  }
  private _description?: string
  getDescription() {
    if (this._description !== undefined) return this._description

    const infoLengthBuf = Buffer.alloc(4)
    fs.readSync(this.fd, infoLengthBuf, { position: headLength, offset: 0, length: 4 })
    const infoLength = infoLengthBuf.readInt32LE()

    const encryptInfoBuf = Buffer.alloc(infoLength)
    fs.readSync(this.fd, encryptInfoBuf, { position: headLength + 4, offset: 0, length: infoLength })

    const infoBuf = this.crypto.decrypt(encryptInfoBuf)
    const descLength = infoBuf.readInt32LE()
    if (descLength > 0) {
      this._description = infoBuf.toString('utf8', 8, 8 + descLength)
    } else {
      this._description = ''
    }

    return this._description
  }

  loadFile(file: PZFilePacked) {
    const encryptBuf = Buffer.alloc(file.size)
    fs.readSync(this.fd, encryptBuf, { position: file.offset, offset: 0, length: file.size })
    const buf = this.crypto.decrypt(encryptBuf)

    return buf
  }
  async loadFileAsync(file: PZFilePacked) {
    const encryptBuf = Buffer.alloc(file.size)
    await fsReadAsync(this.fd, encryptBuf, { position: file.offset, offset: 0, length: file.size })
    const buf = this.crypto.decrypt(encryptBuf)

    return buf
  }
  fileReader(file: PZFilePacked) {
    const reader = this.crypto.decryptReader({ sourceFd: this.fd, position: file.offset, size: file.size })
    return reader
  }

  extractFile(file: PZFilePacked, target: string, progress?: ProgressReporter<number>) {
    const targetExists = fs.existsSync(target)
    if (targetExists) {
      throw new FileAlreadyExistsError()
    }

    let lastReportTime = 0
    const progressReport = (p: number) => {
      const now = performance.now()
      if (now - lastReportTime > 300) {
        progress?.(p)
        lastReportTime = now
      }
    }

    ensureDir(path.parse(target).dir)
    const targetFd = fs.openSync(target, 'w')
    this.crypto.decryptFile({
      sourceFd: this.fd,
      targetFd,
      position: file.offset,
      size: file.size,
      offset: 0,
      progress: progressReport,
    })

    fs.closeSync(targetFd)
  }
  private statisticExtractSize(files: PZFilePacked[]) {
    let sumSize = 0
    for (const f of files) {
      sumSize += f.size
    }
    return sumSize
  }
  extractAll(targetDir: string, progress?: ProgressReporter<ExtractProgress>) {
    const indices = this.loadIndex()
    return this.extractFolder(indices.root, targetDir, progress)
  }
  extractFolder(folder: PZFolder, targetDir: string, progress?: ProgressReporter<ExtractProgress>) {
    ensureEmptyDir(targetDir)

    const indices = this.loadIndex()
    const files = indices.getFilesDeep(folder)
    const totalSize = this.statisticExtractSize(files)
    const totalCount = files.length

    const totalCache = { count: 0, size: 0 }
    const fileCache = { current: 0, total: 0 }
    const progressReport = (p: number) => {
      fileCache.current = p
      progress?.({
        current: fileCache.current,
        currentSize: fileCache.total,
        extractSize: totalCache.size + fileCache.current,
        totalSize,
        extractCount: totalCache.count,
        totalCount,
      })
    }
    const fileComplete = (f: PZFilePacked) => {
      totalCache.count += 1
      totalCache.size += f.size
    }
    const fileStart = (f: PZFilePacked) => {
      fileCache.current = 0
      fileCache.total = f.size
    }

    for (const file of files) {
      const rpath = indices.resolvePath(file, folder)
      const outputPath = path.join(targetDir, rpath)

      fileStart(file)
      this.extractFile(file, outputPath, progressReport)
      fileComplete(file)
    }

    progress?.({
      current: fileCache.total,
      currentSize: fileCache.total,
      extractSize: totalSize,
      totalSize,
      extractCount: totalCount,
      totalCount,
    })
  }

  // async methods
  extractFileAsync(file: PZFilePacked, target: string, frequency?: number) {
    const targetExists = fs.existsSync(target)
    if (targetExists) {
      throw new FileAlreadyExistsError()
    }
    ensureDir(path.parse(target).dir)

    const progressCache: ExtractProgress = {
      current: 1,
      currentSize: file.size,
      extractSize: 0,
      totalSize: file.size,
      extractCount: 0,
      totalCount: 1,
    }
    const [task, cancelToken] = taskManager.create<ExtractProgress>(progressCache)
    const progressReport = (p: number) => {
      progressCache.extractSize = p
      taskManager.update(task, progressCache)
    }

    let processedBytes = 0
    const exec = async () => {
      const targetFd = await fsOpenAsync(target, 'w')
      processedBytes = await this.crypto.decryptFileAsync({
        sourceFd: this.fd,
        targetFd,
        position: file.offset,
        size: file.size,
        offset: 0,
        cancelToken,
        progress: progressReport,
        frequency,
      })
      await fsCloseAsync(targetFd)
    }

    exec()
      .then(() => {
        progressCache.extractSize = processedBytes
        progressCache.extractCount = 1

        taskManager.update(task, progressCache)
        taskManager.complete(task)
      })
      .catch((err) => taskManager.throwError(task, err))

    return task
  }
  extractAllAsync(targetDir: string, frequency?: number) {
    const indices = this.loadIndex()
    return this.extractFolderAsync(indices.root, targetDir, frequency)
  }
  extractFolderAsync(folder: PZFolder, targetDir: string, frequency?: number) {
    ensureEmptyDir(targetDir)

    const indices = this.loadIndex()
    const files = indices.getFilesDeep(folder)

    const progressCache: ExtractProgress = {
      current: 0,
      currentSize: 1,
      extractSize: 0,
      totalSize: this.statisticExtractSize(files),
      extractCount: 0,
      totalCount: files.length,
    }
    const [task, cancelToken] = taskManager.create<ExtractProgress>(progressCache)

    const progressReport = (p: number) => {
      progressCache.current = p
      taskManager.update(task, {
        ...progressCache,
        extractSize: progressCache.extractSize + progressCache.current,
      })
    }
    const fileComplete = (f: PZFilePacked) => {
      progressCache.extractCount += 1
      progressCache.extractSize += f.size
    }
    const fileStart = (f: PZFilePacked) => {
      progressCache.current = 0
      progressCache.currentSize = f.size
    }

    const exec = async () => {
      for (const file of files) {
        const rpath = indices.resolvePath(file, folder)
        const outputPath = path.join(targetDir, rpath)
        ensureDir(path.parse(outputPath).dir)
        const targetFd = await fsOpenAsync(outputPath, 'w')

        fileStart(file)
        await this.crypto.decryptFileAsync({
          sourceFd: this.fd,
          targetFd,
          position: file.offset,
          size: file.size,
          offset: 0,
          cancelToken,
          progress: progressReport,
          frequency,
        })
        fileComplete(file)
        await fsCloseAsync(targetFd)
        if (cancelToken.canceled) {
          break
        }
      }
    }

    exec()
      .then(() => {
        const completeProgress = cancelToken.canceled
          ? {
              ...progressCache,
              extractSize: progressCache.extractSize + progressCache.current,
            }
          : progressCache

        taskManager.update(task, completeProgress)
        taskManager.complete(task)
      })
      .catch((err) => taskManager.throwError(task, err))

    return task
  }

  close() {
    if (this._fd) {
      fs.closeSync(this._fd)
      this._fd = undefined
    }
  }
}

const readVersion = (fd: number) => {
  const buf = Buffer.alloc(4)
  fs.readSync(fd, buf, 0, 4, 0)
  const version = buf.readInt32LE(0)
  return version
}
const checkPZSign = (fd: number) => {
  const tempBuffer = Buffer.alloc(32)
  fs.readSync(fd, tempBuffer, 0, 32, 4)
  return checkSign(tempBuffer)
}

export const checkPZPackFile = (fd: number) => {
  const version = readVersion(fd)
  if (!isCompatible(version)) {
    throw new NotSupportedVersionError()
  }
  const type = checkPZSign(fd)

  return { version, type }
}
export const getPasswordHash = (fd: number) => {
  const pwhashBuffer = Buffer.alloc(32)
  fs.readSync(fd, pwhashBuffer, 0, 32, 36)
  return bytesToHex(pwhashBuffer)
}
export const getPZPackFileMate = (filename: string) => {
  let fd
  try {
    fd = fs.openSync(filename, 'r')
    const { version, type } = checkPZPackFile(fd)
    const pwHash = getPasswordHash(fd)
    return { version, type, pwHash }
  } finally {
    if (fd) {
      fs.closeSync(fd)
    }
  }
}

export const OpenPzFile = (filename: string, password: string | Buffer) => {
  const key = typeof password === 'string' ? createKey(password) : password
  const pzHandle = new PZLoader(filename, key)
  return pzHandle
}
export type { PZLoader }
