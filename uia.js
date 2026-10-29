/**
 * Работа приложения Claude Desktop — без флагов и настроек. Windows: фоновый помощник читает окно Claude через
 * Windows UI Automation и печатает: thinking | waiting | idle | none. Помощник — tools/uia-watch.cs, его один раз
 * собирает csc.exe, который есть в каждой Windows; если сборка не удалась — тот же код на PowerShell
 * (tools/uia-watch.ps1), он заметно тяжелее.
 * macOS: только «приложение запущено / нет» (см. watchMac).
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')
const DoneTracker = require('./done')

const TOOLS = path.join(__dirname, 'tools')
const psArgs = script => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
const extraArgs = ({ extraStop, extraAllow }) => [
  ...(extraStop ? ['-ExtraStop', extraStop] : []), ...(extraAllow ? ['-ExtraAllow', extraAllow] : [])]

/** Собирает помощника в dir, если его нет или исходник новее. @returns {Promise<string|null>} путь к exe */
function buildHelper(dir, log) {
  const source = path.join(TOOLS, 'uia-watch.cs')
  const exe = path.join(dir, 'uia-watch.exe')
  try {
    if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= fs.statSync(source).mtimeMs) return Promise.resolve(exe)
  } catch { return Promise.resolve(null) }
  const framework = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  const csc = path.join(framework, 'csc.exe')
  if (!fs.existsSync(csc)) return Promise.resolve(null)
  const args = ['-nologo', '-codepage:65001', '-optimize', '-target:exe', `-out:${exe}`, `-lib:${path.join(framework, 'WPF')}`,
    '-r:UIAutomationClient.dll', '-r:UIAutomationTypes.dll', '-r:WindowsBase.dll', source]
  return new Promise(resolve => execFile(csc, args, { windowsHide: true, timeout: 60000 }, (error, stdout) => {
    if (error) { log(`помощник для окна Claude не собран, работаю через PowerShell: ${String(stdout || error.message).trim().slice(0, 300)}`); resolve(null) }
    else { log('помощник для окна Claude собран'); resolve(exe) }
  }))
}

class UiaWatcher {
  constructor({ spawnFn = spawn, platform = process.platform, extraStop = '', extraAllow = '' } = {}) {
    Object.assign(this, { spawnFn, platform, extraStop, extraAllow })
    this.raw = 'none'
    this.tracker = new DoneTracker()
    this.child = null
    this.helper = undefined          // undefined — ещё не собирали, null — нет, работаем через PowerShell
    this.stopped = false
  }

  /** dir — куда положить собранного помощника (папка данных питомца). */
  async start(dir, log = () => {}) {
    if (this.platform === 'darwin') { this.watchMac(); return }
    if (this.platform !== 'win32' || this.child !== null || this.stopped) return
    if (this.helper === undefined) this.helper = dir ? await buildHelper(dir, log) : null
    const child = this.helper
      ? this.spawnFn(this.helper, extraArgs(this), { windowsHide: true })
      : this.spawnFn('powershell.exe', [...psArgs(path.join(TOOLS, 'uia-watch.ps1')), ...extraArgs(this)], { windowsHide: true })
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
      if (!this.stopped) setTimeout(() => this.start(dir, log), 5000)
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

module.exports = { UiaWatcher }
