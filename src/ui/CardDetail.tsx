// The card detail screen: the art fills the screen behind the card, then its price,
// price history, where it lives, how many copies there are and its finish.
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUSD, type CardDB, type Finish } from '../core/carddb.ts';
import { cardPrice, type LivePrices } from '../app/session.ts';
import type { PriceHistory } from '../app/store.ts';
import { scryfallArt, scryfallImage, scryfallPage } from '../app/prices.ts';
import type { Baselines } from '../core/baselines.ts';
import type { OwnedRow } from './HomeScreen.tsx';
import { Icon, IconButton, PriceBadge } from './kit.tsx';

const FINISH_LABEL: Record<Finish, string> = { nonfoil: 'Regular', foil: 'Foil', etched: 'Etched' };
const RANGES = [
  { key: '30D', days: 30 },
  { key: '90D', days: 90 },
  { key: '1Y', days: 365 },
  { key: 'All', days: Infinity },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

interface Props {
  db: CardDB;
  row: OwnedRow;
  live: LivePrices;
  history: PriceHistory;
  baselines: Baselines | null;
  onClose: () => void;
  onOpenCollection: (binder: string) => void;
  onChangeFinish: (finish: Finish) => void;
  /** Copies of this card in this slot (1–999). */
  onChangeQuantity: (qty: number) => void;
}

const MAX_QTY = 999;

const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });

function PriceChart({ points }: { points: [string, number][] }) {
  const W = 358, H = 120;
  const prices = points.map((p) => p[1]);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const pad = (hi - lo) * 0.1 || hi * 0.05 || 1;
  const t0 = Date.parse(points[0][0]), t1 = Date.parse(points[points.length - 1][0]);
  const x = (d: string) => (t1 > t0 ? ((Date.parse(d) - t0) / (t1 - t0)) * W : W);
  const y = (p: number) => H - ((p - (lo - pad)) / (hi - lo + 2 * pad)) * H;
  const line = points.map(([d, p], i) => `${i ? 'L' : 'M'}${x(d).toFixed(1)} ${y(p).toFixed(1)}`).join(' ');
  const [lx, ly] = [x(points[points.length - 1][0]), y(prices[prices.length - 1])];
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Price from ${formatUSD(points[0][1])} to ${formatUSD(prices[prices.length - 1])}; low ${formatUSD(lo)}, high ${formatUSD(hi)}`}>
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#d6b06a" stopOpacity="0.28" />
            <stop offset="1" stopColor="#d6b06a" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L${W} ${H} L0 ${H} Z`} fill="url(#chart-fill)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <circle cx={lx} cy={ly} r="4" fill="var(--accent)" />
      </svg>
      <div className="axis">
        <span>{day(points[0][0])}</span>
        <span>Low {formatUSD(lo)} · High {formatUSD(hi)}</span>
        <span>Today</span>
      </div>
    </>
  );
}

export function CardDetail({ db, row, live, history, baselines, onClose, onOpenCollection, onChangeFinish, onChangeQuantity }: Props) {
  const info = db.info(row.card);
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<RangeKey>('30D');
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const points = useMemo(() => {
    const all = history[`${row.id}:${row.finish}`] ?? [];
    const days = RANGES.find((r) => r.key === range)!.days;
    const cutoff = Number.isFinite(days) ? new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10) : '';
    return all.filter(([d]) => d >= cutoff);
  }, [history, row.id, row.finish, range]);
  const others = info.finishes.filter((f) => f !== row.finish).map((f) => ({ f, price: cardPrice(db, row.card, f, live) })).filter((o) => o.price != null);
  const baseline = baselines?.get(row.card, row.finish);
  const rarity = info.rarity ? info.rarity[0].toUpperCase() + info.rarity.slice(1) : '';

  return (
    <div className="detail" role="dialog" aria-modal="true" aria-label={info.name} tabIndex={-1} ref={ref}>
      <div className="backdrop">
        <img src={scryfallArt(info.id)} alt="" />
      </div>
      <div className="detail-inner">
        <div className="nav">
          <IconButton icon="back" label="Back" onClick={onClose} filled />
        </div>
        <div className="hero-card">
          <img src={scryfallImage(info.id, 'normal')} alt={info.name} />
          <div>
            <h1 className="title-l">{info.name}{row.finish !== 'nonfoil' ? ' ✦' : ''}</h1>
            <div className="small muted" style={{ marginTop: 4 }}>
              {info.setName} · #{info.cn}{rarity ? ` · ${rarity}` : ''}
            </div>
          </div>
        </div>

        <section className="price-block" aria-label="Price">
          <p className="eyebrow">Market price{row.finish !== 'nonfoil' ? ` · ${FINISH_LABEL[row.finish]}` : ''}{row.qty > 1 ? ' · each' : ''}</p>
          <div className="price-row">
            <span className="money-l">{formatUSD(row.price)}</span>
            {row.trend?.gain30 != null && <PriceBadge change={row.trend.gain30} pct={row.trend.pct30} suffix="30 days" />}
          </div>
          {row.qty > 1 && (
            <p className="holding" data-testid="holding-value">
              Your {row.qty} copies <span className="num">{row.price == null ? 'no price' : formatUSD(row.price * row.qty)}</span>
            </p>
          )}
          <div className="small muted">
            {others.map((o) => `${FINISH_LABEL[o.f]} ${formatUSD(o.price)}`).join(' · ')}
            {others.length > 0 && ' · '}
            {baseline && baseline.avg30 > 0 ? `30-day average ${formatUSD(baseline.avg30)} · ` : ''}prices from Scryfall, updated daily
          </div>
        </section>

        <section className="chart" aria-label="Price history">
          <div className="ranges" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <button key={r.key} className={range === r.key ? 'on' : ''} aria-pressed={range === r.key} onClick={() => setRange(r.key)}><span>{r.key}</span></button>
            ))}
          </div>
          {points.length >= 2 ? (
            <PriceChart points={points} />
          ) : (
            <p className="small muted" style={{ margin: 0 }}>The price history fills in as prices refresh each day this card is in your collection.</p>
          )}
        </section>

        <section className="detail-rows" aria-labelledby="where-title">
          <h2 className="eyebrow" id="where-title" style={{ color: 'var(--muted)', marginBottom: 4 }}>In your collection</h2>
          <button className="detail-row" onClick={() => onOpenCollection(row.binder)}>
            <span className="label">Collection</span>
            <span className="value">{row.binder}</span>
            <Icon name="chevron" size={18} />
          </button>
          <div className="detail-row">
            <span className="label">Location</span>
            <span className="value">Page {row.page}, slot {row.slot}</span>
          </div>
          <div className="detail-row">
            <span className="label" id="qty-label">Quantity</span>
            <div className="stepper" role="group" aria-labelledby="qty-label">
              <button aria-label="Decrease quantity" disabled={row.qty <= 1} onClick={() => onChangeQuantity(row.qty - 1)}>−</button>
              <output aria-live="polite" aria-label={`${row.qty} ${row.qty === 1 ? 'copy' : 'copies'}`} data-testid="quantity">{row.qty}</output>
              <button aria-label="Increase quantity" disabled={row.qty >= MAX_QTY} onClick={() => onChangeQuantity(row.qty + 1)}>+</button>
            </div>
          </div>
          <div className="detail-row">
            <span className="label">Printing</span>
            <span className="value">{info.setName} #{info.cn}</span>
          </div>
          <div className="detail-row">
            <span className="label">Finish</span>
            {info.finishes.length > 1 ? (
              <div className="seg" role="group" aria-label="Finish" style={{ minWidth: 0 }}>
                {info.finishes.map((f) => (
                  <button key={f} className={row.finish === f ? 'on' : ''} aria-pressed={row.finish === f} onClick={() => row.finish !== f && onChangeFinish(f)}>
                    {FINISH_LABEL[f]}
                  </button>
                ))}
              </div>
            ) : (
              <span className="value">{FINISH_LABEL[row.finish]}</span>
            )}
          </div>
        </section>

        <a className="btn quiet block" href={scryfallPage(info.set, info.cn)} target="_blank" rel="noopener">
          <Icon name="external" size={20} />
          View on Scryfall
        </a>
      </div>
    </div>
  );
}
