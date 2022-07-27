import * as fs from 'fs'
import { createCipheriv, createDecipheriv, randomBytes, type Decipher } from 'crypto'
import { sha256, sha256Hex } from './hash'
import { bytesToHex, fsReadAsync, fsWriteAsync, wait } from './utils'
import { type ProgressReporter } from './common'
import type { CancelToken } from './task'

export interface PZCrypto {
  readonly passwordHash: Buffer
  readonly passwordHashHex: string

  encrypt: (buf: Buffer) => Buffer
  decrypt: (buf: Buffer) => Buffer
  decryptFile: (option: CryptoStreamOption) => void
  decryptFileAsync: (option: CryptoStreamOptionAysnc) => Promise<number>
  decryptReader: (option: CryptoReaderOption) => PZDecipherReader

  /**
   * @returns 返回总写入大小
   */
  encryptFile: (option: CryptoStreamOption) => number
  /**
   * @returns 返回总写入大小
   */
  encryptFileAsync: (option: CryptoStreamOptionAysnc) => Promise<number>
}
export interface CryptoReaderOption {
  sourceFd: number
  /** 从源数据流读取的位置 */
  position: number
  /** 读取数据大小 */
  size: number
}
export interface CryptoStreamOption {
  sourceFd: number
  targetFd: number
  /** 从源数据流读取的位置 */
  position: number
  /** 目标流写入的偏移量 */
  offset: number
  /** 读取数据大小 */
  size: number
  /** 进度通知器 */
  progress?: ProgressReporter<number>
}
export interface CryptoStreamOptionAysnc extends CryptoStreamOption {
  frequency?: number
  cancelToken: CancelToken
}

// 加密算法固定
// AES-256-CBC PKCS7 加密
const algorithm = 'aes-256-cbc'
const ivSize = 16

type PZDecipherReadResult = {
  data: Buffer
  end: boolean
}
class PZDecipherReader {
  private _fd: number
  private _offset: number
  private _length: number
  private _readed: number
  private _decipher: Decipher
  private _closed: boolean
  public get closed() {
    return this._closed
  }

  constructor(fd: number, offset: number, length: number, key: Buffer, iv: Buffer) {
    this._fd = fd
    this._offset = offset
    this._length = length
    this._readed = 0
    this._closed = false

    this._decipher = createDecipheriv(algorithm, key, iv)
  }
  private readFinal(): PZDecipherReadResult {
    const finalBuf = this._decipher.final()
    return {
      data: finalBuf,
      end: true,
    }
  }
  async read(length: number): Promise<PZDecipherReadResult> {
    if (this._closed) {
      throw new Error('PZDecipherReader Error: reader is closed')
    }

    if (this._readed >= this._length) {
      return this.readFinal()
    }

    const buf = Buffer.alloc(length)
    const readLength = Math.min(this._length - this._readed, buf.length)
    const bytesReaded = await fsReadAsync(this._fd, buf, {
      position: this._offset + this._readed,
      offset: 0,
      length: readLength,
    })

    let decryptBuf
    if (bytesReaded < buf.length) {
      decryptBuf = this._decipher.update(buf.slice(0, bytesReaded))
    } else {
      decryptBuf = this._decipher.update(buf)
    }
    this._readed += bytesReaded

    return {
      data: decryptBuf,
      end: false,
    }
  }
  reset () {
    if (this._closed) {
      throw new Error('PZDecipherReader Error: reader is closed')
    }

    this._readed = 0
  }
  destory() {
    if (!this._closed) {
      this._decipher.destroy()
      this._closed = true
    }
  }
}
export type { PZDecipherReader }

class PZCryptoBase {
  key: Buffer
  pwHash: Buffer
  pwHashHex: string

  static createKey(password: string) {
    const key = sha256(password)
    return key
  }
  static createKeyHash(key: Buffer) {
    const hash = sha256(sha256Hex(key))
    const hex = bytesToHex(hash)
    return { hash, hex }
  }

  constructor(key: Buffer) {
    this.key = key
    const { hash, hex } = PZCryptoBase.createKeyHash(key)
    this.pwHash = hash
    this.pwHashHex = hex
  }

  decrypt(buf: Buffer, iv: Buffer) {
    const decipher = createDecipheriv(algorithm, this.key, iv)
    const decryptBuf = decipher.update(buf)
    const finalBuf = decipher.final()

    const result = Buffer.concat([decryptBuf, finalBuf])
    return result
  }
  decryptFile(option: CryptoStreamOption, iv: Buffer) {
    const { sourceFd, targetFd, position, offset, size, progress } = option
    const tempBuf = Buffer.alloc(65536)

    const decipher = createDecipheriv(algorithm, this.key, iv)

    let sumReaded = 0
    let sumWritten = 0
    while (sumReaded < size) {
      const readLength = Math.min(size - sumReaded, tempBuf.length)
      const bytesReaded = fs.readSync(sourceFd, tempBuf, {
        position: position + sumReaded,
        offset: 0,
        length: readLength,
      })

      let decryptBuf
      if (bytesReaded < tempBuf.length) {
        decryptBuf = decipher.update(tempBuf.slice(0, bytesReaded))
      } else {
        decryptBuf = decipher.update(tempBuf)
      }

      const bytesWritten = fs.writeSync(targetFd, decryptBuf, 0, decryptBuf.length, offset + sumWritten)

      sumReaded += bytesReaded
      sumWritten += bytesWritten

      progress?.(sumReaded)
    }

    const finalBuf = decipher.final()
    const bytesWritten = fs.writeSync(targetFd, finalBuf, 0, finalBuf.length, offset + sumWritten)
    sumWritten += bytesWritten
    progress?.(size)
  }
  async decryptFileAsync(option: CryptoStreamOptionAysnc, iv: Buffer) {
    const { sourceFd, targetFd, position, offset, size, frequency, progress, cancelToken } = option
    const tempBuf = Buffer.alloc(65536)
    const decipher = createDecipheriv(algorithm, this.key, iv)

    let sumReaded = 0
    let sumWritten = 0
    while (sumReaded < size) {
      if (cancelToken.canceled) break
      const readLength = Math.min(size - sumReaded, tempBuf.length)

      const bytesReaded = await fsReadAsync(sourceFd, tempBuf, {
        position: position + sumReaded,
        offset: 0,
        length: readLength,
      })

      let decryptBuf
      if (bytesReaded < tempBuf.length) {
        decryptBuf = decipher.update(tempBuf.slice(0, bytesReaded))
      } else {
        decryptBuf = decipher.update(tempBuf)
      }

      const bytesWritten = await fsWriteAsync(targetFd, decryptBuf, 0, decryptBuf.length, offset + sumWritten)

      sumReaded += bytesReaded
      sumWritten += bytesWritten

      progress?.(sumReaded)
      if (frequency && frequency > 1) {
        await wait(frequency)
      }
    }

    if (!cancelToken.canceled) {
      const finalBuf = decipher.final()
      const bytesWritten = await fsWriteAsync(targetFd, finalBuf, 0, finalBuf.length, offset + sumWritten)
      sumWritten += bytesWritten
      progress?.(size)
    } else {
      decipher.destroy()
    }

    return sumReaded
  }
  decryptReader(option: CryptoReaderOption, iv: Buffer) {
    return new PZDecipherReader(option.sourceFd, option.position, option.size, this.key, iv)
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
  encryptFile(option: CryptoStreamOption) {
    const { sourceFd, targetFd, position, offset, size, progress } = option
    const iv = this.generateIV()
    const tempBuf = Buffer.alloc(65536)

    const cipher = createCipheriv(algorithm, this.key, iv)
    let sumReaded = 0
    let sumWritten = 0

    const ivWritten = fs.writeSync(targetFd, iv, 0, iv.length, offset)
    sumWritten += ivWritten

    while (sumReaded < size) {
      const readLength = Math.min(size - sumReaded, tempBuf.length)
      const bytesReaded = fs.readSync(sourceFd, tempBuf, {
        position: position + sumReaded,
        offset: 0,
        length: readLength,
      })

      let encryptBuf
      if (bytesReaded < tempBuf.length) {
        encryptBuf = cipher.update(tempBuf.slice(0, bytesReaded))
      } else {
        encryptBuf = cipher.update(tempBuf)
      }

      const bytesWritten = fs.writeSync(targetFd, encryptBuf, 0, encryptBuf.length, offset + sumWritten)

      sumReaded += bytesReaded
      sumWritten += bytesWritten

      progress?.(sumReaded)
    }

    const finalBuf = cipher.final()
    const bytesWritten = fs.writeSync(targetFd, finalBuf, 0, finalBuf.length, offset + sumWritten)
    sumWritten += bytesWritten
    progress?.(size)

    return sumWritten
  }
  async encryptFileAsync(option: CryptoStreamOptionAysnc) {
    const { sourceFd, targetFd, position, offset, size, frequency, progress, cancelToken } = option
    const iv = this.generateIV()
    const tempBuf = Buffer.alloc(65536)

    const cipher = createCipheriv(algorithm, this.key, iv)
    let sumReaded = 0
    let sumWritten = 0

    const ivWritten = await fsWriteAsync(targetFd, iv, 0, iv.length, offset)
    sumWritten += ivWritten

    while (sumReaded < size) {
      if (cancelToken.canceled) break
      const readLength = Math.min(size - sumReaded, tempBuf.length)

      const bytesReaded = await fsReadAsync(sourceFd, tempBuf, {
        position: position + sumReaded,
        offset: 0,
        length: readLength,
      })

      let encryptBuf
      if (bytesReaded < tempBuf.length) {
        encryptBuf = cipher.update(tempBuf.slice(0, bytesReaded))
      } else {
        encryptBuf = cipher.update(tempBuf)
      }

      const bytesWritten = await fsWriteAsync(targetFd, encryptBuf, 0, encryptBuf.length, offset + sumWritten)

      sumReaded += bytesReaded
      sumWritten += bytesWritten

      progress?.(sumReaded)
      if (frequency && frequency > 1) {
        await wait(frequency)
      }
    }

    if (!cancelToken.canceled) {
      const finalBuf = cipher.final()
      const bytesWritten = await fsWriteAsync(targetFd, finalBuf, 0, finalBuf.length, offset + sumWritten)
      sumWritten += bytesWritten
      progress?.(size)
    } else {
      cipher.destroy()
    }

    return sumWritten
  }
}

class PZCryptoCurrent implements PZCrypto {
  private base: PZCryptoBase
  get passwordHash() {
    return Buffer.from(this.base.pwHash)
  }
  get passwordHashHex() {
    return this.base.pwHashHex
  }

  constructor(key: Buffer) {
    this.base = new PZCryptoBase(key)
  }

  decrypt(buf: Buffer) {
    const iv = Buffer.alloc(ivSize)
    buf.copy(iv, 0, 0, ivSize)

    const encryptBuf = buf.slice(ivSize)
    return this.base.decrypt(encryptBuf, iv)
  }
  decryptFile(option: CryptoStreamOption) {
    const { sourceFd, position, size } = option

    const iv = Buffer.alloc(ivSize)
    fs.readSync(sourceFd, iv, { position, offset: 0, length: ivSize })

    this.base.decryptFile({ ...option, position: position + ivSize, size: size - ivSize }, iv)
  }
  decryptFileAsync(option: CryptoStreamOptionAysnc) {
    const { sourceFd, position, size } = option

    const iv = Buffer.alloc(ivSize)
    fs.readSync(sourceFd, iv, { position, offset: 0, length: ivSize })

    return this.base.decryptFileAsync({ ...option, position: position + ivSize, size: size - ivSize }, iv)
  }
  decryptReader(option: CryptoReaderOption) {
    const { sourceFd, position, size } = option
    const iv = Buffer.alloc(ivSize)
    fs.readSync(sourceFd, iv, { position, offset: 0, length: ivSize })

    return this.base.decryptReader({ ...option, position: position + ivSize, size: size - ivSize }, iv)
  }

  encrypt(buf: Buffer) {
    return this.base.encrypt(buf)
  }
  encryptFile(option: CryptoStreamOption) {
    return this.base.encryptFile(option)
  }
  encryptFileAsync(option: CryptoStreamOptionAysnc) {
    return this.base.encryptFileAsync(option)
  }
}

// compatible version 1 and 2
class PZCryptoV1 implements PZCrypto {
  private base: PZCryptoBase
  private iv: Buffer
  get passwordHash() {
    return Buffer.from(this.base.pwHash)
  }
  get passwordHashHex() {
    return this.base.pwHashHex
  }

  constructor(key: Buffer) {
    this.base = new PZCryptoBase(key)
    this.iv = sha256(this.base.key).slice(0, ivSize)
  }

  decrypt(buf: Buffer) {
    return this.base.decrypt(buf, this.iv)
  }
  decryptFile(option: CryptoStreamOption) {
    this.base.decryptFile(option, this.iv)
  }
  decryptFileAsync(option: CryptoStreamOptionAysnc) {
    return this.base.decryptFileAsync(option, this.iv)
  }
  decryptReader(option: CryptoReaderOption) {
    return this.base.decryptReader(option, this.iv)
  }

  encrypt(buf: Buffer) {
    return this.base.encrypt(buf)
  }
  encryptFile(option: CryptoStreamOption) {
    return this.base.encryptFile(option)
  }
  encryptFileAsync(option: CryptoStreamOptionAysnc) {
    return this.base.encryptFileAsync(option)
  }
}

export const createKey = (password: string) => {
  return PZCryptoBase.createKey(password)
}
export const createKeyHash = (key: Buffer) => {
  return PZCryptoBase.createKeyHash(key)
}
export const createPZCryptoByKey = (key: Buffer, version: number): PZCrypto => {
  if (version === 1 || version === 2) {
    return new PZCryptoV1(key)
  } else {
    return new PZCryptoCurrent(key)
  }
}
export const createPZCryptoByPw = (password: string, version: number): PZCrypto => {
  const key = createKey(password)
  return createPZCryptoByKey(key, version)
}
