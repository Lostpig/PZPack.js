import * as path from 'path'

export type codecType = 'copy' | 'libx265' | 'nvenc'
export const isVideoFile = (filename: string) => {
  const ext = path.extname(filename)
  return ['.avi', '.mkv', '.mp4'].includes(ext)
}