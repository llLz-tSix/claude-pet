/**
 * Сохраняет раскадровку tools/preview.html в PNG — посмотреть все сценки питомца без запуска.
 *   node_modules\electron\dist\electron.exe tools\snapshot.js out.png
 */
const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow } = require('electron')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const out = path.resolve(process.argv[process.argv.length - 1].endsWith('.png') ? process.argv[process.argv.length - 1] : 'preview.png')
  const win = new BrowserWindow({ width: 1500, height: 1250, show: false, webPreferences: { offscreen: true } })
  await win.loadFile(path.join(__dirname, 'preview.html'), { query: { big: '1' } })
  await new Promise(resolve => setTimeout(resolve, 300))
  fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG())
  app.exit(0)
})
