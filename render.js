/**
 * Рисует оригинального питомца по клеткам: туловище 16×12, ноги 2×4, руки — квадраты 4×4.
 * Детали никогда не меняют форму и размер — двигаются только их положения: тело подпрыгивает,
 * руки-квадратики отрываются от тела и парят в воздухе. Поза считается из времени, поэтому движения не повторяются.
 *
 *   PetRender.pose(layer, t, opts)  — поза для слоя ('idle', 'done', …) через t мс после его начала
 *   PetRender.draw(ctx, pose)       — нарисовать позу на холсте W×H клеток
 *
 * Чистые функции без состояния: их же использует tools/preview.html, чтобы посмотреть все кадры разом.
 * «Работа за ноутбуком» — готовые кадры assets/thinking.sheet.png, их рисует pet.html.
 */
(() => {
  // Холст как у старых кадров (29×24), плюс 6 строк сверху для поднятых рук и галочки.
  const W = 29, H = 30, TOP = 6
  const C = {
    body: '#d77655', eye: '#080808', check: '#52c66d', checkDark: '#2c8545',
    gold: '#ffc840', goldDark: '#b8860b', white: '#f4f4f8', ink: '#8d8d99', z: '#e8e8f2', heart: '#ff6f86',
  }
  const glyph = rows => rows.map(row => [...row])
  const G = {
    check: glyph(['........##', '.......##.', '##....##..', '.##..##...', '..####....', '...##.....']),
    mini: glyph(['.....##', '#...##.', '##.##..', '.###...', '..#....']),
    bang: glyph(['##', '##', '##', '##', '..', '##']),
    ask: glyph(['####.', '...##', '..##.', '.##..', '.....', '.##..']),
    page: glyph(['wwwww', 'wkkkw', 'wwwww', 'wkkww', 'wwwww', 'wkkkw']),
    z: glyph(['####', '..#.', '.#..', '####']),
    zs: glyph(['###', '.#.', '###']),
    spark: glyph(['.#.', '###', '.#.']),
    heart: glyph(['##.##', '#####', '.###.', '..#..']),
  }

  let ctx = null
  const rect = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h) }
  function stamp(g, x, y, color, palette = {}) {
    g.forEach((row, j) => row.forEach((cell, i) => { if (cell !== '.') rect(x + i, y + j, 1, 1, palette[cell] ?? color) }))
  }
  /** Знак с тенью на клетку ниже: читается на любом фоне рабочего стола. */
  const badge = (g, x, y, color, shade) => { stamp(g, x, y + 1, shade); stamp(g, x, y, color) }

  // ── время ──────────────────────────────────────────────────────────────────
  const phase = (t, period, offset = 0) => (((t + offset) % period) + period) % period / period   // 0..1
  const pulse = (t, period, duty = 0.5, offset = 0) => phase(t, period, offset) < duty
  /** Детерминированный «случай»: одинаковый для одного и того же n (кадры не дрожат). */
  const noise = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s) }
  /** Прыжок: высота в клетках по синусу на отрезке [from, from + ms]. */
  const jump = (t, from, ms, height) => (t < from || t > from + ms ? 0 : -Math.round(height * Math.sin(Math.PI * (t - from) / ms)))

  // Руки: сдвиг квадрата от его места у тела. dx — наружу (+) или внутрь (−), dy — вниз (+) или вверх (−).
  const arm = (dx = 0, dy = 0) => ({ dx, dy })
  const base = () => ({ bx: 0, by: 0, arms: [arm(), arm()], eyes: { kind: 'open', lx: 0, ly: 0 }, extras: [] })

  // ── позы ───────────────────────────────────────────────────────────────────
  /** Дыхание: тело чуть приподнимается, руки-квадратики догоняют его с опозданием — так они «парят». */
  function breathe(p, t, period = 2600) {
    const up = !pulse(t, period)
    p.by = up ? -1 : 0
    const lag = pulse(t, period, 0.5, -220) !== pulse(t, period)          // руки отстают на 220 мс
    p.arms = [arm(0, lag ? (up ? 1 : -1) : 0), arm(0, lag ? (up ? 1 : -1) : 0)]
  }

  function idle(p, t, o) {
    breathe(p, t)
    p.eyes.lx = o.look.x; p.eyes.ly = o.look.y
    const f = o.fidget, ft = o.ft ?? 0
    if (f === 'wave') {                                    // машет одной рукой: квадратик взлетает и качается
      p.arms[1] = arm(pulse(ft, 360) ? 1 : 2, -7)
      p.eyes = { kind: 'happy' }
    } else if (f === 'stretch') {                          // потягивается: обе руки взлетают над головой
      const k = ft < 300 ? ft / 300 : ft < 1100 ? 1 : Math.max(0, 1 - (ft - 1100) / 300)
      p.arms = [arm(Math.round(k), -Math.round(7 * k)), arm(Math.round(k), -Math.round(7 * k))]
      p.by = k > 0.5 ? -1 : 0
      if (k > 0.5) p.eyes = { kind: 'happy' }
    } else if (f === 'hop') {                              // подпрыгивает от скуки; руки отстают
      p.by = jump(ft, 80, 420, 4)
      const rising = ft > 80 && ft < 290, falling = ft >= 290 && ft < 560
      p.arms = rising ? [arm(0, 2), arm(0, 2)] : falling ? [arm(0, -2), arm(0, -2)] : [arm(), arm()]
    } else if (f === 'look') {                             // оглядывается
      p.eyes.lx = ft < 700 ? -1 : ft < 1500 ? 1 : 0; p.eyes.ly = 0
    } else if (f === 'juggle') {                           // подкидывает руки-квадратики по очереди
      p.arms = [arm(-1, jump(ft, 0, 500, 5)), arm(-1, jump(ft, 400, 500, 5))]
      p.eyes = { kind: 'open', lx: 0, ly: -1 }
    } else if (f === 'dance') {                            // пританцовывает
      p.bx = pulse(ft, 500) ? -1 : 1; p.by = pulse(ft, 250) ? 0 : -1
      p.arms = pulse(ft, 500) ? [arm(0, -4), arm(1, 1)] : [arm(1, 1), arm(0, -4)]
      p.eyes = { kind: 'happy' }
    }
    if (o.blink && p.eyes.kind === 'open') p.eyes.kind = 'blink'
  }

  function sleep(p, t) {
    p.arms = [arm(0, 1), arm(0, 1)]
    p.by = pulse(t, 3200) ? 0 : 1                          // тяжело дышит во сне: опускается и поднимается
    p.eyes = { kind: 'blink' }
    p.extras.push(({ x0, y0 }) => {                        // «Z» поднимаются
      for (let k = 0; k < 2; k++) {
        const ph = phase(t, 3200, k * 1600)
        stamp(ph < 0.5 ? G.zs : G.z, x0 + 15 + Math.round(ph * 4), y0 - 3 - Math.round(ph * 8), C.z)
      }
    })
  }

  /** Ждёт тебя: руки-квадраты по очереди взлетают над головой, над ним знак (!, ? или лист с планом). */
  function waiting(p, t, o) {
    const a = pulse(t, 520)
    p.arms = [arm(a ? 1 : 0, a ? -6 : -2), arm(a ? 0 : 1, a ? -2 : -6)]
    p.eyes = { kind: 'wide', lx: o.look.x, ly: 0 }
    if (o.blink) p.eyes.kind = 'blink'
    p.by = pulse(t, 1600, 0.12) ? -1 : 0
    const mark = o.mark ?? 'approval'
    p.extras.push(({ x0, y0 }) => {
      const y = y0 - 8 + (pulse(t, 700) ? 0 : -1), cx = x0 + 8
      if (mark === 'question') badge(G.ask, cx - 2, y, C.gold, C.goldDark)
      else if (mark === 'plan') { stamp(G.page, cx - 2, y + 1, C.ink, { w: C.ink, k: C.ink }); stamp(G.page, cx - 2, y, C.white, { w: C.white, k: C.ink }) }
      else badge(G.bang, cx - 1, y, C.gold, C.goldDark)
    })
  }

  /** Ответ готов: прыжок, руки-квадраты взлетают и держат над головой галочку. */
  const CELEBRATE_MS = 3400
  function done(p, t) {
    p.eyes = { kind: 'happy' }
    if (t < 150) { p.arms = [arm(0, 1), arm(0, 1)]; return }          // замах
    p.by = jump(t, 150, 480, 5)
    let wiggle = 0
    if (t > 700) {
      p.by = pulse(t, 460) ? 0 : -1
      wiggle = pulse(t, 300) ? 0 : 1
    }
    // Руки летят к краям галочки: быстрее тела, поэтому сначала догоняют, потом держат.
    const k = Math.min(1, (t - 150) / 250)
    const lift = -Math.round(9 * k)
    p.arms = [arm(-Math.round(2 * k) + wiggle, lift), arm(-Math.round(2 * k) - wiggle, lift)]
    p.extras.push(({ x0, y0 }) => {
      if (k < 1) return
      const cx = x0 + 8 + wiggle
      badge(G.check, cx - 5, y0 - 8, C.check, C.checkDark)
      if (t > 700) for (let j = 0; j < 3; j++) {           // искры вокруг галочки
        const n = Math.floor(t / 260) + j * 13
        if (noise(n) < 0.55) continue
        const sx = cx - 10 + Math.floor(noise(n + 1) * 20), sy = y0 - 12 + Math.floor(noise(n + 2) * 7)
        if (noise(n + 3) > 0.5) stamp(G.spark, sx, sy, C.gold); else rect(sx + 1, sy + 1, 1, 1, C.gold)
      }
    })
  }

  /** После праздника: довольный, маленькая галочка покачивается над головой. */
  function proud(p, t, o) {
    breathe(p, t, 2200)
    p.eyes = o.blink ? { kind: 'blink' } : (pulse(t, 5000, 0.7) ? { kind: 'happy' } : { kind: 'open', lx: o.look.x, ly: o.look.y })
    p.extras.push(({ x0, y0 }) => badge(G.mini, x0 + 5, y0 - 7 + (pulse(t, 900) ? 0 : -1), C.check, C.checkDark))
  }

  /** Наведение и клик: подпрыгивает, руки хлопают в воздухе; на клик — сердечко. */
  function joy(p, t, o) {
    p.by = pulse(t, 440) ? 0 : -1
    const up = pulse(t, 220)
    p.arms = [arm(up ? 1 : 0, up ? -3 : 0), arm(up ? 1 : 0, up ? -3 : 0)]
    p.eyes = { kind: 'happy' }
    if (o.heart !== undefined && o.heart < 1100) {
      const k = o.heart / 1100
      p.extras.push(({ x0, y0 }) => stamp(G.heart, x0 + 15 + Math.round(k * 2), y0 - 4 - Math.round(k * 5), C.heart))
    }
  }

  /** Несут: руки взлетели вверх и отстают от движения, глаза круглые. */
  function held(p, t, o) {
    const s = o.swing ?? 0
    p.arms = [arm(1 + s, -4 + (pulse(t, 300) ? 0 : 1)), arm(1 - s, -4 + (pulse(t, 300, 0.5, 150) ? 0 : 1))]
    p.eyes = { kind: 'wide', lx: -s, ly: 1 }
  }

  /** Отпустили: отскок, руки ещё в воздухе и падают на место последними. */
  function drop(p, t) {
    p.by = jump(t, 0, 260, 2)
    p.arms = t < 260 ? [arm(1, -3), arm(1, -3)] : t < 420 ? [arm(0, -1), arm(0, -1)] : [arm(), arm()]
    p.eyes = t < 260 ? { kind: 'wide', lx: 0, ly: 0 } : { kind: 'open', lx: 0, ly: 0 }
  }

  /** Появление: выпрыгивает снизу, руки прилетают следом, машет «привет». */
  function appear(p, t) {
    if (t < 380) { p.by = Math.round(18 * (1 - t / 380)) - (t > 300 ? 1 : 0); p.arms = [arm(0, 4), arm(0, 4)]; p.eyes = { kind: 'wide', lx: 0, ly: 0 } }
    else if (t < 520) p.arms = [arm(0, -2), arm(0, -2)]
    else { p.eyes = { kind: 'happy' }; p.arms[1] = arm(pulse(t, 300) ? 1 : 2, -7) }
  }

  const LAYERS = { idle, sleep, waiting, done, proud, joy, held, drop, appear }

  function pose(layer, t, opts = {}) {
    const p = base()
    const o = { look: { x: 0, y: 0 }, ...opts }
    ;(LAYERS[layer] ?? idle)(p, Math.max(0, t), o)
    return p
  }

  // ── рисование: те же детали, что у оригинала ───────────────────────────────
  function draw(context, p) {
    ctx = context
    ctx.clearRect(0, 0, W, H)
    const x0 = 6 + p.bx, y0 = TOP + 7 + p.by                // туловище 16×12, как в старых кадрах
    for (const dx of [0, 4, 10, 14]) rect(x0 + dx, y0 + 12, 2, 4, C.body)
    rect(x0, y0, 16, 12, C.body)
    const [L, R] = p.arms
    rect(x0 - 4 - L.dx, y0 + 4 + L.dy, 4, 4, C.body)
    rect(x0 + 16 + R.dx, y0 + 4 + R.dy, 4, 4, C.body)

    const e = p.eyes, lx = e.lx ?? 0, ly = e.ly ?? 0
    for (const ex of [x0 + 2, x0 + 12]) {
      if (e.kind === 'open') rect(ex + lx, y0 + 2 + ly, 2, 2, C.eye)
      else if (e.kind === 'blink') rect(ex + lx, y0 + 3, 2, 1, C.eye)
      else if (e.kind === 'wide') rect(ex + lx, y0 + 1 + ly, 2, 4, C.eye)
      else if (e.kind === 'happy') { rect(ex, y0 + 2, 2, 1, C.eye); rect(ex - 1, y0 + 3, 4, 1, C.eye) }
    }
    for (const extra of p.extras) extra({ x0, y0 })
  }

  window.PetRender = { W, H, TOP, pose, draw, CELEBRATE_MS }
})()
