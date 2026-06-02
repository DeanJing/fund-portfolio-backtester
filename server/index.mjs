import express from "express";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const isProduction = process.env.NODE_ENV === "production" || process.argv.includes("--production");
const PORT_MIN = 50000;
const PORT_MAX = 60000;
const FUND_CACHE_TTL_MS = 1000 * 60 * 20;
const fundCache = new Map();

function isValidFundCode(code) {
  return /^\d{6}$/.test(code);
}

function decodeFundScript(bytes) {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (utf8.includes("Data_ACWorthTrend") && !utf8.includes("�")) {
    return utf8.replace(/^\uFEFF/, "");
  }
  return new TextDecoder("gb18030").decode(bytes).replace(/^\uFEFF/, "");
}

function extractJsonArray(script, variableName) {
  const startToken = `var ${variableName} =`;
  const start = script.indexOf(startToken);
  if (start === -1) {
    return null;
  }

  const arrayStart = script.indexOf("[", start);
  if (arrayStart === -1) {
    return null;
  }

  let depth = 0;
  for (let index = arrayStart; index < script.length; index += 1) {
    const char = script[index];
    if (char === "[") {
      depth += 1;
    }
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return script.slice(arrayStart, index + 1);
      }
    }
  }

  return null;
}

function extractStringVariable(script, variableName) {
  const pattern = new RegExp(`var\\s+${variableName}\\s*=\\s*"([^"]*)"`);
  const match = script.match(pattern);
  return match?.[1] ?? "";
}

function parseWorthTrend(script) {
  const accumulatedRaw = extractJsonArray(script, "Data_ACWorthTrend");
  const netRaw = extractJsonArray(script, "Data_netWorthTrend");
  const raw = accumulatedRaw ?? netRaw;

  if (!raw) {
    throw new Error("未找到历史净值数据");
  }

  const parsed = JSON.parse(raw);
  return parsed
    .map((point) => {
      if (Array.isArray(point)) {
        return {
          date: new Date(point[0]).toISOString().slice(0, 10),
          value: Number(point[1])
        };
      }
      return {
        date: new Date(point.x).toISOString().slice(0, 10),
        value: Number(point.y)
      };
    })
    .filter((point) => Number.isFinite(point.value) && point.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchFund(code) {
  const cached = fundCache.get(code);
  if (cached && Date.now() - cached.createdAt < FUND_CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    }
  });

  if (!response.ok) {
    throw new Error(`数据源返回 ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const script = decodeFundScript(bytes);
  const name = extractStringVariable(script, "fS_name") || code;
  const points = parseWorthTrend(script);

  if (points.length < 2) {
    throw new Error("历史净值数据不足");
  }

  const data = {
    code,
    name,
    source: "eastmoney",
    navBasis: "accumulated",
    points
  };
  fundCache.set(code, { createdAt: Date.now(), data });
  return data;
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, "127.0.0.1");
  });
}

async function findOpenPort() {
  for (let port = PORT_MIN; port <= PORT_MAX; port += 1) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`未找到 ${PORT_MIN}-${PORT_MAX} 范围内的可用端口`);
}

const app = express();

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/funds/:code", async (request, response) => {
  const code = request.params.code.trim();
  if (!isValidFundCode(code)) {
    response.status(400).json({ error: "基金代码必须是 6 位数字" });
    return;
  }

  try {
    response.json(await fetchFund(code));
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : "基金数据获取失败"
    });
  }
});

if (isProduction) {
  app.use(express.static(path.join(rootDir, "dist")));
  app.use((_request, response) => {
    response.sendFile(path.join(rootDir, "dist", "index.html"));
  });
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

const port = await findOpenPort();
const server = createHttpServer(app);

server.listen(port, "127.0.0.1", () => {
  console.log(`基金组合回测网站已启动: http://127.0.0.1:${port}`);
});
