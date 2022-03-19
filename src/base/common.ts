import { sha256, sha256Hex } from './hash'
import { bytesToHex } from './utils'

export const compatibleVersions = [1, 2, 3, 4]
export const currentVersion = 4
export const folderRootId = 10000
export const headLength = 68

export const isCompatible = (version: number) => {
  return compatibleVersions.includes(version)
}

export type PZTypes = 'PZPACK' | 'PZVIDEO'
export type PZSign = {
  hex: string
  bytes: Buffer
}

export const PZSigns: { [key in PZTypes]: PZSign } = {
  PZVIDEO: {
    get hex () {
      return sha256Hex('PZVIDEO')
    },
    get bytes () {
      return sha256('PZVIDEO')
    }
  },
  PZPACK: {
    get hex () {
      return sha256Hex('PZPACK')
    },
    get bytes () {
      return sha256('PZPACK')
    }
  }
}
export const PZExt: { [key in PZTypes]: string } = {
  PZPACK: '.pzpk',
  PZVIDEO: '.pzmv'
}

export const checkSign = (sign: Buffer | string): PZTypes => {
  const signHex = typeof sign === 'string' ? sign : bytesToHex(sign)
  switch (signHex) {
    case PZSigns.PZVIDEO.hex: return 'PZVIDEO'
    case PZSigns.PZPACK.hex: return 'PZPACK'
    default: throw new Error('Not support file')
  }
}
export type ProgressReporter<T> = (value: T) => void
