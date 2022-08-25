import { PZIndexBuilder, buildPZPackFile, PZSubscription, type BuildProgress } from '../src'
import { MockFileHandle, createRandomBuffer, fileStore } from './test.base'

const printBuildProgress = (p: BuildProgress) => {
  const currentPrec = (p.currentWrittenBytes / (p.currentTotalBytes || 1)) * 100
  const sumPrec = (p.sumWrittenBytes / (p.sumTotalBytes || 1)) * 100
  console.log(
    `current: ${currentPrec.toFixed(2)}%, sum: ${sumPrec.toFixed(2)}%, count: ${p.filePackedCount} / ${
      p.fileTotalCount
    }`,
  )
}

const testBuilder = () => {
  const files = ['a/a/a.txt', 'a/a/b.txt', 'a/a/c.txt', 'a/a/d.txt']

  for (const f of files) {
    const sourceBuf = createRandomBuffer(7889902)
    const source = new MockFileHandle(sourceBuf)
    fileStore.set(f, source)
  }

  const idx = new PZIndexBuilder()
  const root = idx.getRoot()
  const folderX = idx.addFolder('xxx', root.id)
  const folderY = idx.addFolder('yyy', root.id)
  idx.addFile(files[0], folderX.id, '1.txt')
  idx.addFile(files[1], folderX.id, '2.txt')
  idx.addFile(files[2], folderY.id, '3.txt')
  idx.addFile(files[3], folderY.id, '4.txt')

  const startTime = Date.now()
  const task = buildPZPackFile(idx, { password: '123456', blockSize: 35000, target: 'x/x/x.pzpk' })
  const progressOb = PZSubscription.frequencyPipe(task.observable(), 200)

  progressOb.subscribe(
    (p) => {
      printBuildProgress(p)
    },
    (err) => {
      console.error(err)
    },
    () => {
      printBuildProgress(progressOb.current)

      const endTime = Date.now()
      const elapsed = (endTime - startTime) / 1000
      const speed = (progressOb.current.sumWrittenBytes / 1024) / elapsed

      console.log(`pzpk build complete, use ${elapsed.toFixed(2)}s, processing ${speed.toFixed(2)}KiB/s`)
      const targetFile = fileStore.get('x/x/x.pzpk')
      console.log('packed file length = ' + targetFile?.size)

      process.exit(0)
    },
  )
}
testBuilder()
