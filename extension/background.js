// Передаёт состояние вкладок питомцу; по его команде показывает нужную вкладку.
const PET = 'http://127.0.0.1:47800/state'

// Вкладку закрыли — сразу сообщаем питомцу, чтобы он не думал, что работа ещё идёт.
chrome.tabs.onRemoved.addListener(tabId => {
  fetch(PET, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Claude-Pet': '1' },
    body: JSON.stringify({ tabId, state: 'closed' }) }).catch(() => {})
})

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'state' || !sender.tab) return
  const body = JSON.stringify({ ...message, tabId: sender.tab.id, windowId: sender.tab.windowId })
  fetch(PET, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Claude-Pet': '1' }, body })
    .then(response => response.json())
    .then(({ focus }) => {
      if (!focus) return
      chrome.tabs.update(focus.tabId, { active: true })
      chrome.windows.update(focus.windowId, { focused: true })
    })
    .catch(() => { /* питомец не запущен */ })
})
