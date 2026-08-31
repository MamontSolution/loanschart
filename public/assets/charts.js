/* ============================================================================
   Графики: рисуем SVG вручную, без внешних библиотек.
   Экспортируется глобальный объект Charts.
   ============================================================================ */
(function (global) {
  'use strict';

  const nf  = new Intl.NumberFormat('ru-RU');
  const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const MONTHS = ['января','февраля','марта','апреля','мая','июня',
                  'июля','августа','сентября','октября','ноября','декабря'];

  const money = v => v === null ? '—' : nf.format(Math.round(v)) + ' ₽';
  const units = v => v === null ? '—' : nf.format(Math.round(v)) + ' шт.';

  function compact(v){
    const a = Math.abs(v);
    if (a >= 1e9) return nf1.format(v/1e9) + ' млрд';
    if (a >= 1e6) return nf1.format(v/1e6) + ' млн';
    if (a >= 1e3) return nf1.format(v/1e3) + ' тыс.';
    return nf.format(Math.round(v));
  }
  /** '2026-09-01' → '1 сентября' */
  function longDate(iso){
    const [y,m,d] = String(iso).split('-').map(Number);
    return d + ' ' + (MONTHS[m-1] || '') ;
  }
  /** '2026-09-01' → '1.09' */
  function shortDate(iso){
    const [, m, d] = String(iso).split('-');
    return Number(d) + '.' + m;
  }

  function niceTicks(min, max, count){
    if (min === max){ min = Math.min(0, min); max = max || 1; }
    const span = (max - min) || 1;
    const step0 = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1,2,2.5,5,10].map(m => m*mag).find(s => s >= step0) || 10*mag;
    const lo = Math.floor(min/step)*step, hi = Math.ceil(max/step)*step;
    const out = [];
    for (let v = lo; v <= hi + step/2; v += step) out.push(+v.toFixed(10));
    return out;
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };
  const surfaceColor = () =>
    getComputedStyle(document.body).getPropertyValue('--page').trim() || '#fff';

  /**
   * Группа связанных графиков: наведение синхронизировано между панелями.
   * specs: [{ host, key, kind:'line'|'bar', color, height, fmt, label, logCapable }]
   */
  function createGroup(specs){
    const state = { data: [], hover: null, log: false };

    function draw(spec){
      const host = typeof spec.host === 'string'
        ? document.getElementById(spec.host) : spec.host;
      if (!host) return;
      let tt = host.querySelector('.tt');
      if (!tt){ tt = document.createElement('div'); tt.className = 'tt'; host.appendChild(tt); }
      host.querySelectorAll('svg').forEach(s => s.remove());

      const data = state.data;
      const W = Math.max(300, host.clientWidth || 640);
      const H = spec.height;
      const padL = 62, padR = 16, padT = 16, padB = 26;
      const pw = W - padL - padR, ph = H - padT - padB;

      const svg = el('svg', { viewBox:`0 0 ${W} ${H}`, width:W, height:H,
                              role:'img', 'aria-label': spec.label });
      host.appendChild(svg);
      if (!data.length){ tt.style.opacity = 0; return; }

      const present = data.map(d => d[spec.key])
                          .filter(v => v !== null && Number.isFinite(v));
      if (!present.length){ tt.style.opacity = 0; return; }

      const useLog = !!(spec.logCapable && state.log);
      const tf = v => useLog ? Math.log10(Math.max(v, 1)) : v;

      let dMin, dMax, ticks;
      if (useLog){
        dMin = 0; dMax = Math.ceil(Math.log10(Math.max(...present, 10)));
        ticks = []; for (let e = 0; e <= dMax; e++) ticks.push(e);
      } else {
        ticks = niceTicks(Math.min(0, ...present), Math.max(...present), 4);
        dMin = ticks[0]; dMax = ticks[ticks.length-1];
      }
      const y = v => padT + ph - ((tf(v) - dMin) / ((dMax - dMin) || 1)) * ph;

      const n = data.length, band = pw / n;
      const cx = i => padL + band*i + band/2;

      /* сетка и ось Y */
      ticks.forEach(t => {
        const val = useLog ? Math.pow(10, t) : t;
        const yy = y(val);
        svg.appendChild(el('line', { x1:padL, x2:W-padR, y1:yy, y2:yy,
          stroke:'var(--grid)', 'stroke-width':1 }));
        const lbl = el('text', { x:padL-10, y:yy+4, 'text-anchor':'end',
          fill:'var(--ink-muted)', 'font-size':11, 'font-family':'var(--font)',
          'font-variant-numeric':'tabular-nums' });
        lbl.textContent = compact(val);
        svg.appendChild(lbl);
      });
      svg.appendChild(el('line', { x1:padL, x2:W-padR, y1:padT+ph, y2:padT+ph,
        stroke:'var(--axis)', 'stroke-width':1 }));

      /* ось X — показываем не все подписи, чтобы не сталкивались */
      const xLabel = d => d.label != null ? String(d.label) : shortDate(d.date);
      const ttLabel = d => d.label != null ? String(d.label) : longDate(d.date);
      const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 64))));
      data.forEach((d, i) => {
        if (i % every) return;
        const t = el('text', { x:cx(i), y:H-8, 'text-anchor':'middle',
          fill:'var(--ink-muted)', 'font-size':11, 'font-family':'var(--font)' });
        t.textContent = xLabel(d);
        svg.appendChild(t);
      });

      /* марки */
      if (spec.kind === 'bar'){
        const bw = Math.min(24, Math.max(3, band - 2 - Math.min(10, band*0.25)));
        const r  = Math.min(4, bw/2);
        const base = padT + ph;
        data.forEach((d, i) => {
          const v = d[spec.key]; if (v === null) return;
          const yy = y(v), x = cx(i) - bw/2;
          const top = Math.min(yy, base - 1);
          const path = `M${x} ${base} L${x} ${top+r} Q${x} ${top} ${x+r} ${top}
                        L${x+bw-r} ${top} Q${x+bw} ${top} ${x+bw} ${top+r} L${x+bw} ${base} Z`;
          svg.appendChild(el('path', { d:path, fill:spec.color,
            opacity: state.hover === null || state.hover === i ? 1 : .45 }));
        });
      } else {
        const pts = data.map((d,i) => d[spec.key] === null ? null : [cx(i), y(d[spec.key])]);
        const segs = []; let cur = [];
        pts.forEach(p => { if (p) cur.push(p); else if (cur.length){ segs.push(cur); cur = []; } });
        if (cur.length) segs.push(cur);

        segs.forEach(seg => {
          if (seg.length > 1){
            const area = `M${seg[0][0]} ${padT+ph} ` + seg.map(p => `L${p[0]} ${p[1]}`).join(' ')
                       + ` L${seg[seg.length-1][0]} ${padT+ph} Z`;
            svg.appendChild(el('path', { d:area, fill:spec.color, opacity:.10 }));
          }
          svg.appendChild(el('path', {
            d: seg.map((p,i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' '),
            fill:'none', stroke:spec.color, 'stroke-width':2,
            'stroke-linejoin':'round', 'stroke-linecap':'round'
          }));
          if (seg.length === 1)
            svg.appendChild(el('circle', { cx:seg[0][0], cy:seg[0][1], r:4, fill:spec.color }));
        });
        const last = pts.filter(Boolean).pop();
        if (last) svg.appendChild(el('circle', { cx:last[0], cy:last[1], r:4.5,
          fill:spec.color, stroke:surfaceColor(), 'stroke-width':2 }));
      }

      /* слой наведения */
      const hi = state.hover;
      if (hi !== null && hi < n && data[hi][spec.key] !== null){
        const v = data[hi][spec.key], px = cx(hi), py = y(v);
        svg.appendChild(el('line', { x1:px, x2:px, y1:padT, y2:padT+ph,
          stroke:'var(--axis)', 'stroke-width':1 }));
        svg.appendChild(el('circle', { cx:px, cy:py, r:5, fill:spec.color,
          stroke:surfaceColor(), 'stroke-width':2 }));
        tt.innerHTML = '<div class="t-date"></div><div class="t-val"></div>';
        tt.firstChild.textContent = ttLabel(data[hi]);
        tt.lastChild.textContent  = spec.fmt(v);
        tt.style.opacity = 1;
        const half = tt.offsetWidth / 2;
        tt.style.left = Math.min(W - half - 4, Math.max(half + 4, px)) + 'px';
        tt.style.top  = Math.max(tt.offsetHeight + 4, py - 12) + 'px';
      } else {
        tt.style.opacity = 0;
      }

      /* захват указателя */
      const grab = el('rect', { x:padL, y:0, width:pw, height:H, fill:'transparent' });
      svg.appendChild(grab);
      const pick = ev => {
        const rect = svg.getBoundingClientRect();
        const x = (ev.clientX - rect.left) * (W / rect.width);
        const i = Math.max(0, Math.min(n-1, Math.floor((x - padL) / band)));
        if (state.hover !== i){ state.hover = i; render(); }
      };
      svg.addEventListener('mousemove', pick);
      svg.addEventListener('touchmove', e => pick(e.touches[0]), { passive:true });
      svg.addEventListener('mouseleave', () => { state.hover = null; render(); });
    }

    function render(){ specs.forEach(draw); }

    let rt;
    global.addEventListener('resize', () => {
      clearTimeout(rt); rt = setTimeout(render, 120);
    });

    return {
      setData(rows){ state.data = rows; state.hover = null; render(); },
      setLog(on){ state.log = !!on; render(); },
      render
    };
  }

  global.Charts = { createGroup, money, units, compact, longDate, shortDate, nf, nf1 };
})(window);
