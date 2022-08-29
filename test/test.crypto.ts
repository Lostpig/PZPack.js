import { createPZCrypto, createPZDecipherReader } from '../src'
import { MockFileHandle, createRandomBuffer, equalBuffer, assert } from './test.base'

const testEncrypt = () => {
  const sourceBuf = createRandomBuffer(5517)
  const crypto = createPZCrypto('12345678')
  const resultBuf = crypto.encrypt(sourceBuf)

  const encryptSize = 16 - (sourceBuf.length % 16) + sourceBuf.length

  assert(
    resultBuf.length === encryptSize + 16,
    `Crypto encrypt size check failed:
      source size: ${sourceBuf.length}
      result size: ${resultBuf.length}`,
  )
  console.log('testEncrypt complete')
}
const testDecrypt = () => {
  const sourceBuf = createRandomBuffer(6613)
  const crypto = createPZCrypto('12345678')
  const encryptedBuf = crypto.encrypt(sourceBuf)
  const decryptedBuf = crypto.decryptBlock(encryptedBuf)

  const isEquals = equalBuffer(sourceBuf, decryptedBuf)
  assert(isEquals, `Crypto decrypt check failed: decrypt buffer and source buffer is not equal`)
  console.log('testDecrypt complete')
}
const testCryptoForFile = async () => {
  const bsz = 35000
  const sourceBuf = createRandomBuffer()
  const simSource = new MockFileHandle(sourceBuf)
  const simTarget = new MockFileHandle(Buffer.allocUnsafeSlow(65536))

  const crypto = createPZCrypto('12345678')
  await crypto.encryptFile(simSource as any, simTarget as any, {
    position: 0,
    offset: 0,
    size: simSource.size,
    blockSize: bsz,
  })

  const blockCount = Math.floor(simSource.size / bsz)
  const endPart = simSource.size % bsz
  const encryptBlockSize = 16 - (bsz % 16) + bsz
  const endPartSize = 16 - (endPart % 16) + endPart
  const expectationSize = blockCount * (encryptBlockSize + 16) + endPartSize + 16

  assert(
    expectationSize === simTarget.size,
    `Encrypt file size check failed:
      source size: ${simSource.size}
      expectation size: ${expectationSize}
      encrypted size: ${simTarget.size}`,
  )

  const simDecryptFile = new MockFileHandle(Buffer.allocUnsafeSlow(65536))
  await crypto.decryptFile(simTarget as any, simDecryptFile as any, {
    position: 0,
    offset: 0,
    size: simTarget.size,
    blockSize: bsz,
  })

  const isEquals = equalBuffer(sourceBuf, simDecryptFile.innerBuffer)
  assert(isEquals, `Crypto decrypt file check failed: decrypt file and source file is not equal`)

  console.log('testCryptoForFile complete')
}
const testDecipherReader = async () => {
  const bsz = 35000
  const sourceBuf = createRandomBuffer(558800)
  const simSource = new MockFileHandle(sourceBuf)
  const simTarget = new MockFileHandle(Buffer.allocUnsafeSlow(65536))

  const crypto = createPZCrypto('12345678')
  await crypto.encryptFile(simSource as any, simTarget as any, {
    position: 0,
    offset: 0,
    size: simSource.size,
    blockSize: bsz,
  })

  const fff = {
    name: 'aaa',
    fullname: 'bbb',
    ext: 'ccc',
    fid: 1,
    pid: 2,
    size: simTarget.size,
    offset: 0,
    originSize: simSource.size,
  }
  const reader = createPZDecipherReader(simTarget as any, crypto, { file: fff, blockSize: bsz })

  const testStart = 17909
  const testEnd = simSource.size

  const readBuffer = await reader.read(testStart, testEnd)
  const bbs: Buffer[] = []
  let s = testStart
  while (s < testEnd) {
    const readBufferB = await reader.readByBlock(s, testEnd)
    bbs.push(readBufferB)
    s+=readBufferB.length
  }
  const z = Buffer.concat(bbs)
  console.log('z length = ' + z.length)

  const sliceBuffer = sourceBuf.slice(testStart, testEnd)

  const isEqual = equalBuffer(readBuffer, sliceBuffer)
  const isEqualB = equalBuffer(z, sliceBuffer)
  assert(isEqual, `Crypto DecipherReader check failed: readed buffer and source buffer is not equal`)
  assert(isEqualB, `Crypto DecipherReader check failed: readed buffer by block and source buffer is not equal`)

  console.log('testDecipherReader complete')
}

testEncrypt()
testDecrypt()
Promise.all([testCryptoForFile(), testDecipherReader()])
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(0)
  })
