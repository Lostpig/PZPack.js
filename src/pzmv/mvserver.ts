import * as path from 'path'
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'http'
import { type PZLoader } from '../pzloader'
import { logger } from '../base/logger'

export class PZMVSimpleServer {
  private _loader: PZLoader
  private server?: Server
  private _port?: number
  get port() {
    if (typeof this._port !== 'number') this._port = this.randomPort()
    return this._port
  }
  get loader() {
    return this._loader
  }
  get running() {
    return this.server !== undefined
  }

  constructor(loader: PZLoader) {
    this._loader = loader
  }

  private randomPort() {
    return (Math.random() * 24000 + 36000) ^ 0
  }
  close() {
    if (this.server) {
      this.server.close()
      this.server = undefined
    }
  }
  start(port?: number, force?: boolean) {
    if (this.server) {
      if (!force) return
      this.close()
    }
    if (typeof port === 'number') this._port = port

    this.server = createServer((req, res) => {
      this.process(req, res)
    })
    this.server.listen(this.port, () => {
      logger.debug('PZMVServer start at port ' + this.port)
    })

    return this.port
  }
  getVideoFolders() {
    const idx = this.loader.loadIndex()
    const c = idx.getChildren(idx.root)
    return c.folders
  }

  private parsedFid(dir: string) {
    let fidStr
    if (dir.startsWith('/')) fidStr = dir.slice(1)
    else fidStr = dir

    if (!/^\d+$/.test(fidStr)) {
      return undefined
    }

    return parseInt(fidStr, 10)
  }
  private responseError(res: ServerResponse, err?: string) {
    res.writeHead(
      500,
      this.createHead({
        'content-type': 'text/html; charset=utf-8',
      }),
    )
    res.end(err || 'Unknown Error')
  }
  private responseVideos(res: ServerResponse) {
    const videoFolders = this.getVideoFolders()
    const data = {
      videos: videoFolders.map((p) => ({
        name: p.name,
        path: `/${p.id}/play.mpd`,
      })),
    }

    res.writeHead(
      200,
      this.createHead({
        'content-type': 'application/json; charset=utf-8',
      }),
    )
    res.end(JSON.stringify(data))
  }
  private async responseFile(res: ServerResponse, folderId: number, filename: string) {
    const idx = this.loader.loadIndex()
    const file = idx.findFile(folderId, filename)
    if (!file) return this.responseError(res, 'Video segment file not found')
    res.writeHead(
      200,
      this.createHead({
        'content-type':
          filename === 'output.mpd' ? 'application/dash+xml; charset=utf-8' : 'application/octet-stream; charset=utf-8',
      }),
    )

    const reader = this.loader.fileReader(file)
    let notEnd = true
    while (notEnd) {
      const result = await reader.read(4096)
      res.write(result.data)
      notEnd = !result.end
    }

    res.end()
  }

  private createHead(headStatus: Record<string, string | number>) {
    return Object.assign(
      {
        server: 'pzmv-simple-server',
        'cache-control': 'max-age=3600',
        'access-control-allow-headers': 'Origin, X-Requested-With, Content-Type, Accept, Range',
        'access-control-allow-origin': '*',
      },
      headStatus,
    )
  }
  private async process(req: IncomingMessage, res: ServerResponse) {
    if (!req.url) return this.responseError(res)

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`)
    logger.debug('PZMVServer request: ' + parsedUrl.toString())

    const pathname = decodeURI(parsedUrl.pathname)
    if (pathname === 'videos' || pathname === '/videos') return this.responseVideos(res)

    const parsedPath = path.parse(pathname)
    const fid = this.parsedFid(parsedPath.dir)
    if (fid === undefined) return this.responseError(res, 'Path of video not found')

    const filename = parsedPath.base === 'play.mpd' ? 'output.mpd' : parsedPath.base
    await this.responseFile(res, fid, filename)
  }
}
