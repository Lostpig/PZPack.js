import type { FileHandle } from 'fs/promises'
import type { Stats } from 'fs'
import * as path from 'path'

import { bytesToHex } from './utils/utils'
import { type PZCrypto, type DecryptFileProgress, createPZDecipherReader, createPZCrypto } from './common/crypto'
import { compatibleVersions, pzSign } from './common/contants'
import { provider } from './common/provider'
import { PZError, errorCodes } from './exceptions'
import { sha256Hex } from './utils/hash'
import { craeteIndexLoader, type PZIndexLoader } from './pzindex/loader'
import type { PZFolder, PZFilePacked } from './types'
import { PZMemoryWriter } from './utils/pzhandle'
import { type CancelToken, type AsyncTask, taskManager } from './utils/task'
import { PZSubject } from './utils/subscription'

import { getContext } from './common/context'
const ctx = getContext()

interface PZFileHead {
  version: number
  sign: string
  passwordHash: string
  createTime: number
  fileSize: number
  blockSize: number
  indexSize: number
}
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

const readFileHead = async (source: FileHandle): Promise<PZFileHead> => {
  const headBuf = Buffer.alloc(92)
  await source.read({ buffer: headBuf, offset: 0, position: 0, length: 92 })

  const version = headBuf.readInt32LE(0)
  const signBuf = headBuf.slice(4, 36)
  const sign = bytesToHex(signBuf)
  const pwHash = headBuf.slice(36, 68)
  const passwordHash = bytesToHex(pwHash)
  const createTime = Number(headBuf.readBigInt64LE(68))
  const fileSize = Number(headBuf.readBigInt64LE(76))
  const blockSize = headBuf.readInt32LE(84)
  const indexSize = headBuf.readInt32LE(88)

  ctx.logger?.debug(`readFileHead: version = ${version}, size = ${fileSize}, blockSize = ${blockSize}, indexSize = ${indexSize}`)

  return {
    version,
    sign,
    passwordHash,
    createTime,
    fileSize,
    blockSize,
    indexSize,
  }
}
const checkFileHead = (head: PZFileHead, crypto: PZCrypto, fileStat: Stats) => {
  if (compatibleVersions.includes(head.version) !== true) {
    throw new PZError(errorCodes.NotSupportVersion, { version: head.version })
  }

  const signHash = sha256Hex(pzSign)
  if (signHash !== head.sign) {
    throw new PZError(errorCodes.NotSupportFile, { sign: head.sign })
  }

  if (crypto.pwHashHex !== head.passwordHash) {
    throw new PZError(errorCodes.IncorrectPassword)
  }

  if (head.fileSize !== fileStat.size) {
    throw new PZError(errorCodes.FileSizeCheckFailed, { size: head.fileSize })
  }
}
const loadFileIndex = async (source: FileHandle, head: PZFileHead, crypto: PZCrypto) => {
  const encryptedBuf = Buffer.alloc(head.indexSize)
  await source.read({
    buffer: encryptedBuf, 
    offset: 0,
    position: 92,
    length: head.indexSize
  })
  const indexData = crypto.decryptBlock(encryptedBuf)
  return craeteIndexLoader(indexData)
}

class PZLoader {
  private _head: PZFileHead
  private _crypto: PZCrypto
  private _source: FileHandle
  private _index: PZIndexLoader

  get version() {
    return this._head.version
  }
  get size() {
    return this._head.fileSize
  }
  get blockSize() {
    return this._head.blockSize
  }
  get createTime() {
    return this._head.createTime
  }
  get index () {
    return this._index
  }

  constructor(source: FileHandle, crypto: PZCrypto, head: PZFileHead, index: PZIndexLoader) {
    this._crypto = crypto
    this._source = source
    this._head = head
    this._index = index
  }

  async loadFile(file: PZFilePacked) {
    const fileWriter = new PZMemoryWriter(undefined, file.originSize)
    await this._crypto.decryptFile(this._source, fileWriter, {
      position: file.offset,
      offset: 0,
      size: file.size,
      blockSize: this.blockSize,
    })
    return fileWriter.getData()
  }
  loadFileTask(file: PZFilePacked, writer: PZMemoryWriter) {
    const [task, cancelToken] = taskManager.create({})
    const progress$ = new PZSubject<DecryptFileProgress>()

    this._crypto
      .decryptFile(this._source, writer, {
        position: file.offset,
        offset: 0,
        size: file.size,
        blockSize: this.blockSize,
        cancelToken,
        progress: progress$,
      })
      .then(() => taskManager.complete(task))
      .catch((err) => taskManager.throwError(task, err))
      .finally(() => progress$.complete())

    return task
  }
  craeteFileReader(file: PZFilePacked) {
    return createPZDecipherReader(this._source, this._crypto, { file, blockSize: this.blockSize })
  }

  private async extractTask(
    target: string,
    file: PZFilePacked,
    cancelToken: CancelToken,
    progress: PZSubject<DecryptFileProgress>,
  ) {
    const { ensureFile } = provider.get('fs-helper')
    const handle = await ensureFile(target, 'wx')
    const writtenBytes = await this._crypto.decryptFile(this._source, handle, {
      position: file.offset,
      offset: 0,
      size: file.size,
      blockSize: this.blockSize,
      cancelToken,
      progress,
    })
    await handle.close()
    return writtenBytes
  }
  extractFile(file: PZFilePacked, target: string) {
    const { fileExistsSync } = provider.get('fs-helper')
    const targetExists = fileExistsSync(target)
    if (targetExists) {
      throw new PZError(errorCodes.PathAlreadyExists, { path: target })
    }

    const progress$ = new PZSubject<DecryptFileProgress>()
    const [task, cancelToken] = taskManager.create<ExtractProgress>({
      current: 0,
      currentSize: file.originSize,
      extractCount: 0,
      totalCount: 1,
      extractSize: 0,
      totalSize: file.originSize,
    })
    progress$.subscribe((p) => {
      taskManager.update(task, { current: p.writtenBytes, extractSize: p.writtenBytes })
    })

    this.extractTask(target, file, cancelToken, progress$)
      .then(() => taskManager.complete(task))
      .catch((err) => taskManager.throwError(task, err))
      .finally(() => {
        progress$.complete()
      })

    return task
  }
  private async checkFilesExists(list: { target: string }[]) {
    const { fileExists } = provider.get('fs-helper')
    for (const f of list) {
      if (await fileExists(f.target)) {
        throw new PZError(errorCodes.PathAlreadyExists, { path: f.target })
      }
    }
  }
  private async extractBatchTasks(
    list: { file: PZFilePacked; target: string }[],
    task: AsyncTask<ExtractProgress>,
    cancelToken: CancelToken,
  ) {
    await this.checkFilesExists(list)

    let sumWritten = 0
    let extractCount = 0
    const progress$ = new PZSubject<DecryptFileProgress>()
    progress$.subscribe((p) => {
      taskManager.update(task, { current: p.writtenBytes, extractSize: sumWritten + p.writtenBytes })
    })

    for (const item of list) {
      if (cancelToken.canceled) break
      taskManager.update(task, { current: 0, currentSize: item.file.originSize })
      const writtenBytes = await this.extractTask(item.target, item.file, cancelToken, progress$)
      sumWritten += writtenBytes
      extractCount++
      taskManager.update(task, { extractCount, extractSize: sumWritten })
    }

    progress$.complete()
  }
  extractBatch(folder: PZFolder, targetDir: string) {
    const files = this.index.getChildrenFiles(folder)
    let totalOriginSize = 0
    const list = files.map((file) => {
      const resolvePath = this.index.resolvePath(file, folder)
      const target = path.join(targetDir, resolvePath)
      totalOriginSize += file.originSize
      return { file, target }
    })
    const [task, cancelToken] = taskManager.create<ExtractProgress>({
      current: 0,
      currentSize: 0,
      extractCount: 0,
      totalCount: list.length,
      extractSize: 0,
      totalSize: totalOriginSize,
    })

    this.extractBatchTasks(list, task, cancelToken)
      .then(() => taskManager.complete(task))
      .catch((err) => taskManager.throwError(task, err))

    return task
  }

  async close() {
    await this._source.close()
  }
}

export const checkPZFile = async (source: FileHandle, password: string | Buffer) => {
  const crypto = createPZCrypto(password)
  const head = await readFileHead(source)
  const stats = await source.stat()
  checkFileHead(head, crypto, stats)
}
export const createPZLoader = async (source: FileHandle, password: string | Buffer) => {
  const crypto = createPZCrypto(password)
  const head = await readFileHead(source)
  const stats = await source.stat()
  checkFileHead(head, crypto, stats)
  const index = await loadFileIndex(source, head, crypto)

  return new PZLoader(source, crypto, head, index)
}
export type { PZLoader }