// The outline drawn over the photo or video: one shape with four corner
// handles, whatever the input. For an open binder it goes around both pages,
// and a handle on the spine sets the gap between them. Each page shows its
// 3x3 pocket grid; the white edge marks the top of the cards.
import { useRef } from 'react';
import { applyH, homography, MAX_GAP, outlineOf, subQuad, UNIT_QUAD, withOutline, type Calibration, type Pt, type Quad } from '../core/geometry.ts';

interface Props {
  cal: Calibration;
  width: number;
  height: number;
  editable: boolean;
  onChange?: (cal: Calibration) => void;
  highlight?: boolean;
}

type Drag = { what: number | 'all' | 'gap'; start: Pt; quad: Quad; gap: number; pointer: number };

export function QuadOverlay({ cal, width, height, editable, onChange, highlight }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const px = (p: Pt) => ({ x: p.x * width, y: p.y * height });
  const unit = Math.max(width, height) / 100;
  const { quad, gap } = outlineOf(cal);
  const twoPages = cal.pages.length > 1;

  const toNorm = (e: React.PointerEvent): Pt => {
    const r = svg.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const start = (what: Drag['what']) => (e: React.PointerEvent) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { what, start: toNorm(e), quad, gap, pointer: e.pointerId };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId || !onChange) return;
    const p = toNorm(e);
    if (d.what === 'gap') {
      // The gap is symmetric about the middle of the outline: measure how far from the middle the finger is.
      const u = applyH(homography(d.quad, UNIT_QUAD), p.x, p.y).x;
      onChange(withOutline(cal, d.quad, Math.min(MAX_GAP, Math.abs(u - 0.5) * 2)));
      return;
    }
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const q = d.quad.map((c, i) => (d.what === 'all' || d.what === i ? { x: clamp(c.x + dx), y: clamp(c.y + dy) } : c)) as Quad;
    onChange(withOutline(cal, q, d.gap));
  };
  const end = (e: React.PointerEvent) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  };

  const pts = quad.map(px);
  const lines: string[] = [];
  const seg = (a: Pt, b: Pt) => lines.push(`M${px(a).x},${px(a).y}L${px(b).x},${px(b).y}`);
  for (const page of cal.pages) {
    // Page outline and its pocket grid.
    for (let i = 0; i < 4; i++) seg(page[i], page[(i + 1) % 4]);
    for (let i = 1; i < cal.cols; i++) {
      const a = subQuad(page, i / cal.cols, 0, i / cal.cols, 1);
      seg(a[0], a[3]);
    }
    for (let i = 1; i < cal.rows; i++) {
      const a = subQuad(page, 0, i / cal.rows, 1, i / cal.rows);
      seg(a[0], a[1]);
    }
  }
  const spine = twoPages ? [cal.pages[0][1], cal.pages[1][0], cal.pages[1][3], cal.pages[0][2]].map(px) : null;
  const gapHandle = twoPages ? px(subQuad(quad, 0.5 + gap / 2, 0, 0.5 + gap / 2, 0)[0]) : null;
  // The "top" label sits over the (left) page, clear of the spine handle.
  const mid = px(subQuad(quad, twoPages ? 0.25 : 0.5, 0, twoPages ? 0.25 : 0.5, 0)[0]);

  return (
    <svg ref={svg} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <polygon
        className={`quad ${editable ? '' : 'locked'}`}
        points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
        strokeWidth={unit * (highlight ? 0.5 : 0.35)}
        onPointerDown={start('all')}
        style={{ cursor: editable ? 'move' : 'default' }}
      />
      {spine && <polygon className="spine" points={spine.map((p) => `${p.x},${p.y}`).join(' ')} pointerEvents="none" />}
      <path className="gridline" d={lines.join('')} strokeWidth={unit * 0.2} pointerEvents="none" />
      <line className="topedge" x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y} strokeWidth={unit * 0.6} pointerEvents="none" />
      <text x={mid.x} y={mid.y} dy={-unit * 1.2} fill="#fff" fontSize={unit * 2.4} textAnchor="middle" fontWeight={700} pointerEvents="none">
        top
      </text>
      {editable &&
        pts.map((p, ci) => (
          <g key={ci}>
            <circle className="handle-hit" cx={p.x} cy={p.y} r={unit * 4} onPointerDown={start(ci)} data-handle="corner" />
            <circle className="handle" cx={p.x} cy={p.y} r={unit * 1.3} strokeWidth={unit * 0.3} pointerEvents="none" />
          </g>
        ))}
      {editable && gapHandle && (
        <g>
          <circle className="handle-hit" cx={gapHandle.x} cy={gapHandle.y} r={unit * 3.5} onPointerDown={start('gap')} data-handle="gap" />
          <rect className="handle gap" x={gapHandle.x - unit * 0.9} y={gapHandle.y - unit * 1.6} width={unit * 1.8} height={unit * 3.2} rx={unit * 0.5} strokeWidth={unit * 0.3} pointerEvents="none" />
        </g>
      )}
    </svg>
  );
}
