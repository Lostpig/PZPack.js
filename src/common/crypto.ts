import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { sha256, sha256Hex } from '../utils/hash'
import { bytesToHex, wait } from '../utils/utils'
import type { PZSubject } from '../utils/subscription'
import type { CancelToken } from '../utils/task'
import type { PZFilePacked, PZReadableHandle, PZWriteableHandle } from '../types'
import { getContext } from './context'

export type EncryptFileProgress = {
  writtenBytes: number
  writtenBlocks: number
  readedBytes: number
}
export interface EncryptFileOption {
  /** 从源数据流读取的位置 */
  position: number
  /** 目标流写入的偏移量 */
  offset: number
  /** 读取数据大小 */
  size: number
  /** 进度通知器 */
  progress?: PZSubject<EncryptFileProgress>
  /** 执行间隔(ms) */
  frequency?: number
  /** 取消标识器 */
  cancelToken?: CancelToken
  /** 分块大小 */
  blockSize: number
}
export type DecryptFileProgress = {
  writtenBytes: number
  readedBlocks: number
  readedBytes: number
}
export interface DecryptFileOption {
  /** 从源数据流读取的位置 */
  position: number
  /** 目标流写入的偏移量 */
  offset: number
  /** 读取数据大小 */
  size: number
  /** 进度通知器 */
  progress?: PZSubject<DecryptFileProgress>
  /** 执行间隔(ms) */
  frequency?: number
  /** 取消标识器 */
  cancelToken?: CancelToken
  /** 分块大小 */
  blockSize: number
}

const ctx = getContext()
// 加密算法固定
// AES-256-CBC PKCS7 加密
const algorithm = 'aes-256-cbc'
const ivSize = 16

const createKey = (password: string) => {
  const key = sha256(password)
  return key
}
const createKeyHash = (key: Buffer) => {
  const hash = sha256(sha256Hex(key))
  const hex = bytesToHex(hash)
  return { hash, hex }
}

class PZCrypto {
  key: Buffer
  pwHash: Buffer
  pwHashHex: string

  constructor(key: Buffer) {
    this.key = key
    const { hash, hex } = createKeyHash(key)
    this.pwHash = hash
    this.pwHashHex = hex
  }
  private generateIV() {
    return randomBytes(ivSize)
  }
  encrypt(buf: Buffer) {
    const iv = this.generateIV()
    const cipher = createCipheriv(algorithm, this.key, iv)
    const encryptBuf = cipher.update(buf)
    const finalBuf = cipher.final()

    const result = Buffer.concat([iv, encryptBuf, finalBuf])
    return result
  }
  async encryptFile(source: PZReadableHandle, target: PZWriteableHandle, options: EncryptFileOption) {
    const { position, offset, size, frequency, progress, cancelToken, blockSize } = options

    const blockBuf = Buffer.alloc(blockSize)

    let sumReaded = 0
    let sumWritten = 0
    let writtenBlocks = 0

    while (sumReaded < size) {
      if (cancelToken?.canceled === true) break

      const readLength = Math.min(size - sumReaded, blockBuf.length)
      const readResult = await source.read({
        buffer: blockBuf,
        offset: 0,
        position: position + sumReaded,
        length: readLength,
      })
      sumReaded += readResult.bytesRead

      const contentBuf = readResult.bytesRead < blockBuf.length ? blockBuf.slice(0, readResult.bytesRead) : blockBuf
      const encryptBuf = this.encrypt(contentBuf)
      const writeResult = await target.write(encryptBuf, 0, encryptBuf.length, offset + sumWritten)
      sumWritten += writeResult.bytesWritten

      writtenBlocks += 1
      progress?.next({
        writtenBlocks,
        writtenBytes: sumWritten,
        readedBytes: sumReaded,
      })
      if (frequency && frequency > 1) {
        await wait(frequency)
      }
    }

    if (!cancelToken?.canceled === true) {
      progress?.next({
        writtenBlocks,
        writtenBytes: sumWritten,
        readedBytes: sumReaded,
      })
    }

    ctx.logger?.debug(
      `encryptFile excuted: blockSize = ${blockSize}, size = ${size}, ` + 
      `sumReaded = ${sumReaded}, sumWritten = ${sumWritten}, writtenBlocks = ${writtenBlocks}`
    )

    return sumWritten
  }

  decrypt(buf: Buffer, iv: Buffer) {
    const decipher = createDecipheriv(algorithm, this.key, iv)
    const decryptBuf = decipher.update(buf)
    const finalBuf = decipher.final()

    const result = Buffer.concat([decryptBuf, finalBuf])
    return result
  }
  decryptBlock(buf: Buffer) {
    const iv = buf.slice(0, 16)
    const content = buf.slice(16)
    return this.decrypt(content, iv)
  }
  async decryptFile(source: PZReadableHandle, target: PZWriteableHandle, options: DecryptFileOption) {
    const { position, offset, size, frequency, progress, cancelToken, blockSize } = options

    const encryptBlockSize = (16 - blockSize % 16) + blockSize
    const readBuf = Buffer.alloc(encryptBlockSize + 16)

    let sumReaded = 0
    let sumWritten = 0
    let readedBlocks = 0

    while (sumReaded < size) {
      if (cancelToken?.canceled === true) break
      const readLength = Math.min(size - sumReaded, readBuf.length)
      const readResult = await source.read({
        buffer: readBuf,
        offset: 0,
        position: position + sumReaded,
        length: readLength,
      })
      sumReaded += readResult.bytesRead
      readedBlocks += 1

      const blockBuf = readResult.bytesRead < readBuf.length ? readBuf.slice(0, readResult.bytesRead) : readBuf
      const decryptBuf = this.decryptBlock(blockBuf)
      const writeResult = await target.write(decryptBuf, 0, decryptBuf.length, offset + sumWritten)
      sumWritten += writeResult.bytesWritten

      progress?.next({
        readedBlocks,
        writtenBytes: sumWritten,
        readedBytes: sumReaded,
      })
      if (frequency && frequency > 1) {
        await wait(frequency)
      }
    }

    if (!cancelToken?.canceled === true) {
      progress?.next({
        readedBlocks,
        writtenBytes: sumWritten,
        readedBytes: sumReaded,
      })
    }

    ctx.logger?.debug(
      `decryptFile excuted: blockSize = ${blockSize}, size = ${size}, encryptBlockSize = ${encryptBlockSize}` + 
      `sumReaded = ${sumReaded}, sumWritten = ${sumWritten}, readedBlocks = ${readedBlocks}`
    )

    return sumReaded
  }
}

export interface PZDecipherReaderOptions {
  file: PZFilePacked
  blockSize: number
}
class PZDecipherReader {
  private source: PZReadableHandle
  private crypto: PZCrypto
  private blockSize: number
  private bindingFile: PZFilePacked
  private encryptedBlockSize: number

  constructor(source: PZReadableHandle, crypto: PZCrypto, options: PZDecipherReaderOptions) {
    this.source = source
    this.crypto = crypto
    this.blockSize = options.blockSize
    this.bindingFile = options.file
    this.encryptedBlockSize = (16 - this.blockSize % 16) + this.blockSize + 16
  }

  private async readBlock (block: number) {
    const currentOffset = this.encryptedBlockSize * block
    const readLength = Math.min(this.bindingFile.size - currentOffset, this.encryptedBlockSize)
    const start = this.bindingFile.offset + this.encryptedBlockSize * block

    const blockBuffer = Buffer.alloc(readLength)
    await this.source.read({
      buffer: blockBuffer,
      offset: 0,
      position: start,
      length: readLength,
    })

    const decryptBuffer = this.crypto.decryptBlock(blockBuffer)
    return decryptBuffer
  }
  async read(start: number, end?: number) {
    const _end = (end === undefined || end > this.bindingFile.originSize) ? this.bindingFile.originSize : end
    if (start > _end) throw new RangeError()
    if (start === end) return Buffer.alloc(0)

    const startBlock = Math.floor(start / this.blockSize)
    const startBlockOffset = start - startBlock * this.blockSize
    const endBlock = Math.floor(_end / this.blockSize)
    const endBlockEndPos = _end - endBlock * this.blockSize

    const resultBuf = Buffer.alloc(_end - start)
    let resultOffset = 0
    for (let i = startBlock; i <= endBlock; i++) {
      const decryptBuf = await this.readBlock(i)
      if (i === startBlock) {
        decryptBuf.copy(resultBuf, resultOffset, startBlockOffset)
        resultOffset += decryptBuf.length - startBlockOffset
      } else if (i === endBlock) {
        decryptBuf.copy(resultBuf, resultOffset, 0, endBlockEndPos)
        resultOffset += endBlockEndPos
      } else {
        decryptBuf.copy(resultBuf, resultOffset)
        resultOffset += decryptBuf.length
      }
    }

    ctx.logger?.debug(`paramter length = ${_end - start}, real load length = ${resultOffset}`)
    return resultBuf
  }
}

export const createPZCrypto = (password: string | Buffer) => {
  const key = typeof password === 'string' ? createKey(password) : password
  return new PZCrypto(key)
}
export const createPZDecipherReader = (source: PZReadableHandle, crypto: PZCrypto, options: PZDecipherReaderOptions) => {
  return new PZDecipherReader(source, crypto, options)
}
export type { PZCrypto, PZDecipherReader }