import { PZIndexBuilder, buildPZPackFile, PZSubscription, createPZLoader } from '../src'
import { MockFileHandle, createRandomBuffer, fileStore, equalBuffer, assert } from './test.base'

const files = ['a/a/a.txt', 'a/a/b.txt', 'a/a/c.txt', 'a/a/d.txt']
const buildTestFile = (target: string) => {
  for (const f of files) {
    const sourceBuf = createRandomBuffer(515097)
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

  const task = buildPZPackFile(idx, { password: '123456', blockSize: 35000, target })

  return task
}

const testLoader = async () => {
  const buildTask = buildTestFile('xx/xx.papk')
  await PZSubscription.waitObservable(buildTask.observable())

  const source = fileStore.get('xx/xx.papk')!
  const loader = await createPZLoader(source as any, '123456')
  const indexLoader = loader.index

  const folders = indexLoader.getChildrenFolders(indexLoader.root)
  const folderX = folders.find((f) => f.fullname === 'xxx')
  const folderY = folders.find((f) => f.fullname === 'xxx')
  assert(folderX, 'Error: folder xxx not found')
  assert(folderY, 'Error: folder yyy not found')

  if (folderX) {
    const file1 = indexLoader.findFile(folderX, '1.txt')
    const file2 = indexLoader.findFile(folderX, '2.txt')
    assert(file1, 'Error: file 1.txt not found')
    assert(file2, 'Error: file 2.txt not found')

    if (file1) {
      const fileData = await loader.loadFile(file1)
      const originFile = fileStore.get('a/a/a.txt')!
      assert(
        equalBuffer(fileData, originFile.innerBuffer),
        `load file test failed: decrypt file and source file is not equal`,
      )
    }
    if (file2) {
      const fileReader = await loader.craeteFileReader(file2)
      const originFile = fileStore.get('a/a/b.txt')!
      const segment = await fileReader.read(120, 5000)
      const orgSegment = originFile.innerBuffer.slice(120, 5000)
      assert(
        equalBuffer(segment, orgSegment),
        `file reader test failed: decrypt segment and source segment is not equal`,
      )
    }
  }
  if (folderY) {
    const file3 = indexLoader.findFile(folderY, '1.txt')
    const file4 = indexLoader.findFile(folderY, '2.txt')
    assert(file3, 'Error: file 3.txt not found')
    assert(file4, 'Error: file 4.txt not found')
  }

  console.log('pzpk loader test complete')
}

testLoader()
  .then(() => {
    process.exit(0)
  })
  .catch((err) => console.error(err))
