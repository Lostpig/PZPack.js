import * as fs from 'fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { sha256, sha256Hex } from './hash'
import { bytesToHex, fsReadAsync, fsWriteAsync, wait } from './utils'
import { currentVersion, type ProgressReporter } from './common'
import type { CancelToken } from './task'

export interface PZCrypto {
  readonly passwordHash: Buffer
  readonly passwordHashHex: string

  encrypt: (buf: Buffer) => Buffer
  decrypt: (buf: Buffer) => Buffer
  decryptFile: (option: CryptoStreamOption) => void
  decryptFileAsync: (option: CryptoStreamOptionAysnc) => Promise<number>
}
export interface CryptoStreamOption {
  sourceFd: number
  targetFd: number
  // 从源数据流读取的位置
  position: number
  // 目标流写入的偏移量
  offset: number
  // 读取数据大小
  size: number
  // 进度通知器
  progress?: ProgressReporter<number>
}
export interface CryptoStreamOptionAysnc extends CryptoStreamOption {
  frequency?: number
  canceled: CancelToken
}


// 加密算法固定
// AES-256-CBC PKCS7 加密
const algorithm = 'aes-256-cbc'
const ivSize = 16

class PZCryptoBase {
  key: Buffer
  pwHash: Buffer
  pwHashHex: string

  constructor(password: string) {
    this.key = sha256(password)
    this.pwHash = sha256(sha256Hex(this.key))
    this.pwHashHex = bytesToHex(this.pwHash)
  }
  encrypt(buf: Buffer, iv: Buffer) {
    const cipher = createCipheriv(algorithm, this.key, iv)
    const encryptBuf = cipher.update(buf)
    const finalBuf = cipher.final()

    const result = Buffer.concat([iv, encryptBuf, finalBuf])
    return result
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
    const { sourceFd, targetFd, position, offset, size, frequency, progress } = option
    const tempBuf = Buffer.alloc(65536)
    const decipher = createDecipheriv(algorithm, this.key, iv)

    let sumReaded = 0
    let sumWritten = 0
    while (sumReaded < size) {
      if (option.canceled.value) break
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

    if (!option.canceled.value) {
      const finalBuf = decipher.final()
      const bytesWritten = await fsWriteAsync(targetFd, finalBuf, 0, finalBuf.length, offset + sumWritten)
      sumWritten += bytesWritten
      progress?.(size)
    } else {
      decipher.destroy()
    }

    return sumReaded
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

  constructor(password: string) {
    this.base = new PZCryptoBase(password)
  }
  private generateIV() {
    return randomBytes(ivSize)
  }

  encrypt(buf: Buffer) {
    const iv = this.generateIV()
    return this.base.encrypt(buf, iv)
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

  constructor(password: string) {
    this.base = new PZCryptoBase(password)
    this.iv = sha256(this.base.key).slice(0, ivSize)
  }

  encrypt(buf: Buffer) {
    return this.base.encrypt(buf, this.iv)
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
}

export const getPZCrypto = (password: string, version: number): PZCrypto => {
  if (version === currentVersion) {
    return new PZCryptoCurrent(password)
  } else {
    return new PZCryptoV1(password)
  }
}
