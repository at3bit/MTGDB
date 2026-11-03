// Draggable page outlines drawn over the camera image. Each page shows its
// 3x3 pocket grid; the white edge marks the top of the cards.
import { useRef } from 'react';
import { subQuad, type Calibration, type Pt, type Quad } from '../core/geometry.ts';

interface Props {
  cal: Calibration;
  width: number;
  height: number;
  editable: boolean;
  onChange?: (cal: Calibration) => void;
  highlight?: boolean;
}

type Drag = { page: number; corner: number | 'all'; start: Pt; orig: Quad; pointer: number };

export function QuadOverlay({ cal, width, height, editable, onChange, highlight }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const px = (p: Pt) => ({ x: p.x * width, y: p.y * height });
  const unit = Math.max(width, height) / 100;

  const toNorm = (e: React.PointerEvent): Pt => {
    const r = svg.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const start = (page: number, corner: number | 'all') => (e: React.PointerEvent) => {
    if (!editable) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { page, corner, start: toNorm(e), orig: cal.pages[page], pointer: e.pointerId };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId || !onChange) return;
    const p = toNorm(e);
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const q = d.orig.map((c, i) => (d.corner === 'all' || d.corner === i ? { x: clamp(c.x + dx), y: clamp(c.y + dy) } : c)) as Quad;
    onChange({ ...cal, pages: cal.pages.map((pg, i) => (i === d.page ? q : pg)) });
  };
  const end = (e: React.PointerEvent) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  };

  return (
    <svg ref={svg} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      {cal.pages.map((q, pi) => {
        const pts = q.map(px);
        const lines: string[] = [];
        for (let i = 1; i < cal.cols; i++) {
          const a = subQuad(q, i / cal.cols, 0, i / cal.cols, 1);
          lines.push(`M${px(a[0]).x},${px(a[0]).y}L${px(a[3]).x},${px(a[3]).y}`);
        }
        for (let i = 1; i < cal.rows; i++) {
          const a = subQuad(q, 0, i / cal.rows, 1, i / cal.rows);
          lines.push(`M${px(a[0]).x},${px(a[0]).y}L${px(a[1]).x},${px(a[1]).y}`);
        }
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        return (
          <g key={pi}>
            <polygon
              className={`quad ${editable ? '' : 'locked'}`}
              points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
              strokeWidth={unit * (highlight ? 0.5 : 0.35)}
              onPointerDown={start(pi, 'all')}
              style={{ cursor: editable ? 'move' : 'default' }}
            />
            <path className="gridline" d={lines.join('')} strokeWidth={unit * 0.2} pointerEvents="none" />
            <line className="topedge" x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y} strokeWidth={unit * 0.6} pointerEvents="none" />
            <text x={mid.x} y={mid.y} dy={-unit * 1.2} fill="#fff" fontSize={unit * 2.4} textAnchor="middle" fontWeight={700} pointerEvents="none">
              {cal.pages.length > 1 ? (pi === 0 ? 'LEFT · top' : 'RIGHT · top') : 'top'}
            </text>
            {editable &&
              pts.map((p, ci) => (
                <g key={ci}>
                  <circle className="handle-hit" cx={p.x} cy={p.y} r={unit * 4} onPointerDown={start(pi, ci)} />
                  <circle className="handle" cx={p.x} cy={p.y} r={unit * 1.3} strokeWidth={unit * 0.3} pointerEvents="none" />
                </g>
              ))}
          </g>
        );
      })}
    </svg>
  );
}
