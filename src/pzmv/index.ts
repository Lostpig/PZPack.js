export type { VideoCodecParam, AudioCodecParam, VCopyParams, VLibx265Params, VNvencParams } from './ffmpeg'
export {
  PZMVBuilder,
  PZMVBuilderOptions,
  PZMVProgress,
  PZMVIndexBuilder,
  PZMVIndexFile,
  serializeMvIndex,
  deserializeMvIndex,
} from './mvbuilder'
export { PZMVSimpleServer } from './mvserver'

import { defaultLibx265Params, defaultNvenvParams } from './ffmpeg'

function getVideoDefaultParams(encoder: 'nvenc'): typeof defaultNvenvParams
function getVideoDefaultParams(encoder: 'libx265'): typeof defaultLibx265Params
function getVideoDefaultParams(encoder: 'nvenc' | 'libx265') {
  if (encoder === 'nvenc') return Object.assign({}, defaultNvenvParams)
  else return Object.assign({}, defaultLibx265Params)
}

export { getVideoDefaultParams }
