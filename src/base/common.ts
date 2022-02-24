import { sha256, sha256Hex } from './hash'

export const compatibleVersions = [1, 2, 3]
export const currentVersion = 3
export const pzSign = 'PZPACK'
export const folderRootId = 10000
export const headLength = 68

export const isCompatible = (version: number) => {
  return compatibleVersions.includes(version)
}

export const getSignHashHex = () => sha256Hex(pzSign)
export const getSignHash = () => sha256(pzSign)

export type ProgressReporter<T> = (value: T) => void
