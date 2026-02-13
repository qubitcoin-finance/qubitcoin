/**
 * Structured logger for qbtcd — powered by pino
 *
 * Usage:
 *   import { log } from './log.js'
 *   log.info({ component: 'p2p' }, 'Listening on port 6001')
 *
 * Pipe to pino-pretty for human-readable dev output:
 *   node --loader ts-node/esm src/qbtcd.ts | pnpm pino-pretty
 */
import pino from 'pino'

const transport = process.stdout.isTTY
  ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
  : undefined

export const log = pino(
  { name: 'qbtcd', level: process.env.LOG_LEVEL || 'info' },
  transport,
)
