/**
 * Работа приложения Claude Desktop — без флагов и настроек. Windows: фоновый PowerShell (tools/uia-watch.ps1)
 * читает окно Claude через Windows UI Automation и печатает: thinking | waiting | idle | none.
 * macOS: только «приложение запущено / нет» (см. watchMac).
 */
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')
const DoneTracker = require('./done')

const psArgs = script => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
const extraArgs = ({ extraStop, extraAllow }) => [
  ...(extraStop ? ['-ExtraStop', extraStop] : []), ...(extraAllow ? ['-ExtraAllow', extraAllow] : [])]

/** Имена всех кнопок окна Claude — чтобы понять, что видит питомец, если он перестал реагировать. */
function dumpButtons(script = path.join(__dirname, 'tools', 'uia-watch.ps1')) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve([])
    execFile('powershell.exe', [...psArgs(script), '-Dump'], { windowsHide: true, timeout: 20000, encoding: 'utf8' },
      (error, stdout) => resolve(error ? ['__error__ ' + error.message] : String(stdout).split(/\r?\n/).map(x => x.trim()).filter(Boolean)))
  })
}

class UiaWatcher {
  constructor({ spawnFn = spawn, script = path.join(__dirname, 'tools', 'uia-watch.ps1'), platform = process.platform, extraStop = '', extraAllow = '' } = {}) {
    Object.assign(this, { spawnFn, script, platform, extraStop, extraAllow })
    this.raw = 'none'
    this.tracker = new DoneTracker()
    this.child = null
    this.stopped = false
  }

  start() {
    if (this.platform === 'darwin') { this.watchMac(); return }
    if (this.platform !== 'win32' || this.child !== null) return
    const child = this.spawnFn('powershell.exe',
      [...psArgs(this.script), ...extraArgs(this)], { windowsHide: true })
    this.child = child
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n')) >= 0) { this.raw = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1) }
    })
    child.on('error', () => {})
    child.on('exit', () => {
      this.child = null
      this.raw = 'none'
      if (!this.stopped) setTimeout(() => this.start(), 5000)
    })
  }

  /**
   * macOS: читать окно, как на Windows, нельзя без особых разрешений, поэтому смотрим только, запущено ли приложение
   * Claude (для появления питомца). Что делает Claude, на Маке сообщают хуки Claude Code и расширение браузера.
   */
  watchMac() {
    if (this.timer) return
    const check = () => execFile('pgrep', ['-x', 'Claude'], (error, stdout) => {
      this.raw = !error && String(stdout).trim() !== '' ? 'idle' : 'none'
    })
    check()
    this.timer = setInterval(check, 1500)
  }

  stop() {
    this.stopped = true
    clearInterval(this.timer)
    try { this.child?.kill() } catch { /* уже завершён */ }
  }
  /** Окно приложения найдено. */
  get seen() { return this.raw !== 'none' && this.raw !== '' }

  read(now = Date.now()) {
    if (!this.seen) { this.tracker.reset(); return null }
    const current = this.raw === 'thinking' || this.raw === 'waiting' ? this.raw : 'idle'
    return { state: this.tracker.feed(current, now), mark: current === 'waiting' ? 'approval' : null }
  }
}

module.exports = { UiaWatcher, dumpButtons }
