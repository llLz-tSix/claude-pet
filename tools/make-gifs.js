/**
 * Рисует сценки из tools/gif.html покадрово в PNG, затем tools/make-gifs.py собирает из них GIF для README.
 *   node_modules\electron\dist\electron.exe tools\make-gifs.js <папка для кадров>
 *   python tools\make-gifs.py <папка для кадров> docs
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const out = path.resolve(process.argv[process.argv.length - 1])
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadFile(path.join(__dirname, 'gif.html'))
  await win.webContents.executeJavaScript('window.ready')
  const names = await win.webContents.executeJavaScript('window.SCENE_NAMES')
  const jobs = [...names.map(name => [name, 'classic']), ['demo', 'skeleton'], ['done', 'skeleton']]
  for (const [name, skin] of jobs) {
    const frames = await win.webContents.executeJavaScript(`window.renderScene(${JSON.stringify(name)}, ${JSON.stringify(skin)})`)
    const dir = path.join(out, skin === 'classic' ? name : `${name}-${skin}`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    frames.forEach((url, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(4, '0')}.png`), Buffer.from(url.split(',')[1], 'base64')))
    console.log(`${path.basename(dir)}: ${frames.length}`)
  }
  app.exit(0)
})
