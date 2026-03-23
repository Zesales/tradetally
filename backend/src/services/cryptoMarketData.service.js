const axios = require('axios');
const cache = require('../utils/cache');
const intradayCandleCache = require('../utils/intradayCandleCache');
const finnhub = require('../utils/finnhub');

const BINANCE_BASE_URL = 'https://api.binance.com/api/v3';
const COINBASE_BASE_URL = 'https://api.exchange.coinbase.com';

const INTERVAL_TO_RESOLUTION = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '1d': 'D',
  D: 'D'
};

const RESOLUTION_TO_BINANCE_INTERVAL = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '60': '1h',
  D: '1d'
};

const RESOLUTION_TO_COINBASE_GRANULARITY = {
  '1': 60,
  '5': 300,
  '15': 900,
  '60': 3600,
  D: 86400
};

class CryptoMarketDataService {
  resolveSymbols(symbol) {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    const baseSymbol = finnhub.extractCryptoBaseSymbol(normalizedSymbol) || normalizedSymbol;
    const binanceSymbol = ['USDT', 'USDC'].some(quote => normalizedSymbol.endsWith(quote))
      ? normalizedSymbol
      : `${baseSymbol}USDT`;

    return {
      normalizedSymbol,
      baseSymbol,
      binanceSymbol,
      coinbaseProductId: `${baseSymbol}-USD`
    };
  }

  normalizeResolution(interval) {
    const normalized = String(interval || '').trim();
    return INTERVAL_TO_RESOLUTION[normalized] || INTERVAL_TO_RESOLUTION[normalized.toLowerCase()] || 'D';
  }

  getCacheTtlMs({ toSeconds, resolution }) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const bucketSeconds = intradayCandleCache.getBucketSeconds(resolution);
    const isHistoricalWindow = Number(toSeconds) < (nowSeconds - (bucketSeconds * 2));

    if (isHistoricalWindow) {
      return 10 * 60 * 1000;
    }

    if (resolution === '1') return 30 * 1000;
    if (resolution === '5') return 60 * 1000;
    if (resolution === '15') return 2 * 60 * 1000;
    if (resolution === '60') return 5 * 60 * 1000;
    return 10 * 60 * 1000;
  }

  buildMemoryCacheKey({ source, symbolKey, resolution, fromSeconds, toSeconds }) {
    return `crypto_market_data:${source}:${symbolKey}:${resolution}:${fromSeconds}:${toSeconds}`;
  }

  buildPersistentSymbolKey(source, symbol) {
    return `${source}:${String(symbol || '').trim().toUpperCase()}`;
  }

  async getCandles({ symbol, interval = '1d', fromMs, toMs, source = 'binance' }) {
    const resolution = this.normalizeResolution(interval);
    const normalizedBounds = intradayCandleCache.normalizeRangeBounds(
      Math.floor(Number(fromMs) / 1000),
      Math.floor(Number(toMs) / 1000),
      resolution
    );
    const symbolKey = this.buildPersistentSymbolKey(source, symbol);
    const memoryCacheKey = this.buildMemoryCacheKey({
      source,
      symbolKey,
      resolution,
      fromSeconds: normalizedBounds.from,
      toSeconds: normalizedBounds.to
    });

    const memoryCached = cache.get(memoryCacheKey);
    if (memoryCached) {
      return {
        candles: memoryCached,
        source,
        cached: true,
        cacheLevel: 'memory'
      };
    }

    const dbCached = await intradayCandleCache.getCoveredRange(
      symbolKey,
      resolution,
      normalizedBounds.from,
      normalizedBounds.to
    );

    if (dbCached) {
      cache.set(memoryCacheKey, dbCached, this.getCacheTtlMs({ toSeconds: normalizedBounds.to, resolution }));
      return {
        candles: dbCached,
        source,
        cached: true,
        cacheLevel: 'persistent'
      };
    }

    const fetchedCandles = await this.fetchCandlesFromSource({
      symbol,
      resolution,
      fromMs: normalizedBounds.from * 1000,
      toMs: normalizedBounds.to * 1000,
      source
    });

    await intradayCandleCache.insertCandles(symbolKey, resolution, fetchedCandles, source);
    cache.set(memoryCacheKey, fetchedCandles, this.getCacheTtlMs({ toSeconds: normalizedBounds.to, resolution }));

    return {
      candles: fetchedCandles,
      source,
      cached: false,
      cacheLevel: 'network'
    };
  }

  async fetchCandlesFromSource({ symbol, resolution, fromMs, toMs, source }) {
    if (source === 'binance') {
      return this.fetchBinanceCandles({ symbol, resolution, fromMs, toMs });
    }

    if (source === 'coinbase') {
      return this.fetchCoinbaseCandles({ symbol, resolution, fromMs, toMs });
    }

    throw new Error(`Unsupported crypto market data source: ${source}`);
  }

  async fetchBinanceCandles({ symbol, resolution, fromMs, toMs }) {
    const { binanceSymbol } = this.resolveSymbols(symbol);
    const interval = RESOLUTION_TO_BINANCE_INTERVAL[resolution] || '1d';
    const response = await axios.get(`${BINANCE_BASE_URL}/klines`, {
      params: {
        symbol: binanceSymbol,
        interval,
        startTime: fromMs,
        endTime: toMs,
        limit: 1000
      },
      timeout: 10000
    });

    const rawCandles = Array.isArray(response.data) ? response.data : [];
    return rawCandles.map(kline => ({
      time: Math.floor((Number(kline[0]) || 0) / 1000),
      open: Number(kline[1]) || 0,
      high: Number(kline[2]) || 0,
      low: Number(kline[3]) || 0,
      close: Number(kline[4]) || 0,
      volume: Number(kline[5]) || 0
    })).filter(candle => candle.time > 0);
  }

  async fetchCoinbaseCandles({ symbol, resolution, fromMs, toMs }) {
    const { coinbaseProductId } = this.resolveSymbols(symbol);
    const granularity = RESOLUTION_TO_COINBASE_GRANULARITY[resolution] || 86400;
    const response = await axios.get(`${COINBASE_BASE_URL}/products/${coinbaseProductId}/candles`, {
      params: {
        start: new Date(fromMs).toISOString(),
        end: new Date(toMs).toISOString(),
        granularity
      },
      timeout: 10000
    });

    const rawCandles = Array.isArray(response.data) ? response.data : [];
    return rawCandles.map(candle => ({
      time: Number(candle[0]) || 0,
      low: Number(candle[1]) || 0,
      high: Number(candle[2]) || 0,
      open: Number(candle[3]) || 0,
      close: Number(candle[4]) || 0,
      volume: Number(candle[5]) || 0
    }))
      .filter(candle => candle.time > 0)
      .sort((left, right) => left.time - right.time);
  }
}

module.exports = new CryptoMarketDataService();
