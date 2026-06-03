import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import "./styles.css";

type FundPoint = {
  date: string;
  value: number;
};

type FundData = {
  code: string;
  name: string;
  source: string;
  navBasis: string;
  points: FundPoint[];
};

type Holding = {
  id: string;
  code: string;
  weight: string;
};

type FundState = {
  status: "idle" | "loading" | "success" | "error";
  data?: FundData;
  error?: string;
};

type RangeKey = "1m" | "3m" | "6m" | "1y" | "3y" | "5y" | "all";
type ThemeKey = "research" | "dashboard" | "minimal";

type PortfolioPoint = {
  date: string;
  returnPct: number;
  multiple: number;
};

type AnnualMarker = {
  boundaryDate: string;
  boundaryIndex: number;
  labelDate: string;
  labelIndex: number;
  labelReturnPct: number;
  label: string;
};

const STORAGE_KEY = "fund-portfolio-backtester:holdings";
const SIDEBAR_WIDTH_KEY = "fund-portfolio-backtester:sidebar-width";
const THEME_KEY = "fund-portfolio-backtester:theme";
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_SIDEBAR_WIDTH = 300;
const MAX_SIDEBAR_WIDTH = 680;
const DEFAULT_HOLDINGS: Holding[] = [
  { id: crypto.randomUUID(), code: "000001", weight: "60" },
  { id: crypto.randomUUID(), code: "110022", weight: "40" }
];

const RANGES: Array<{ key: RangeKey; label: string; days?: number }> = [
  { key: "1m", label: "近一个月", days: 31 },
  { key: "3m", label: "近三个月", days: 92 },
  { key: "6m", label: "半年", days: 183 },
  { key: "1y", label: "一年", days: 365 },
  { key: "3y", label: "三年", days: 365 * 3 },
  { key: "5y", label: "五年", days: 365 * 5 },
  { key: "all", label: "成立以来" }
];

const THEMES: Array<{ key: ThemeKey; label: string }> = [
  { key: "research", label: "投研" },
  { key: "dashboard", label: "清爽" },
  { key: "minimal", label: "极简" }
];

function loadSavedHoldings(): Holding[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_HOLDINGS;
    }
    const parsed = JSON.parse(raw) as Holding[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return DEFAULT_HOLDINGS;
    }
    return parsed.map((holding) => ({
      id: holding.id || crypto.randomUUID(),
      code: holding.code || "",
      weight: holding.weight || ""
    }));
  } catch {
    return DEFAULT_HOLDINGS;
  }
}

function loadSavedSidebarWidth() {
  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (Number.isFinite(saved)) {
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, saved));
  }
  return 390;
}

function loadSavedTheme(): ThemeKey {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "dashboard" || saved === "minimal" || saved === "research"
    ? saved
    : "research";
}

function parseDate(date: string) {
  return new Date(`${date}T00:00:00+08:00`).getTime();
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${year}/${month}/${day}`;
}

function daysBetween(start: string, end: string) {
  return Math.max(1, Math.round((parseDate(end) - parseDate(start)) / DAY_MS));
}

function annualizedReturn(startMultiple: number, endMultiple: number, days: number) {
  if (days <= 0 || startMultiple <= 0 || endMultiple <= 0) {
    return 0;
  }
  return (Math.pow(endMultiple / startMultiple, 365 / days) - 1) * 100;
}

function findLastPointAtOrBefore(points: FundPoint[], date: string) {
  let left = 0;
  let right = points.length - 1;
  let result: FundPoint | undefined;

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (points[middle].date <= date) {
      result = points[middle];
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }

  return result;
}

function calculateFundAnnualBase(points: FundPoint[]) {
  const first = points[0];
  const last = points[points.length - 1];
  const days = daysBetween(first.date, last.date);
  if (days <= 0 || first.value <= 0 || last.value <= 0) {
    return 1;
  }
  const base = Math.pow(last.value / first.value, 365 / days);
  return Number.isFinite(base) && base > 0 ? base : 1;
}

function projectedFundValueAt(fund: FundData, date: string) {
  const points = fund.points;
  const first = points[0];
  const actual = findLastPointAtOrBefore(points, date);
  if (actual) {
    return actual.value;
  }

  const base = calculateFundAnnualBase(points);
  const missingDays = daysBetween(date, first.date);
  return first.value / Math.pow(base, missingDays / 365);
}

function buildPortfolioSeries(funds: Array<{ fund: FundData; weight: number }>) {
  if (funds.length === 0) {
    return { points: [], hasProjection: false };
  }

  const startDate = funds
    .map(({ fund }) => fund.points[0].date)
    .sort((a, b) => a.localeCompare(b))[0];
  const endDate = funds
    .map(({ fund }) => fund.points[fund.points.length - 1].date)
    .sort((a, b) => b.localeCompare(a))[0];
  const dateSet = new Set<string>();

  funds.forEach(({ fund }) => {
    fund.points.forEach((point) => {
      if (point.date >= startDate && point.date <= endDate) {
        dateSet.add(point.date);
      }
    });
  });
  dateSet.add(startDate);
  dateSet.add(endDate);

  const dates = Array.from(dateSet).sort((a, b) => a.localeCompare(b));
  const startingValues = new Map<string, number>();
  let hasProjection = false;

  funds.forEach(({ fund }) => {
    const startValue = projectedFundValueAt(fund, startDate);
    if (startDate < fund.points[0].date) {
      hasProjection = true;
    }
    startingValues.set(fund.code, startValue);
  });

  const points = dates.map((date) => {
    const multiple = funds.reduce((sum, { fund, weight }) => {
      const startValue = startingValues.get(fund.code) ?? fund.points[0].value;
      const currentValue = projectedFundValueAt(fund, date);
      return sum + (currentValue / startValue) * weight;
    }, 0);

    return {
      date,
      multiple,
      returnPct: (multiple - 1) * 100
    };
  });

  return { points, hasProjection };
}

function filterByRange(points: PortfolioPoint[], range: RangeKey) {
  if (points.length === 0 || range === "all") {
    return points;
  }

  const rangeDays = RANGES.find((item) => item.key === range)?.days;
  if (!rangeDays) {
    return points;
  }

  const end = parseDate(points[points.length - 1].date);
  const start = end - rangeDays * DAY_MS;
  const filtered = points.filter((point) => parseDate(point.date) >= start);
  return filtered.length >= 2 ? filtered : points;
}

function findClosestPoint(points: PortfolioPoint[], targetTime: number) {
  return points.reduce((closest, point) => {
    const currentDistance = Math.abs(parseDate(point.date) - targetTime);
    const closestDistance = Math.abs(parseDate(closest.date) - targetTime);
    return currentDistance < closestDistance ? point : closest;
  }, points[0]);
}

function findFirstPointAtOrAfter(points: PortfolioPoint[], targetTime: number) {
  return points.find((point) => parseDate(point.date) >= targetTime) ?? points[points.length - 1];
}

function segmentCountForRange(points: PortfolioPoint[], range: RangeKey) {
  if (range === "1y") {
    return 1;
  }
  if (range === "3y") {
    return 3;
  }
  if (range === "5y") {
    return 5;
  }
  if (range !== "all" || points.length < 2) {
    return 0;
  }

  const startTime = parseDate(points[0].date);
  const endTime = parseDate(points[points.length - 1].date);
  return Math.floor((endTime - startTime) / (365 * DAY_MS));
}

function buildAnnualMarkers(points: PortfolioPoint[], range: RangeKey) {
  if (points.length < 2) {
    return [];
  }

  const segmentCount = segmentCountForRange(points, range);
  if (segmentCount <= 0) {
    return [];
  }

  const indexByDate = new Map(points.map((point, index) => [point.date, index]));
  const start = points[0];
  const end = points[points.length - 1];
  const startTime = parseDate(start.date);
  const endTime = parseDate(end.date);
  const segmentMs = range === "all" ? 365 * DAY_MS : (endTime - startTime) / segmentCount;

  return Array.from({ length: segmentCount }, (_, index) => {
    const segmentStartTime = startTime + index * segmentMs;
    const segmentEndTime =
      range === "all" ? startTime + (index + 1) * segmentMs : startTime + (index + 1) * segmentMs;
    const segmentStart = findFirstPointAtOrAfter(points, segmentStartTime);
    const segmentEnd =
      index === segmentCount - 1 && range !== "all"
        ? end
        : findFirstPointAtOrAfter(points, segmentEndTime);
    const segmentPoints = points.filter((point) => {
      const time = parseDate(point.date);
      return time >= parseDate(segmentStart.date) && time <= parseDate(segmentEnd.date);
    });
    const labelPoint = findClosestPoint(segmentPoints, (segmentStartTime + segmentEndTime) / 2);
    const segmentReturn = (segmentEnd.multiple / segmentStart.multiple - 1) * 100;

    return {
      boundaryDate: segmentEnd.date,
      boundaryIndex: indexByDate.get(segmentEnd.date) ?? points.length - 1,
      labelDate: labelPoint.date,
      labelIndex: indexByDate.get(labelPoint.date) ?? 0,
      labelReturnPct: labelPoint.returnPct,
      label: `${segmentReturn >= 0 ? "涨幅" : "跌幅"} ${formatPercent(segmentReturn)}`
    };
  });
}

function ChartAnnualOverlay({
  annualMarkers,
  points
}: {
  annualMarkers: AnnualMarker[];
  points: PortfolioPoint[];
}) {
  if (annualMarkers.length === 0 || points.length < 2) {
    return null;
  }

  const values = points.map((point) => point.returnPct);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.08, 1);
  const yMin = Math.min(0, min - padding);
  const yMax = max + padding;
  const denominator = Math.max(1, points.length - 1);
  const xForIndex = (index: number) => (index / denominator) * 100;
  const yForReturn = (value: number) => 100 - ((value - yMin) / (yMax - yMin)) * 100;

  return (
    <div className="chart-annotation-layer" aria-hidden="true">
      <svg className="annual-line-layer">
        {annualMarkers.map((marker) => {
          const x = xForIndex(marker.boundaryIndex);
          return (
            <line
              key={`line-${marker.boundaryDate}`}
              className="annual-year-line"
              x1={`${x}%`}
              x2={`${x}%`}
              y1="0"
              y2="100%"
            />
          );
        })}
      </svg>
      {annualMarkers.map((marker) => {
        const x = xForIndex(marker.labelIndex);
        const y = Math.max(8, Math.min(88, yForReturn(marker.labelReturnPct) - 4));
        return (
          <span
            key={`label-${marker.labelDate}-${marker.label}`}
            className="annual-return-label"
            style={{ left: `${x}%`, top: `${y}%` }}
          >
            {marker.label}
          </span>
        );
      })}
    </div>
  );
}

function App() {
  const [holdings, setHoldings] = useState<Holding[]>(loadSavedHoldings);
  const [range, setRange] = useState<RangeKey>("all");
  const [fundStates, setFundStates] = useState<Record<string, FundState>>({});
  const [sidebarWidth, setSidebarWidth] = useState(loadSavedSidebarWidth);
  const [theme, setTheme] = useState<ThemeKey>(loadSavedTheme);
  const shellRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
  }, [holdings]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const normalizedCodes = useMemo(
    () =>
      Array.from(
        new Set(
          holdings
            .map((holding) => holding.code.trim())
            .filter((code) => /^\d{6}$/.test(code))
        )
      ),
    [holdings]
  );

  useEffect(() => {
    normalizedCodes.forEach((code) => {
      if (fundStates[code]?.status === "success" || fundStates[code]?.status === "loading") {
        return;
      }

      setFundStates((current) => ({
        ...current,
        [code]: { status: "loading" }
      }));

      fetch(`/api/funds/${code}`)
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || "基金数据获取失败");
          }
          return payload as FundData;
        })
        .then((data) => {
          setFundStates((current) => ({
            ...current,
            [code]: { status: "success", data }
          }));
        })
        .catch((error: Error) => {
          setFundStates((current) => ({
            ...current,
            [code]: { status: "error", error: error.message }
          }));
        });
    });
  }, [fundStates, normalizedCodes]);

  const totalWeight = holdings.reduce((sum, holding) => sum + Number(holding.weight || 0), 0);
  const hasInvalidCode = holdings.some(
    (holding) => holding.code.trim() !== "" && !/^\d{6}$/.test(holding.code.trim())
  );
  const weightIsValid = Math.abs(totalWeight - 100) < 0.001;
  const hasEmpty = holdings.some((holding) => !holding.code.trim() || !holding.weight.trim());

  const loadedFunds = holdings
    .map((holding) => {
      const code = holding.code.trim();
      const state = fundStates[code];
      if (!state?.data) {
        return null;
      }
      return {
        fund: state.data,
        weight: Number(holding.weight) / 100
      };
    })
    .filter(Boolean) as Array<{ fund: FundData; weight: number }>;

  const canBacktest =
    holdings.length > 0 &&
    !hasEmpty &&
    !hasInvalidCode &&
    weightIsValid &&
    loadedFunds.length === holdings.length;

  const portfolio = useMemo(
    () => (canBacktest ? buildPortfolioSeries(loadedFunds) : { points: [], hasProjection: false }),
    [canBacktest, loadedFunds]
  );
  const visiblePoints = useMemo(
    () => filterByRange(portfolio.points, range),
    [portfolio.points, range]
  );
  const annualMarkers = useMemo(() => buildAnnualMarkers(visiblePoints, range), [visiblePoints, range]);

  const stats = useMemo(() => {
    const all = portfolio.points;
    const current = visiblePoints;
    const makeStats = (points: PortfolioPoint[]) => {
      if (points.length < 2) {
        return { total: 0, annualized: 0, days: 0 };
      }
      const first = points[0];
      const last = points[points.length - 1];
      const days = daysBetween(first.date, last.date);
      return {
        total: (last.multiple / first.multiple - 1) * 100,
        annualized: annualizedReturn(first.multiple, last.multiple, days),
        days
      };
    };

    return {
      current: makeStats(current),
      all: makeStats(all)
    };
  }, [portfolio.points, visiblePoints]);

  const errors = [
    hasInvalidCode ? "基金代码必须是 6 位数字。" : "",
    !weightIsValid ? `当前权重合计为 ${totalWeight.toFixed(2)}%，需要等于 100%。` : "",
    ...holdings.map((holding) => {
      const code = holding.code.trim();
      const state = fundStates[code];
      return state?.status === "error" ? `${code}: ${state.error}` : "";
    })
  ].filter(Boolean);

  function updateHolding(id: string, patch: Partial<Holding>) {
    setHoldings((current) =>
      current.map((holding) => (holding.id === id ? { ...holding, ...patch } : holding))
    );
  }

  function addHolding() {
    setHoldings((current) => [...current, { id: crypto.randomUUID(), code: "", weight: "" }]);
  }

  function removeHolding(id: string) {
    setHoldings((current) => current.filter((holding) => holding.id !== id));
  }

  function startResizing(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const shell = shellRef.current;
    if (!shell) {
      return;
    }

    const shellLeft = shell.getBoundingClientRect().left;
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const updateWidth = (clientX: number) => {
      const next = Math.round(clientX - shellLeft);
      setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, next)));
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateWidth(moveEvent.clientX);
    };
    const stopResizing = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
  }

  return (
    <main
      className="app-shell"
      data-theme={theme}
      ref={shellRef}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      <section className="panel controls">
        <div className="title-block">
          <p className="eyebrow">本地回测工具</p>
          <h1>基金组合收益曲线</h1>
          <p>录入基金代码和权重，按复权净值回测组合涨跌。</p>
        </div>

        <div className="holdings">
          <div className="table-head">
            <span>基金代码</span>
            <span>权重</span>
            <span>状态</span>
            <span />
          </div>
          {holdings.map((holding) => {
            const code = holding.code.trim();
            const state = fundStates[code];
            return (
              <div className="holding-row" key={holding.id}>
                <input
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000001"
                  value={holding.code}
                  onChange={(event) =>
                    updateHolding(holding.id, {
                      code: event.target.value.replace(/\D/g, "").slice(0, 6)
                    })
                  }
                />
                <label className="weight-input">
                  <input
                    inputMode="decimal"
                    placeholder="50"
                    value={holding.weight}
                    onChange={(event) =>
                      updateHolding(holding.id, {
                        weight: event.target.value.replace(/[^\d.]/g, "")
                      })
                    }
                  />
                  <span>%</span>
                </label>
                <div className="fund-status">
                  {state?.status === "loading" && "加载中"}
                  {state?.status === "success" && state.data?.name}
                  {state?.status === "error" && "失败"}
                  {!state && "待输入"}
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="删除基金"
                  onClick={() => removeHolding(holding.id)}
                  disabled={holdings.length === 1}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        <div className="control-footer">
          <button type="button" onClick={addHolding}>
            添加基金
          </button>
          <div className={weightIsValid ? "weight-total ok" : "weight-total"}>
            权重合计 {totalWeight.toFixed(2)}%
          </div>
        </div>

        {errors.length > 0 && (
          <div className="error-box">
            {errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        )}

        <div className="theme-switcher" aria-label="界面风格">
          {THEMES.map((item) => (
            <button
              className={theme === item.key ? "active" : ""}
              key={item.key}
              type="button"
              onClick={() => setTheme(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>

      <button
        className="resize-handle"
        type="button"
        aria-label="拖动调整左右区域宽度"
        onPointerDown={startResizing}
      />

      <section className="workspace">
        <div className="range-tabs" aria-label="收益区间">
          {RANGES.map((item) => (
            <button
              className={range === item.key ? "active" : ""}
              key={item.key}
              type="button"
              onClick={() => setRange(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="stats-grid">
          <div className="stat-card">
            <span>当前区间收益</span>
            <strong>{formatPercent(stats.current.total)}</strong>
          </div>
          <div className="stat-card">
            <span>当前区间年化</span>
            <strong>{formatPercent(stats.current.annualized)}</strong>
          </div>
          <div className="stat-card">
            <span>成立以来收益</span>
            <strong>{formatPercent(stats.all.total)}</strong>
          </div>
          <div className="stat-card">
            <span>成立以来年化</span>
            <strong>{formatPercent(stats.all.annualized)}</strong>
          </div>
        </div>

        <div className="chart-panel">
          {canBacktest && visiblePoints.length > 1 ? (
            <>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={visiblePoints} margin={{ top: 38, right: 24, bottom: 8, left: 4 }}>
                  <defs>
                    <linearGradient id="returnFill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-line)" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="var(--chart-line)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                  <CartesianGrid stroke="var(--grid-line)" strokeDasharray="4 4" />
                  <XAxis
                    dataKey="date"
                    minTickGap={42}
                    tickFormatter={formatDate}
                    tick={{ fill: "var(--muted)", fontSize: 12 }}
                  />
                  <YAxis
                    tickFormatter={(value) => `${Number(value).toFixed(0)}%`}
                    tick={{ fill: "var(--muted)", fontSize: 12 }}
                    width={54}
                  />
                  <Tooltip
                    formatter={(value) => [formatPercent(Number(value)), "组合收益"]}
                    labelFormatter={(label) => formatDate(String(label))}
                  />
                  <Area
                    dataKey="returnPct"
                    name="组合收益"
                    type="monotone"
                    stroke="var(--chart-line)"
                    strokeWidth={2.5}
                    fill="url(#returnFill)"
                    dot={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
              <ChartAnnualOverlay annualMarkers={annualMarkers} points={visiblePoints} />
            </>
          ) : (
            <div className="empty-state">
              <h2>等待生成收益曲线</h2>
              <p>填写基金代码并让权重合计为 100%，数据加载完成后会自动回测。</p>
            </div>
          )}
        </div>

        <div className="note-line">
          {portfolio.hasProjection
            ? "部分基金成立前数据已按已有收益年化倒推外推。"
            : "收益曲线按复权净值计算，不额外扣除申购和赎回费用。"}
          {visiblePoints.length > 1 &&
            ` 当前显示 ${formatDate(visiblePoints[0].date)} 至 ${formatDate(
              visiblePoints[visiblePoints.length - 1].date
            )}。`}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
