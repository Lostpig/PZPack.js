import type { PZReadableHandle, PZReadOptions, PZWriteableHandle } from '../types'
import { PZError, errorCodes } from '../exceptions'

export class PZMemoryReader implements PZReadableHandle {
  private _buffer: Buffer
  get buffer() {
    return this._buffer
  }
  get size() {
    return this._buffer.byteLength
  }

  constructor(buffer: Buffer) {
    this._buffer = buffer
  }
  async read(options: PZReadOptions) {
    const { buffer, offset, position, length } = options
    if (position < 0 || position >= this._buffer.byteLength) {
      throw new PZError(errorCodes.ParameterInvaild, { parameter: 'position', value: position })
    }
    if (offset < 0 || offset >= buffer.byteLength) {
      throw new PZError(errorCodes.ParameterInvaild, { parameter: 'offset', value: offset })
    }
    if (length < 0) {
      throw new PZError(errorCodes.ParameterInvaild, { parameter: 'length', value: length })
    }

    const bufLength = buffer.byteLength - offset
    const dataLength = this._buffer.byteLength - position
    const readLength = Math.min(bufLength, dataLength, length)

    const bytesRead = readLength > 0 ? this._buffer.copy(buffer, offset, position, position + readLength) : 0

    return {
      buffer,
      bytesRead,
    }
  }
}
export class PZMemoryWriter implements PZWriteableHandle {
  private _buffer: Buffer
  private _endPosition: number
  constructor (initData?: Buffer, initSize: number = 0xffff) {
    if (initData) {
      this._buffer = Buffer.alloc(initData.byteLength)
      this._buffer.set(initData, 0)
      this._endPosition = initData.byteLength
    } else {
      this._buffer = Buffer.alloc(initSize)
      this._endPosition = 0
    }
  }
  async write (buffer: Buffer, offset: number, length: number, position: number)  {
    if (offset < 0 || offset >= buffer.byteLength) {
      throw new PZError(errorCodes.ParameterInvaild, { parameter: 'offset', value: offset })
    }
    if (length < 0) {
      throw new PZError(errorCodes.ParameterInvaild, { parameter: 'length', value: length })
    }

    const bufLength = buffer.byteLength - offset
    const writeLength = Math.min(length, bufLength)

    if (writeLength > 0) {
      if (position + writeLength > this._buffer.byteLength) {
        const addSize = this._buffer.byteLength < 0xffffff ? this._buffer.byteLength : 0xffffff
        const newBuffer = Buffer.alloc(this._buffer.byteLength + addSize)
        newBuffer.set(this._buffer, 0)

        this._buffer = newBuffer
      }

      const bytesWritten = buffer.copy(this._buffer, position, offset, offset + writeLength)
      if (position + bytesWritten > this._endPosition) {
        this._endPosition = position + bytesWritten
      }
      return {
        buffer,
        bytesWritten
      }
    } else {
      return {
        buffer,
        bytesWritten: 0
      }
    }
  }
  getData () {
    return this._buffer.slice(0, this._endPosition)
  }
}
