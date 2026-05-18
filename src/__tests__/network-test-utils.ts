import net from 'node:net'

export function isListenPermissionError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'EPERM' || error.code === 'EACCES')
}

export async function probeLoopbackTcpListen(): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()

    const finish = (result: boolean) => {
      server.removeAllListeners('error')
      server.removeAllListeners('listening')
      resolve(result)
    }

    server.once('error', (error) => {
      if (isListenPermissionError(error)) {
        finish(false)
        return
      }
      reject(error)
    })

    server.once('listening', () => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        finish(true)
      })
    })

    server.listen(0, '127.0.0.1')
  })
}
