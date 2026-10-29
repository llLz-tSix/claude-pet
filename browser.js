/**
 * Связь со вкладками claude.ai: расширение из папки extension раз в секунду присылает сюда состояние
 * вкладки (идёт ли ответ), а в ответ может получить команду «покажи эту вкладку».
 */
const http = require('node:http')
const DoneTracker = require('./done')

const RANK = { idle: 0, done: 1, thinking: 2, waiting: 3 }
// Видимая вкладка шлёт пульс раз в секунду. Скрытую браузер душит таймерами (до раза в минуту), поэтому ей
// даём больше времени, иначе длинный ответ в фоновой вкладке «оборвётся» у питомца на полуслове.
const TTL_VISIBLE = 10000
const TTL_HIDDEN = 75000

class BrowserLink {
  constructor() {
    this.tabs = new Map()
    this.lastChatUrl = ''
    this.tracker = new DoneTracker()
    this.pending = null
  }

  /** @returns {{tabId: number, windowId: number}|null} команда расширению (показать вкладку) */
  update(report, now = Date.now()) {
    const id = Number(report?.tabId)
    const state = report?.state
    if (!Number.isFinite(id)) return null
    if (state === 'closed') {                       // вкладку закрыли — не ждём таймаута
      this.tabs.delete(id)
      if (this.pending?.tabId === id) this.pending = null
      return null
    }
    if (!['idle', 'thinking', 'waiting'].includes(state)) return null
    const url = String(report.url ?? '').slice(0, 300)
    this.tabs.set(id, { state, ts: now, url, visible: report.visible === true, windowId: report.windowId })
    if (/^https:\/\/claude\.ai\/chat\//.test(url)) this.lastChatUrl = url.split('#')[0]
    const p = this.pending
    if (p !== null && !p.delivered && p.tabId === id) { p.delivered = true; return { tabId: id, windowId: p.windowId } }
    return null
  }

  prune(now) { for (const [id, tab] of this.tabs) if (now - tab.ts > (tab.visible ? TTL_VISIBLE : TTL_HIDDEN)) this.tabs.delete(id) }
  linked(now = Date.now()) { this.prune(now); return this.tabs.size > 0 }

  read(now = Date.now()) {
    this.prune(now)
    if (this.tabs.size === 0) { this.tracker.reset(); return null }
    let current = 'idle'
    for (const tab of this.tabs.values()) if (RANK[tab.state] > RANK[current]) current = tab.state
    return { state: this.tracker.feed(current, now), mark: current === 'waiting' ? 'approval' : null }
  }

  /** Выбрать вкладку для показа: сначала та, где идёт работа или которую ты видел последней. */
  requestFocus(now = Date.now()) {
    this.prune(now)
    let best = null
    for (const [id, tab] of this.tabs) {
      if (!/^https:\/\/claude\.ai\//.test(tab.url)) continue
      const score = (tab.state !== 'idle' ? 2e12 : 0) + (tab.visible ? 1e12 : 0) + tab.ts
      if (best === null || score > best.score) best = { score, id, tab }
    }
    if (best === null) { this.pending = null; return false }
    this.pending = { tabId: best.id, windowId: best.tab.windowId, delivered: false }
    return true
  }
  focusDelivered() { return this.pending?.delivered === true }
}

/**
 * Слушает только 127.0.0.1. Заголовок X-Claude-Pet не пропустит запросы с обычных сайтов (нужна CORS-проверка).
 * /state — расширение браузера, /hook — хуки Claude Code. onReport вызывается после каждого сообщения:
 * питомец реагирует сразу, а не на следующем опросе.
 */
function createServer({ browser, hooks }, port, log = () => {}, onReport = () => {}) {
  const server = http.createServer((request, response) => {
    const send = (code, body) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(body === undefined ? '' : JSON.stringify(body)) }
    const route = request.url.split('?')[0]
    const read = handle => {
      let body = ''
      request.on('data', chunk => { body += chunk; if (body.length > 5e6) request.destroy() })
      request.on('end', () => {
        let data
        try { data = JSON.parse(body) } catch { send(400, {}); return }
        handle(data)
        onReport()
      })
    }
    const ours = request.headers['x-claude-pet'] === '1'
    if (request.method === 'POST' && route === '/state' && ours) read(data => send(200, { focus: browser.update(data) }))
    // Хуку отвечаем пустым телом: Claude Code не должен принять ответ за решение (разрешить/запретить).
    else if (request.method === 'POST' && route === '/hook' && ours) read(data => { hooks.update(data); send(200) })
    else if (request.method === 'GET' && route === '/health') send(200, { ok: true })
    else send(404, {})
  })
  server.on('error', error => log(`сервер для расширения не запустился: ${error.message}`))
  server.listen(port, '127.0.0.1')
  return server
}

module.exports = { BrowserLink, createServer, RANK }
