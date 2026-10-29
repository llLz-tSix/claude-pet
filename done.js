/**
 * Сглаживает состояние источника:
 *  - короткие пропадания «идёт работа» (кнопка Stop на миг исчезает между этапами ответа) не считаются концом —
 *    питомец не дёргается thinking → idle → thinking;
 *  - когда работа действительно закончилась, показываем «готово» ещё 20 секунд.
 */
class DoneTracker {
  constructor(ms = 20000, grace = 1500) {
    this.ms = ms
    this.grace = grace
    this.reset()
  }

  reset() { this.prev = 'idle'; this.busy = 'idle'; this.lastBusyAt = 0; this.until = 0 }

  feed(state, now = Date.now()) {
    if (state === 'thinking' || state === 'waiting') {
      this.prev = state; this.busy = state; this.lastBusyAt = now
      return state
    }
    const wasBusy = this.prev === 'thinking' || this.prev === 'waiting'
    if (wasBusy && now - this.lastBusyAt < this.grace) return this.busy      // ещё не конец
    if (wasBusy) this.until = now + this.ms
    this.prev = 'idle'
    return now < this.until ? 'done' : 'idle'
  }
}
module.exports = DoneTracker
