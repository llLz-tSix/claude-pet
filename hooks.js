/**
 * Сессии Claude Code (вкладка Code в приложении и терминал): хуки Claude Code шлют сюда каждое событие
 * (пользователь отправил сообщение, вызов инструмента, запрос разрешения, конец ответа). В отличие от
 * чтения окна, это видит все сессии сразу, даже те, что сейчас не на экране.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const DoneTracker = require('./done')

const RANK = { idle: 0, done: 1, thinking: 2, waiting: 3 }
// Долгая команда может молчать минутами, но если событий нет 20 минут — сессию, скорее всего, прервали.
const STALE_THINKING = 20 * 60000
const STALE_WAITING = 60 * 60000
const ASKING_TOOLS = { AskUserQuestion: 'question', ExitPlanMode: 'plan-review' }

class HookLink {
  constructor() {
    this.sessions = new Map()
    this.lastEventAt = 0
    // Хуки точны: конец ответа приходит событием Stop, «дребезг» гасить не нужно.
    this.tracker = new DoneTracker(20000, 0)
  }

  /** Одно событие хука. @returns {boolean} изменилось ли что-то */
  update(event, now = Date.now()) {
    const id = String(event?.session_id ?? '')
    const name = String(event?.hook_event_name ?? '')
    if (id === '' || name === '') return false
    this.lastEventAt = now
    if (name === 'SessionEnd') return this.sessions.delete(id)
    const prev = this.sessions.get(id)
    let state = prev?.state ?? 'idle', mark = prev?.mark ?? null
    switch (name) {
      case 'UserPromptSubmit': case 'PostToolUse': case 'PostToolUseFailure': case 'PermissionDenied':
      case 'SubagentStart': case 'PreCompact':
        state = 'thinking'; mark = null; break
      case 'PreToolUse': {
        const asking = ASKING_TOOLS[event.tool_name]
        state = asking ? 'waiting' : 'thinking'; mark = asking ?? null; break
      }
      case 'PermissionRequest': state = 'waiting'; mark = 'approval'; break
      case 'Notification': {
        const type = String(event.notification_type ?? '')
        if (type === 'permission_prompt') { state = 'waiting'; mark = 'approval' }
        else if (type === 'elicitation_dialog') { state = 'waiting'; mark = 'question' }
        else return false                    // idle_prompt и прочие: ничего не меняют
        break
      }
      case 'Stop': case 'StopFailure': state = 'idle'; mark = null; break
      default: return false
    }
    this.sessions.set(id, { state, mark, ts: now, cwd: String(event.cwd ?? '') })
    return prev?.state !== state || prev?.mark !== mark
  }

  prune(now) {
    for (const [id, s] of this.sessions) {
      const limit = s.state === 'thinking' ? STALE_THINKING : s.state === 'waiting' ? STALE_WAITING : Infinity
      if (now - s.ts > limit) this.sessions.set(id, { ...s, state: 'idle', mark: null })
    }
  }

  /** Хоть одна сессия сейчас работает или ждёт. */
  busy(now = Date.now()) {
    this.prune(now)
    for (const s of this.sessions.values()) if (s.state !== 'idle') return true
    return false
  }

  read(now = Date.now()) {
    this.prune(now)
    if (this.sessions.size === 0 && now - this.lastEventAt > 60000) { this.tracker.reset(); return null }
    let best = { state: 'idle', mark: null }
    for (const s of this.sessions.values()) if (RANK[s.state] > RANK[best.state]) best = s
    return { state: this.tracker.feed(best.state, now), mark: best.state === 'waiting' ? best.mark : null }
  }
}

// ── установка хуков в ~/.claude/settings.json ────────────────────────────────
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const HOME = path.join(os.homedir(), '.claude-pet')
const WINDOWS = process.platform === 'win32'
const ENSURE = path.join(HOME, WINDOWS ? 'ensure-pet.ps1' : 'ensure-pet.sh')
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'PermissionDenied', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'PreCompact', 'SessionEnd']
const MARK = 'claude-pet'

const isOurs = hook => hook?.url?.includes('/hook?from=' + MARK) || /ensure-pet\.(ps1|sh)/.test(hook?.command ?? '')

/** Скрипт для SessionStart: запускает питомца, если он ещё не отвечает на /health. */
function writeEnsureScript() {
  if (WINDOWS) {
    fs.writeFileSync(ENSURE, [
      '# Starts Claude pet if it is not running (called by the Claude Code SessionStart hook).',
      "$loc = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'location.json') | ConvertFrom-Json",
      'try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 ("http://127.0.0.1:" + $loc.port + "/health") | Out-Null; exit 0 } catch { }',
      "if (Test-Path $loc.exe) { Start-Process -FilePath $loc.exe -ArgumentList @(('\"' + $loc.appDir + '\"'), '--background') }",
    ].join('\r\n'), 'utf8')
    return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${ENSURE.replace(/\\/g, '/')}"`
  }
  const q = text => `'${String(text).replace(/'/g, `'\\''`)}'`
  const { exe, appDir, port } = JSON.parse(fs.readFileSync(path.join(HOME, 'location.json'), 'utf8'))
  fs.writeFileSync(ENSURE, [
    '#!/bin/sh',
    '# Starts Claude pet if it is not running (called by the Claude Code SessionStart hook).',
    `curl -s -m 1 http://127.0.0.1:${port}/health >/dev/null 2>&1 && exit 0`,
    `nohup ${q(exe)} ${appDir ? q(appDir) : ''} --background >/dev/null 2>&1 &`,
  ].join('\n'), { encoding: 'utf8', mode: 0o755 })
  return `sh "${ENSURE}"`
}

/**
 * Добавляет хуки питомца (и убирает старые его же), чужие хуки не трогает.
 * SessionStart поддерживает только команды: он запускает питомца, если тот не запущен.
 * @returns {string} что сделано — для журнала
 */
function installHooks(port, { exe, appDir }) {
  fs.mkdirSync(HOME, { recursive: true })
  // Пути к питомцу (с кириллицей и пробелами) лежат в файле, а не в команде хука: так их не исказит ни одна оболочка.
  fs.writeFileSync(path.join(HOME, 'location.json'), JSON.stringify({ exe, appDir, port }), 'utf8')
  const ensureCommand = writeEnsureScript()

  let settings = {}
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') return `settings.json не прочитан (${error.message}) — хуки не трогаю`
  }
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  const before = JSON.stringify(hooks)
  for (const name of Object.keys(hooks)) {                       // убрать наши старые записи
    if (!Array.isArray(hooks[name])) continue
    hooks[name] = hooks[name]
      .map(group => ({ ...group, hooks: (group.hooks ?? []).filter(h => !isOurs(h)) }))
      .filter(group => group.hooks.length > 0)
    if (hooks[name].length === 0) delete hooks[name]
  }
  const add = (name, hook) => { (hooks[name] ??= []).push({ hooks: [hook] }) }
  for (const name of EVENTS) {
    add(name, { type: 'http', url: `http://127.0.0.1:${port}/hook?from=${MARK}`, timeout: 2, headers: { 'X-Claude-Pet': '1' } })
  }
  add('SessionStart', { type: 'command', async: true, timeout: 15, command: ensureCommand })
  if (JSON.stringify(hooks) === before) return 'хуки Claude Code на месте'
  settings.hooks = hooks
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true })
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2))
  return 'хуки Claude Code установлены'
}

function removeHooks() {
  let settings
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) } catch { return }
  const hooks = settings.hooks ?? {}
  for (const name of Object.keys(hooks)) {
    if (!Array.isArray(hooks[name])) continue
    hooks[name] = hooks[name].map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length > 0)
    if (hooks[name].length === 0) delete hooks[name]
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2))
}

module.exports = { HookLink, installHooks, removeHooks }
