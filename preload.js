const { contextBridge, ipcRenderer } = require('electron')

const on = channel => handler => {
  const listener = (_event, payload) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('petWindow', {
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  menu: () => ipcRenderer.send('pet:menu'),
  onState: on('pet:state'),
  onFlash: on('pet:flash'),
  onLook: on('pet:look'),
  onDropped: on('pet:dropped'),
  onAppear: on('pet:appear'),
  onSwing: on('pet:swing'),
})
