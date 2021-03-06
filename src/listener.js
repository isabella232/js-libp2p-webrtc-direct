'use strict'

const http = require('http')
const EventEmitter = require('events')
const log = require('debug')('libp2p:webrtcdirect:listener')

const isNode = require('detect-node')
const wrtc = require('wrtc')
const SimplePeer = require('simple-peer')

const multibase = require('multibase')

const toConnection = require('./socket-to-conn')

module.exports = ({ handler, upgrader }, options = {}) => {
  const listener = new EventEmitter()
  const server = http.createServer()

  let maSelf

  // Keep track of open connections to destroy in case of timeout
  listener.__connections = []

  server.on('request', async (req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.setHeader('Access-Control-Allow-Origin', '*')

    const path = req.url
    const incSignalStr = path.split('?signal=')[1]
    const incSignalBuf = multibase.decode(Buffer.from(incSignalStr))
    const incSignal = JSON.parse(incSignalBuf.toString())

    options = {
      trickle: false,
      wrtc: isNode ? wrtc : undefined,
      ...options
    }

    const channel = new SimplePeer(options)
    const maConn = toConnection(channel, listener.__connections)
    log('new inbound connection %s', maConn.remoteAddr)

    const conn = await upgrader.upgradeInbound(maConn)
    log('inbound connection %s upgraded', maConn.remoteAddr)

    trackConn(listener, maConn)

    channel.on('connect', () => {
      listener.emit('connection', conn)
      handler(conn)
    })

    channel.on('signal', (signal) => {
      const signalStr = JSON.stringify(signal)
      const signalEncoded = multibase.encode('base58btc', Buffer.from(signalStr))
      res.end(signalEncoded.toString())
    })

    channel.signal(incSignal)
  })

  server.on('error', (err) => listener.emit('error', err))
  server.on('close', () => listener.emit('close'))

  listener.listen = (ma) => {
    maSelf = ma
    const lOpts = ma.toOptions()

    return new Promise((resolve, reject) => {
      server.on('listening', (err) => {
        if (err) {
          return reject(err)
        }

        listener.emit('listening')
        log('Listening on %s %s', lOpts.port, lOpts.host)
        resolve()
      })

      server.listen(lOpts)
    })
  }

  listener.close = () => {
    if (!server.listening) {
      return
    }

    return new Promise((resolve, reject) => {
      listener.__connections.forEach(maConn => maConn.close())
      server.close((err) => err ? reject(err) : resolve())
    })
  }

  listener.getAddrs = () => {
    return [maSelf]
  }

  return listener
}

function trackConn (listener, maConn) {
  listener.__connections.push(maConn)

  const untrackConn = () => {
    listener.__connections = listener.__connections.filter(c => c !== maConn)
  }

  maConn.conn.once('close', untrackConn)
}
