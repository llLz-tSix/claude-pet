/**
 * Claude pet — плавающий питомец на рабочем столе (Electron).
 * Живёт в фоне (значок возле часов): сам появляется, когда открыт Claude, и прячется, когда его закрыли.
 * Видит работу чата тремя путями: хуки Claude Code (все сессии вкладки Code и терминала), окно приложения Claude
 * (Windows UI Automation — обычный чат) и вкладки claude.ai (расширение из папки extension).
 * Перетаскивается мышью, клик возвращает в чат.
 */
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, shell, Notification } = require('electron')
const { BrowserLink, createServer, RANK } = require('./browser')
const { UiaWatcher } = require('./uia')
const { HookLink, installHooks, removeHooks } = require('./hooks')

// Прозрачное окно на Windows надёжно рисуется только программным композитингом.
app.disableHardwareAcceleration()
// Питомцу не нужны отдельные процессы графики и сети (рисует программно, грузит только свои файлы) — минус два процесса.
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2')
// Второй экземпляр сразу завершается (первому он лишь сообщает о себе через second-instance).
if (!app.requestSingleInstanceLock()) app.exit(0)
app.setAppUserModelId('Claude pet')     // имя в уведомлениях Windows вместо «electron.app.Electron»

const arg = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
// Автозапуск с Windows: ждать, пока откроют Claude, а не показываться сразу.
const BACKGROUND = process.argv.includes('--background')
const MARGIN = 24
const CLICK_SLOP = 6
const MAX_CURSOR_STEP = 300
const POLL_MS = 400
const HIDE_AFTER_MS = 4000      // Claude закрыли — питомец уходит не сразу (перезапуск окна не должен мигать)

// ── настройки ────────────────────────────────────────────────────────────────
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json')
let config = {
  appProcess: 'Claude', appId: '', fallbackUrl: 'https://claude.ai/recents', port: 47800, lastChatUrl: '', lastSource: '',
  autostart: true, followClaude: true, hooks: true, anyDisplay: false, notify: true, size: 0.8, skin: 'classic', stopWords: '', allowWords: '',
}
function loadConfig() {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')) } } catch { /* первый запуск */ }
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2)) } catch { /* не критично */ }
}

// Холст 29×30 клеток по 3 пикселя (см. pet.html): сверху место для поднятых рук, галочки и значков.
let WIDTH = 87, HEIGHT = 90
function applyScale() {
  const scale = Math.max(0.4, Number(arg('scale', config.size)) || 0.8)
  WIDTH = Math.round(87 * scale); HEIGHT = Math.round(90 * scale)
}

let win
let ready = false
const browser = new BrowserLink()
const uia = new UiaWatcher()
const hooks = new HookLink()

// ── журнал ───────────────────────────────────────────────────────────────────
const logFile = () => path.join(app.getPath('userData'), 'pet.log')
function log(line) {
  try {
    const file = logFile()
    if (fs.existsSync(file) && fs.statSync(file).size > 200000) fs.writeFileSync(file, '')
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch { /* журнал не критичен */ }
}

app.on('before-quit', () => log('выход'))
process.on('uncaughtException', error => log(`ошибка: ${error?.stack ?? error}`))
process.on('unhandledRejection', error => log(`ошибка (promise): ${error?.stack ?? error}`))

// ── клик: вернуться в чат ────────────────────────────────────────────────────
/** Ничего не нашли — открываем последний чат (или список чатов) в браузере по умолчанию. */
function openLastChat() {
  const url = browser.lastChatUrl || config.lastChatUrl || config.fallbackUrl
  log(`открываю ${url}`)
  void shell.openExternal(url)
}

/**
 * Выносит окно приложения Claude вперёд. Если окна нет (приложение свёрнуто в трей или закрыто), запускает его:
 * повторный запуск лишь показывает уже открытое окно. onNone — приложение найти и запустить не удалось.
 */
function raiseDesktopApp(onNone) {
  if (process.platform === 'darwin') {
    spawn('open', ['-a', config.appProcess]).on('error', onNone)
    return
  }
  if (process.platform !== 'win32') { onNone(); return }
  // Право на передний план есть у процесса, которого только что кликнули, и оно передаётся
  // дочернему PowerShell — поэтому вызывать надо сразу по клику.
  const script = [
    "Add-Type @'",
    'using System; using System.Runtime.InteropServices;',
    'public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }',
    "'@",
    // Консольный claude.exe из Claude Code — не приложение: отсеиваем по пути.
    `$all = @(Get-Process -Name '${config.appProcess}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike '*\\.local\\*' -and $_.Path -notlike '*\\.claude\\*' -and $_.Path -notlike '*\\claude-code\\*' })`,
    '$w = $all | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    'if ($w) { if ([W]::IsIconic($w.MainWindowHandle)) { [void][W]::ShowWindow($w.MainWindowHandle, 9) }; [void][W]::SetForegroundWindow($w.MainWindowHandle); Write-Output "ok"; exit 0 }',
    // Окна нет: приложение в трее или закрыто. Запускаем его — это не открывает браузер.
    "$app = Get-StartApps | Where-Object { $_.Name -like 'Claude*' -and $_.AppID -like '*!*' } | Select-Object -First 1",
    "if ($app) { Start-Process 'explorer.exe' ('shell:AppsFolder\\' + $app.AppID); Write-Output ('ok app=' + $app.AppID); exit 0 }",
    '$exe = @($all | Where-Object { $_.Path } | ForEach-Object { $_.Path }) + @("$env:LOCALAPPDATA\\AnthropicClaude\\claude.exe", "$env:LOCALAPPDATA\\Programs\\Claude\\Claude.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1',
    "if ($exe) { Start-Process $exe; Write-Output 'ok'; exit 0 }",
    "Write-Output 'none'",
  ].join('\n')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.on('close', () => {
    const id = /app=(\S+)/.exec(out)?.[1]
    if (id && id !== config.appId) { config.appId = id; saveConfig() }
    if (!out.includes('ok')) onNone()
  })
  child.on('error', onNone)
}

/** Где Claude работал в последний раз ('app' | 'browser'); от этого зависит, куда вести по клику. */
let lastSource = null

/** Куда вести: туда, где Claude работал последним; если такого нет — к тому, что сейчас видно. */
function chooseTarget() {
  const inBrowser = browser.linked()
  if (lastSource === 'app') return 'app'
  if (lastSource === 'browser' && inBrowser) return 'browser'
  if (uia.seen) return 'app'
  return inBrowser ? 'browser' : 'app'
}

let openedAt = 0
function openClaude() {
  const now = Date.now()
  if (now - openedAt < 1500) return            // частые клики не должны запускать по окну на каждый
  openedAt = now
  const viaBrowser = () => {
    if (!browser.linked() || !browser.requestFocus()) return false
    log('показываю вкладку claude.ai')
    return true
  }
  const target = chooseTarget()
  log(`клик: веду в ${target === 'app' ? 'приложение' : 'браузер'} (последний раз работал: ${lastSource ?? 'не известно'})`)
  if (target === 'browser' && viaBrowser()) return
  // Браузер открываем только если приложение найти и запустить не удалось.
  raiseDesktopApp(() => { log('приложение не найдено'); if (!viaBrowser()) openLastChat() })
}

// ── позиция: питомца нельзя потерять ─────────────────────────────────────────
const cornerOf = display => {
  const a = display.workArea
  return { x: a.x + a.width - WIDTH - MARGIN, y: a.y + a.height - HEIGHT - MARGIN }
}
const fullyInside = (x, y, a) => x >= a.x && y >= a.y && x + WIDTH <= a.x + a.width && y + HEIGHT <= a.y + a.height

/** Где питомец может стоять: основной экран; при anyDisplay: true — любой. Остальные экраны бывают «виртуальными». */
const allowedAreas = () => (config.anyDisplay ? screen.getAllDisplays() : [screen.getPrimaryDisplay()]).map(d => d.workArea)

function startPosition() {
  if (Number.isFinite(config.x) && Number.isFinite(config.y)) {
    if (allowedAreas().some(a => fullyInside(config.x, config.y, a))) return { x: config.x, y: config.y }
    log(`сохранённая позиция ${config.x},${config.y} вне экрана — возвращаю питомца в угол`)
  }
  return cornerOf(screen.getPrimaryDisplay())
}

/** Вернуть питомца на экран и показать. toCorner — принудительно в правый нижний угол основного экрана. */
function bringBack(toCorner) {
  if (win === undefined || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  if (toCorner || !allowedAreas().some(a => fullyInside(x, y, a))) {
    const corner = cornerOf(screen.getPrimaryDisplay())
    win.setPosition(corner.x, corner.y)
    config.x = corner.x; config.y = corner.y; saveConfig()
    log(`питомец возвращён в угол: ${corner.x},${corner.y}`)
  }
  hiddenByUser = false
  pinnedUntil = Date.now() + 15000             // позвали вручную — не прятать сразу, даже если Claude закрыт
  setVisible(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.webContents.send('pet:flash')
}

// ── видимость: питомец рядом, пока открыт Claude ─────────────────────────────
let hiddenByUser = false, pinnedUntil = 0, absentSince = 0, wasPresent = false
function setVisible(on) {
  if (!ready || win === undefined || win.isDestroyed() || win.isVisible() === on) return
  if (on) {
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.webContents.send('pet:appear')
  } else {
    endDrag()
    win.hide()
  }
  log(on ? 'показываю питомца' : 'прячу питомца')
}

/** Claude где-то открыт: окно приложения, вкладка claude.ai или идёт сессия Claude Code (в том числе в терминале). */
const claudePresent = now => uia.seen || browser.linked(now) || hooks.busy(now)

function updateVisibility(now) {
  const present = claudePresent(now)
  if (present && !wasPresent) hiddenByUser = false              // Claude открыли заново — питомец возвращается
  wasPresent = present
  if (present) absentSince = 0
  else if (absentSince === 0) absentSince = now
  const follow = config.followClaude !== false
  const show = !hiddenByUser && (!follow || present || now < pinnedUntil || now - absentSince < HIDE_AFTER_MS)
  setVisible(show)
}

// ── перетаскивание: курсор опрашивается здесь, а не в странице ───────────────
let dragTimer = null
let dragOrigin = null
let lastCursor = null

function beginDrag() {
  if (win === undefined || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  dragOrigin = { x, y }
  lastCursor = screen.getCursorScreenPoint()
  if (dragTimer === null) dragTimer = setInterval(followCursor, 16)
}

function followCursor() {
  if (dragOrigin === null || win === undefined || win.isDestroyed()) return
  const point = screen.getCursorScreenPoint()
  const dx = point.x - lastCursor.x
  const dy = point.y - lastCursor.y
  lastCursor = point
  if ((dx === 0 && dy === 0) || Math.abs(dx) > MAX_CURSOR_STEP || Math.abs(dy) > MAX_CURSOR_STEP) return
  const [x, y] = win.getPosition()
  // Питомец остаётся целиком на экране: за край его утащить нельзя.
  const a = (config.anyDisplay ? screen.getDisplayNearestPoint(point) : screen.getPrimaryDisplay()).workArea
  const nx = Math.min(Math.max(Math.round(x + dx), a.x), a.x + a.width - WIDTH)
  const ny = Math.min(Math.max(Math.round(y + dy), a.y), a.y + a.height - HEIGHT)
  win.setPosition(nx, ny)
  win.webContents.send('pet:swing', Math.sign(dx))       // несут вбок — ноги отстают
}

function endDrag() {
  if (dragTimer !== null) { clearInterval(dragTimer); dragTimer = null }
  const origin = dragOrigin
  dragOrigin = null
  lastCursor = null
  if (origin === null || win === undefined || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  if (Math.hypot(x - origin.x, y - origin.y) >= CLICK_SLOP) {
    win.webContents.send('pet:dropped')
    config.x = x; config.y = y; saveConfig()
    return
  }
  win.webContents.send('pet:flash')   // клик не должен быть «немым»
  openClaude()
}

// ── окно ─────────────────────────────────────────────────────────────────────
function createWindow() {
  const { x, y } = startPosition()
  win = new BrowserWindow({
    width: WIDTH, height: HEIGHT, x, y,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    skipTaskbar: true, minimizable: false, maximizable: false, fullscreenable: false,
    focusable: false,          // первый клик не должен тратиться на активацию окна
    show: false, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })   // на всех рабочих столах
  win.loadFile(path.join(__dirname, 'pet.html'))
  // Показывает окно updateVisibility: при ручном запуске — сразу, в фоне (автозапуск) — когда откроют Claude.
  const onReady = () => {
    if (ready) return
    ready = true
    if (!BACKGROUND) pinnedUntil = Date.now() + 15000
    updateVisibility(Date.now())
  }
  win.once('ready-to-show', onReady)
  setTimeout(() => { if (!ready) { log('ready-to-show не пришёл'); onReady() } }, 3000)
  win.on('closed', () => { win = undefined; endDrag() })

  const wc = win.webContents
  wc.on('render-process-gone', (_event, details) => {
    log(`страница упала: ${details?.reason} — перезагружаю`)
    lastKey = ''                                   // после перезагрузки заново прислать состояние
    setTimeout(() => { if (win && !win.isDestroyed()) win.reload() }, 1000)
  })
  wc.on('did-finish-load', () => { lastKey = ''; wc.send('pet:skin', config.skin) })
  wc.on('did-fail-load', (_event, _code, description) => log(`страница не загрузилась: ${description}`))
  wc.on('console-message', (...args) => {        // подпись события разная в версиях Electron
    const event = args[0]
    const level = typeof args[1] === 'number' ? args[1] : event?.level
    const message = typeof args[2] === 'string' ? args[2] : event?.message
    if (level === 'error' || level === 'warning' || level >= 2) log(`страница: ${message}`)
  })
  const displays = screen.getAllDisplays().map(d => `${d.id}${d.id === screen.getPrimaryDisplay().id ? '*' : ''}:${d.workArea.x},${d.workArea.y} ${d.workArea.width}x${d.workArea.height}`)
  log(`окно ${x},${y} ${WIDTH}x${HEIGHT}; экраны: ${displays.join(' | ')}`)
}

// ── меню ─────────────────────────────────────────────────────────────────────
/** Чем запускать питомца из хука SessionStart: тот же exe и та же папка, что сейчас. */
const hookLocation = () => ({ exe: process.execPath, appDir: app.isPackaged ? '' : app.getAppPath() })

function applyHooks() {
  try {
    if (config.hooks !== false) log(installHooks(Number(config.port) || 47800, hookLocation()))
    else { removeHooks(); log('хуки Claude Code убраны') }
  } catch (error) { log(`хуки: ${error.message}`) }
}

const SKINS = [['classic', 'Обычный'], ['skeleton', 'Скелет 🎃']]
function setSkin(id) {
  config.skin = id
  saveConfig()
  win?.webContents.send('pet:skin', id)
  win?.webContents.send('pet:flash')            // переоделся — радуется
}

// Меню — только самое нужное. Остальные настройки (уведомления, автозапуск, хуки, браузер) — в config.json.
function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Открыть Claude', click: openClaude },
    { label: 'Спрятать', click: () => { hiddenByUser = true; pinnedUntil = 0; setVisible(false) } },
    { label: 'Скин', submenu: SKINS.map(([id, label]) => ({ label, type: 'radio', checked: config.skin === id, click: () => setSkin(id) })) },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() },
  ])
}

/**
 * Окно питомца не берёт фокус (иначе первый клик тратился бы на активацию). Но меню Windows закрывается кликом мимо,
 * только если его окно в фокусе — поэтому на время меню окно становится фокусируемым, а потом снова нет.
 */
function showMenu() {
  if (win === undefined || win.isDestroyed()) return
  win.setFocusable(true)
  win.focus()
  buildMenu().popup({
    window: win,
    callback: () => { if (win && !win.isDestroyed()) { win.setFocusable(false); win.blur() } },
  })
}

/** Значок возле часов: по нему питомца всегда можно найти и закрыть, даже если окно спрятано. */
let tray = null
function createTray() {
  try {
    let image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'))
    if (image.isEmpty()) throw new Error('assets/tray.png не загрузился')
    if (process.platform === 'darwin') image = image.resize({ width: 18, height: 18 })   // строка меню macOS ниже панели задач
    tray = new Tray(image)
    tray.setToolTip('Claude pet — клик: показать питомца, правый клик — меню')
    tray.on('click', () => bringBack(false))
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()))
  } catch (error) {
    log(`значок в трее не создан: ${error.message}`)
  }
}

/**
 * Автозапуск через реестр (HKCU\...\Run). Путь к папке питомца содержит пробелы («Рабочий стол»), поэтому
 * каждая часть команды в кавычках: setLoginItemSettings их не ставит, и Windows не мог запустить питомца.
 */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
function setAutostart(on) {
  if (process.platform === 'darwin') { setMacAutostart(on); return }
  if (process.platform !== 'win32') return
  const reg = args => new Promise(resolve => {
    const child = spawn('reg.exe', args, { windowsHide: true })
    child.on('close', resolve)
    child.on('error', resolve)
  })
  const command = [process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()])].map(part => `"${part}"`).concat('--background').join(' ')
  void (async () => {
    await reg(['delete', RUN_KEY, '/v', 'electron.app.Electron', '/f'])       // старая запись без кавычек
    await reg(on ? ['add', RUN_KEY, '/v', 'Claude pet', '/t', 'REG_SZ', '/d', command, '/f'] : ['delete', RUN_KEY, '/v', 'Claude pet', '/f'])
    log(`автозапуск ${on ? 'включён' : 'выключен'}`)
  })()
}

/**
 * macOS: LaunchAgent в ~/Library/LaunchAgents. setLoginItemSettings здесь не годится: без сборки .app он запустил бы
 * голый Electron без папки питомца.
 */
function setMacAutostart(on) {
  const file = path.join(app.getPath('home'), 'Library', 'LaunchAgents', 'com.claude-pet.plist')
  const esc = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const args = [process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()]), '--background']
  try {
    if (!on) { fs.rmSync(file, { force: true }); log('автозапуск выключен'); return }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '  <key>Label</key><string>com.claude-pet</string>',
      `  <key>ProgramArguments</key><array>${args.map(a => `<string>${esc(a)}</string>`).join('')}</array>`,
      '  <key>RunAtLoad</key><true/>',
      '</dict></plist>',
    ].join('\n'))
    log('автозапуск включён')
  } catch (error) { log(`автозапуск: ${error.message}`) }
}

// Глаза питомца следят за курсором: в окно уходит только направление (-1, 0, 1), и только когда оно меняется.
let lastLook = ''
function sendLook() {
  if (win === undefined || win.isDestroyed() || !win.isVisible()) return
  const point = screen.getCursorScreenPoint(), b = win.getBounds()
  const vx = point.x - (b.x + b.width / 2), vy = point.y - (b.y + b.height / 2)
  const dir = { x: Math.abs(vx) < 40 ? 0 : Math.sign(vx), y: Math.abs(vy) < 30 ? 0 : Math.sign(vy) }
  const key = `${dir.x},${dir.y}`
  if (key === lastLook) return
  lastLook = key
  win.webContents.send('pet:look', dir)
}

ipcMain.on('pet:drag-start', beginDrag)
ipcMain.on('pet:drag-end', endDrag)
ipcMain.on('pet:menu', showMenu)

// ── состояние: что делает чат ────────────────────────────────────────────────
let lastKey = ''
const links = { browser: null, app: null, code: null }
const LINK_NAMES = { browser: 'браузер', app: 'окно приложения', code: 'Claude Code' }

// Уведомление Windows: ради этого питомец и нужен — не сидеть и не смотреть на чат.
let workSince = 0, lastNote = 0
function notify(state, now) {
  if (state === 'thinking') { if (workSince === 0) workSince = now; return }
  const worked = workSince === 0 ? 0 : now - workSince
  if (state === 'waiting') { if (workSince === 0) workSince = now }          // ждёт тебя — считаем работу продолжающейся
  else workSince = 0
  if (!config.notify || !Notification.isSupported() || now - lastNote < 5000) return
  const text = state === 'waiting' ? 'Claude ждёт твоего ответа или разрешения' : (state === 'done' && worked >= 8000 ? 'Claude закончил' : '')
  if (text === '') return
  lastNote = now
  try {
    const note = new Notification({ title: 'Claude pet', body: text, silent: false })
    note.on('click', openClaude)
    note.show()
  } catch (error) { log(`уведомление не показано: ${error.message}`) }
}

function poll() {
  const now = Date.now()
  const seen = { browser: browser.read(now), app: uia.read(now), code: hooks.read(now) }
  for (const name of Object.keys(links)) {
    const on = seen[name] !== null
    if (links[name] !== on) { links[name] = on; log(`${LINK_NAMES[name]}: ${on ? 'вижу' : 'нет связи'}`) }
  }
  for (const [name, result] of [['browser', seen.browser], ['app', seen.app], ['app', seen.code]]) {
    if (result !== null && result.state !== 'idle' && result.state !== 'done' && lastSource !== name) {
      lastSource = name
      config.lastSource = name
      saveConfig()
    }
  }
  if (browser.lastChatUrl && browser.lastChatUrl !== config.lastChatUrl) { config.lastChatUrl = browser.lastChatUrl; saveConfig() }
  updateVisibility(now)

  // Побеждает самое «громкое»; при равенстве — хуки: они знают, чего именно ждёт Claude (разрешение, вопрос, план).
  let best = { state: 'idle', mark: null }
  for (const result of [seen.code, seen.app, seen.browser]) if (result !== null && RANK[result.state] > RANK[best.state]) best = result
  const key = `${best.state}|${best.mark ?? ''}`
  if (key === lastKey || win === undefined || win.isDestroyed()) return
  lastKey = key
  log(`${best.state} ${best.mark ?? '-'}`)
  notify(best.state, now)
  win.webContents.send('pet:state', { state: best.state, mark: best.mark })
}

// Повторный запуск (ярлык, .bat) — способ вернуть спрятанного питомца; запуск из хука (--background) молчит.
app.on('second-instance', (_event, argv) => { if (app.isReady() && !argv.includes('--background')) bringBack(false) })
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => uia.stop())
app.whenReady().then(() => {
  app.dock?.hide()                                      // macOS: питомец — не приложение в доке, а значок в строке меню
  loadConfig()
  applyScale()
  lastSource = config.lastSource || null
  uia.extraStop = String(config.stopWords || ''); uia.extraAllow = String(config.allowWords || '')
  createWindow()
  createTray()
  if (!config.welcomed && tray && process.platform === 'win32') {      // при первом запуске подсказать, где значок
    tray.displayBalloon({ title: 'Claude pet', content: 'Питомец появляется, когда открыт Claude. Клик по значку возле часов — показать его, правый клик — меню.', iconType: 'info' })
    config.welcomed = true; saveConfig()
  }
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, () => { if (win?.isVisible()) bringBack(false) })
  }
  const port = Number(config.port) || 47800
  createServer({ browser, hooks }, port, log, poll)
  void uia.start(app.getPath('userData'), log)
  setAutostart(config.autostart !== false)              // заодно заменяет старую запись без кавычек
  applyHooks()
  log(`запуск${BACKGROUND ? ' (в фоне, жду Claude)' : ''}`)
  setInterval(poll, POLL_MS)
  setInterval(sendLook, 120)
})
