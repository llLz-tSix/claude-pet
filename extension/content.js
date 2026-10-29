// Работает на страницах claude.ai: смотрит, идёт ли ответ, и сообщает фоновому скрипту.
(() => {
  const label = button => (button.getAttribute('aria-label') || '').trim()

  function detect() {
    const asking = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')]
      .some(button => /^(allow|разреш)/i.test((button.textContent || '').trim()))
    const busy = [...document.querySelectorAll('button[aria-label]')].some(button => /^(stop|останов)/i.test(label(button)))
    return asking ? 'waiting' : busy ? 'thinking' : 'idle'
  }

  let lastKey = ''
  let timer = null

  function report(force) {
    const state = detect()
    const key = `${state}|${location.href}`
    if (!force && key === lastKey) return
    lastKey = key
    try {
      chrome.runtime.sendMessage({
        type: 'state', state, url: location.href, visible: document.visibilityState === 'visible',
      }).catch(() => {})
    } catch { /* расширение перезагрузили: страница обновится */ }
  }

  // Ответ идёт — страница постоянно меняется; проверяем не чаще, чем раз в 250 мс.
  new MutationObserver(() => { timer ??= setTimeout(() => { timer = null; report(false) }, 250) })
    .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] })
  setInterval(() => report(true), 1000)      // пульс: заодно получаем команды от питомца
  document.addEventListener('visibilitychange', () => report(true))
  report(true)
})()
