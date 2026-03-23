const TierService = require('./tierService');
const finnhub = require('../utils/finnhub');
const alphaVantage = require('../utils/alphaVantage');
const cryptoMarketDataService = require('./cryptoMarketData.service');

class ChartService {
  static resolveCryptoChartSources(symbol) {
    return cryptoMarketDataService.resolveSymbols(symbol);
  }

  static getCryptoChartConfig(entryDate, exitDate = null) {
    const entryTime = new Date(entryDate);
    const rawExitTime = exitDate ? new Date(exitDate) : new Date();
    const exitTime = rawExitTime > entryTime ? rawExitTime : new Date(entryTime.getTime() + (5 * 60 * 1000));
    const durationMs = Math.max(60 * 1000, exitTime - entryTime);
    const oneHourMs = 60 * 60 * 1000;
    const oneDayMs = 24 * oneHourMs;

    if (durationMs <= oneHourMs) {
      return {
        interval: '1m',
        coinbaseGranularity: 60,
        type: 'intraday',
        chartFromTime: new Date(entryTime.getTime() - (60 * 60 * 1000)),
        chartToTime: new Date(exitTime.getTime() + (60 * 60 * 1000))
      };
    }

    if (durationMs <= oneDayMs) {
      return {
        interval: '5m',
        coinbaseGranularity: 300,
        type: 'intraday',
        chartFromTime: new Date(entryTime.getTime() - (6 * oneHourMs)),
        chartToTime: new Date(exitTime.getTime() + (6 * oneHourMs))
      };
    }

    if (durationMs <= 7 * oneDayMs) {
      return {
        interval: '15m',
        coinbaseGranularity: 900,
        type: 'intraday',
        chartFromTime: new Date(entryTime.getTime() - oneDayMs),
        chartToTime: new Date(exitTime.getTime() + oneDayMs)
      };
    }

    if (durationMs <= 30 * oneDayMs) {
      return {
        interval: '1h',
        coinbaseGranularity: 3600,
        type: 'intraday',
        chartFromTime: new Date(entryTime.getTime() - (2 * oneDayMs)),
        chartToTime: new Date(exitTime.getTime() + (2 * oneDayMs))
      };
    }

    return {
      interval: '1d',
      coinbaseGranularity: 86400,
      type: 'daily',
      chartFromTime: new Date(entryTime.getTime() - (3 * oneDayMs)),
      chartToTime: new Date(exitTime.getTime() + (3 * oneDayMs))
    };
  }

  // Get crypto chart data from Binance with Coinbase fallback
  static async getCryptoTradeChartData(symbol, entryDate, exitDate = null) {
    const sources = this.resolveCryptoChartSources(symbol);
    const config = this.getCryptoChartConfig(entryDate, exitDate);

    console.log(`[CRYPTO-CHART] Fetching ${config.interval} chart for ${sources.symbolUpper} via Binance (${sources.binanceSymbol}) with Coinbase fallback (${sources.coinbaseProductId})`);

    try {
      const result = await cryptoMarketDataService.getCandles({
        symbol,
        interval: config.interval,
        fromMs: config.chartFromTime.getTime(),
        toMs: config.chartToTime.getTime(),
        source: 'binance'
      });
      const candles = result.candles;
      console.log(`[CRYPTO-CHART] Got ${candles.length} ${config.interval} candles for ${sources.symbolUpper} from Binance`);

      return {
        type: config.type,
        interval: config.interval === '1d' ? 'daily' : config.interval,
        candles,
        source: 'binance'
      };
    } catch (binanceError) {
      console.warn(`[CRYPTO-CHART] Binance failed for ${sources.symbolUpper}: ${binanceError.message}`);

      try {
        const result = await cryptoMarketDataService.getCandles({
          symbol,
          interval: config.interval,
          fromMs: config.chartFromTime.getTime(),
          toMs: config.chartToTime.getTime(),
          source: 'coinbase'
        });
        const candles = result.candles;
        console.log(`[CRYPTO-CHART] Got ${candles.length} ${config.interval} candles for ${sources.symbolUpper} from Coinbase`);

        return {
          type: config.type,
          interval: config.interval === '1d' ? 'daily' : config.interval,
          candles,
          source: 'coinbase',
          fallback: true,
          fallbackReason: 'Binance unavailable'
        };
      } catch (coinbaseError) {
        console.error(`[CRYPTO-CHART] Coinbase fallback failed for ${sources.symbolUpper}: ${coinbaseError.message}`);
        throw new Error(`Crypto chart data unavailable for ${sources.symbolUpper}. Binance and Coinbase both failed.`);
      }
    }
  }

  // Get chart data for a trade
  // When billing is enabled (tradetally.io): Finnhub only, Pro users only
  // When billing is disabled (self-hosted): Finnhub preferred, Alpha Vantage fallback, all users
  static async getTradeChartData(userId, symbol, entryDate, exitDate = null, hostHeader = null) {
    try {
      // Crypto symbols and pairs use exchange-native crypto chart providers
      if (finnhub.isCryptoSymbol(symbol) || finnhub.isCryptoPairSymbol(symbol)) {
        console.log(`[CHART] ${symbol} is crypto, using Binance with Coinbase fallback`);
        return await ChartService.getCryptoTradeChartData(symbol, entryDate, exitDate);
      }

      // Check user tier and billing status
      const userTier = await TierService.getUserTier(userId, hostHeader);
      const isProUser = userTier === 'pro';
      const billingEnabled = await TierService.isBillingEnabled(hostHeader);

      console.log(`Getting chart data for user ${userId}, tier: ${userTier || 'free'}, symbol: ${symbol}, billingEnabled: ${billingEnabled}`);
      console.log('Chart data input:', { entryDate, exitDate });

      // When billing is enabled (tradetally.io): Charts are Pro-only, Finnhub only
      if (billingEnabled) {
        if (!isProUser) {
          const error = new Error('Trade charts are a Pro feature. Upgrade to Pro for high-precision candlestick charts.');
          error.statusCode = 403;
          throw error;
        }

        if (!finnhub.isConfigured()) {
          throw new Error('Chart service is not configured. Please contact support.');
        }

        console.log('Using Finnhub for Pro user chart data (billing enabled)');
        return await finnhub.getTradeChartData(symbol, entryDate, exitDate, userId);
      }

      // Self-hosted mode: Finnhub preferred with Alpha Vantage fallback
      if (isProUser && finnhub.isConfigured()) {
        console.log('Using Finnhub for chart data (self-hosted)');
        try {
          return await finnhub.getTradeChartData(symbol, entryDate, exitDate, userId);
        } catch (error) {
          console.warn(`Finnhub failed for symbol ${symbol}: ${error.message}`);

          // Fall back to Alpha Vantage if configured
          if (alphaVantage.isConfigured()) {
            console.warn(`Falling back to Alpha Vantage due to Finnhub failure (${error.message})`);
            try {
              const chartData = await alphaVantage.getTradeChartData(symbol, entryDate, exitDate);
              chartData.source = 'alphavantage';
              chartData.fallback = true;
              chartData.fallbackReason = 'Finnhub unavailable';
              return chartData;
            } catch (avError) {
              console.error(`Alpha Vantage fallback also failed for ${symbol}: ${avError.message}`);
              if (avError.message.includes('503') || avError.message.includes('timeout') || avError.message.includes('unavailable')) {
                throw new Error(`Chart services are temporarily unavailable. Please try again later.`);
              }
              throw new Error(`Chart data unavailable for ${symbol}. This symbol may be delisted, inactive, or not supported. Please try a different symbol like AAPL, MSFT, or GOOGL.`);
            }
          }

          throw new Error(`Chart data unavailable for ${symbol}. This symbol may be delisted, inactive, or not supported by Finnhub. Please try a different symbol like AAPL, MSFT, or GOOGL.`);
        }
      }

      // Self-hosted: Finnhub not configured, use Alpha Vantage
      if (alphaVantage.isConfigured()) {
        console.log('Using Alpha Vantage for chart data (self-hosted)');
        const chartData = await alphaVantage.getTradeChartData(symbol, entryDate, exitDate);
        chartData.source = 'alphavantage';
        return chartData;
      }

      // Neither service is configured
      throw new Error('No chart data provider is configured. Please configure either Finnhub or Alpha Vantage API keys.');

    } catch (error) {
      console.error(`Failed to get chart data for ${symbol}:`, error);
      throw error;
    }
  }
  
  // Get service availability status
  static async getServiceStatus(hostHeader = null) {
    const billingEnabled = await TierService.isBillingEnabled(hostHeader);
    const status = {
      finnhub: {
        configured: finnhub.isConfigured(),
        description: billingEnabled ? 'Finnhub API - Pro charts' : 'Finnhub API - Premium charts with intraday data'
      }
    };

    // Only expose Alpha Vantage status for self-hosted
    if (!billingEnabled) {
      status.alphaVantage = {
        configured: alphaVantage.isConfigured(),
        description: 'Alpha Vantage API - Daily chart data (self-hosted fallback)'
      };
    }

    return status;
  }

  // Get usage statistics for chart services
  static async getUsageStats(userId, hostHeader = null) {
    const userTier = await TierService.getUserTier(userId, hostHeader);
    const isProUser = userTier === 'pro';
    const billingEnabled = await TierService.isBillingEnabled(hostHeader);

    const stats = {
      userTier: userTier || 'free',
      preferredService: 'finnhub'
    };

    // Add Finnhub stats
    if (finnhub.isConfigured()) {
      stats.finnhub = {
        configured: true,
        rateLimitPerMinute: 150,
        rateLimitPerSecond: 30
      };
    }

    // Only include Alpha Vantage stats for self-hosted instances
    if (!billingEnabled && !isProUser && alphaVantage.isConfigured()) {
      stats.preferredService = 'alphavantage';
      try {
        stats.alphaVantage = await alphaVantage.getUsageStats();
      } catch (error) {
        console.warn('Failed to get Alpha Vantage usage stats:', error.message);
      }
    }

    return stats;
  }
}

module.exports = ChartService;
