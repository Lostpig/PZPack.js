import { createHash } from 'crypto'
import { bytesToHex } from './utils'

export const sha256 = (data: string | Buffer) => {
  const source = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return createHash('sha256').update(source).digest()
}
export const sha256Hex = (source: string | Buffer) => {
  return bytesToHex(sha256(source))
}
