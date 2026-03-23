const TradeQualitySharedService = require('./tradeQualityShared.service');
const cryptoMarketDataService = require('../cryptoMarketData.service');

class CryptoMarketDataOrchestratorService extends TradeQualitySharedService {
  constructor() {
    super();
  }

  async getFusedMarketData(symbol, entryTime, userId = null) {
    const range = this.buildDateRange(entryTime, 40);

    const requestedSources = ['binance', 'coinbase'];
    const settled = await Promise.allSettled([
      this.fetchBinanceMarketData(symbol, range),
      this.fetchCoinbaseMarketData(symbol, range)
    ]);

    const sourceResults = {
      binance: this.unwrapSourceResult('binance', settled[0]),
      coinbase: this.unwrapSourceResult('coinbase', settled[1])
    };

    const requested = requestedSources;
    const succeeded = requested.filter(source => sourceResults[source].success);
    const failed = requested
      .filter(source => !sourceResults[source].success)
      .map(source => ({
        source,
        reason: sourceResults[source].reason || 'request_failed'
      }));

    const canonical = this.selectCanonicalSource(sourceResults);
    if (!canonical) {
      return this.buildUnavailableResult(requested, failed);
    }

    const agreement = this.calculateSourceAgreement(sourceResults, canonical.source);
    const fusedMetrics = this.fuseMetrics(sourceResults, canonical.source, agreement);
    const status = this.determineCalculationStatus({
      succeededCount: succeeded.length,
      requestedCount: requested.length,
      agreementScore: agreement.score,
      missingFieldCount: fusedMetrics.missingFieldCount
    });
    const confidenceScore = this.calculateConfidenceScore({
      succeededCount: succeeded.length,
      requestedCount: requested.length,
      agreementScore: agreement.score,
      missingFieldCount: fusedMetrics.missingFieldCount,
      fallbackUsed: canonical.source !== 'binance'
    });

    return {
      success: true,
      requested,
      succeeded,
      failed,
      canonicalSource: canonical.source,
      sourceAgreement: agreement,
      sourceCalculationStatus: status,
      confidenceScore,
      warnings: this.buildWarnings({
        status,
        failed,
        agreement,
        canonicalSource: canonical.source
      }),
      fieldUsage: fusedMetrics.fieldUsage,
      ...fusedMetrics.values
    };
  }

  buildDateRange(entryTime, lookbackDays = 40) {
    const entryDate = new Date(entryTime);
    const startDate = new Date(entryDate);
    startDate.setDate(startDate.getDate() - lookbackDays);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(entryDate);
    endDate.setHours(23, 59, 59, 999);

    return {
      fromMs: startDate.getTime(),
      toMs: endDate.getTime(),
      fromSeconds: Math.floor(startDate.getTime() / 1000),
      toSeconds: Math.floor(endDate.getTime() / 1000)
    };
  }

  unwrapSourceResult(source, settledResult) {
    if (settledResult.status === 'fulfilled') {
      return {
        success: true,
        source,
        ...settledResult.value
      };
    }

    const reason = this.normalizeFailureReason(settledResult.reason);
    return {
      success: false,
      source,
      reason
    };
  }

  normalizeFailureReason(error) {
    const status = error?.response?.status;
    if (status === 429) return 'rate_limited';
    if (status === 404) return 'not_found';
    if (status && status >= 500) return 'upstream_server_error';
    if (error?.code === 'ECONNABORTED') return 'timeout';
    return error?.message || 'request_failed';
  }

  async fetchBinanceMarketData(symbol, range) {
    const result = await cryptoMarketDataService.getCandles({
      symbol,
      interval: '1d',
      fromMs: range.fromMs,
      toMs: range.toMs,
      source: 'binance'
    });
    const candles = Array.isArray(result.candles) ? result.candles : [];
    if (candles.length < 8) {
      throw new Error(`Insufficient Binance candles for ${symbol}`);
    }

    return this.buildSourceMetrics('binance', candles);
  }

  async fetchCoinbaseMarketData(symbol, range) {
    const result = await cryptoMarketDataService.getCandles({
      symbol,
      interval: '1d',
      fromMs: range.fromMs,
      toMs: range.toMs,
      source: 'coinbase'
    });
    const candles = Array.isArray(result.candles) ? result.candles : [];
    if (candles.length < 8) {
      throw new Error(`Insufficient Coinbase candles for ${symbol}`);
    }

    return this.buildSourceMetrics('coinbase', candles);
  }

  buildSourceMetrics(source, candles) {
    const entryCandle = candles[candles.length - 1];
    const history = candles.slice(0, -1);
    const previousCandle = history[history.length - 1] || null;
    const prevClose = previousCandle?.close || null;
    const sma7 = this.calculateSimpleMovingAverage(history.map(candle => candle.close), 7);
    const sma30 = this.calculateSimpleMovingAverage(history.map(candle => candle.close), 30);
    const avgVolume7 = this.calculateAverage(history.slice(-7).map(candle => candle.volume));
    const dailyRangePct = entryCandle.open
      ? ((entryCandle.high - entryCandle.low) / entryCandle.open) * 100
      : null;
    const quoteVolume = entryCandle.quoteVolume ?? (entryCandle.close && entryCandle.volume
      ? entryCandle.close * entryCandle.volume
      : null);

    return {
      source,
      candles,
      history,
      entryCandle,
      prevClose,
      sma7,
      sma30,
      avgVolume7,
      dailyRangePct,
      liquidityUsd: quoteVolume,
      tradeCount: entryCandle.tradeCount ?? null
    };
  }

  selectCanonicalSource(sourceResults) {
    if (sourceResults.binance.success) {
      return sourceResults.binance;
    }

    if (sourceResults.coinbase.success) {
      return sourceResults.coinbase;
    }

    return null;
  }

  calculateSourceAgreement(sourceResults, canonicalSource) {
    const comparableSources = Object.values(sourceResults).filter(result => result.success);
    if (comparableSources.length < 2) {
      return {
        score: null,
        status: 'single_source',
        details: []
      };
    }

    const primary = sourceResults[canonicalSource];
    const secondary = comparableSources.find(result => result.source !== canonicalSource);
    if (!primary || !secondary) {
      return {
        score: null,
        status: 'single_source',
        details: []
      };
    }

    const comparisons = [
      this.buildAgreementDetail('close', primary.entryCandle?.close, secondary.entryCandle?.close, 0.01),
      this.buildAgreementDetail('rangePct', primary.dailyRangePct, secondary.dailyRangePct, 0.25),
      this.buildAgreementDetail('prevClose', primary.prevClose, secondary.prevClose, 0.015)
    ].filter(Boolean);

    if (comparisons.length === 0) {
      return {
        score: null,
        status: 'single_source',
        details: []
      };
    }

    const score = this.calculateAverage(comparisons.map(item => item.score));
    let status = 'aligned';
    if (score < 0.55) status = 'divergent';
    else if (score < 0.8) status = 'mixed';

    return {
      score,
      status,
      details: comparisons
    };
  }

  buildAgreementDetail(key, leftValue, rightValue, tolerance = 0.05) {
    if (
      leftValue === null || leftValue === undefined ||
      rightValue === null || rightValue === undefined
    ) {
      return null;
    }

    const base = Math.max(Math.abs(Number(leftValue)) || 0, Math.abs(Number(rightValue)) || 0, 1e-9);
    const relativeDiff = Math.abs(Number(leftValue) - Number(rightValue)) / base;
    const score = Math.max(0, 1 - (relativeDiff / tolerance));

    return {
      key,
      relativeDiff,
      score: Math.min(1, score)
    };
  }

  fuseMetrics(sourceResults, canonicalSource, agreement) {
    const canonical = sourceResults[canonicalSource];
    const secondary = Object.values(sourceResults).find(result => result.success && result.source !== canonicalSource) || null;

    const momentumPct = canonical.prevClose
      ? ((canonical.entryCandle.close - canonical.prevClose) / canonical.prevClose) * 100
      : null;
    const relativeVolumeRatio = canonical.avgVolume7 && canonical.entryCandle.volume
      ? canonical.entryCandle.volume / canonical.avgVolume7
      : null;
    const trendDeviationPct = canonical.sma30
      ? ((canonical.entryCandle.close - canonical.sma30) / canonical.sma30) * 100
      : null;

    const liquidityAggregation = this.aggregateNumericField({
      primaryValue: canonical.liquidityUsd,
      primarySource: canonical.source,
      secondaryValue: secondary?.liquidityUsd,
      secondarySource: secondary?.source,
      allowAggregation: true,
      maxRelativeSpreadForAggregation: 0.45
    });

    const volatilityAggregation = this.aggregateNumericField({
      primaryValue: canonical.dailyRangePct,
      primarySource: canonical.source,
      secondaryValue: secondary?.dailyRangePct,
      secondarySource: secondary?.source,
      allowAggregation: agreement.score !== null && agreement.score >= 0.75,
      maxRelativeSpreadForAggregation: 0.2
    });

    const missingFieldCount = [
      trendDeviationPct,
      momentumPct,
      relativeVolumeRatio,
      liquidityAggregation.value,
      volatilityAggregation.value
    ].filter(value => value === null || value === undefined).length;

    return {
      missingFieldCount,
      fieldUsage: {
        ohlcv: canonical.source,
        trendAlignment: canonical.source,
        momentum: canonical.source,
        relativeVolume: canonical.source,
        liquidity: liquidityAggregation.strategy,
        volatility: volatilityAggregation.strategy
      },
      values: {
        trendDeviationPct,
        momentumPct,
        relativeVolumeRatio,
        liquidityUsd: liquidityAggregation.value,
        dailyRangePct: volatilityAggregation.value,
        canonicalEntryPrice: canonical.entryCandle.close,
        canonicalPrevClose: canonical.prevClose,
        canonicalSma30: canonical.sma30,
        sourceSummary: {
          requested: Object.keys(sourceResults),
          succeeded: Object.values(sourceResults).filter(result => result.success).map(result => result.source),
          failed: Object.values(sourceResults)
            .filter(result => !result.success)
            .map(result => ({ source: result.source, reason: result.reason })),
          fieldUsage: {
            ohlcv: canonical.source,
            trendAlignment: canonical.source,
            momentum: canonical.source,
            relativeVolume: canonical.source,
            liquidity: liquidityAggregation.strategy,
            volatility: volatilityAggregation.strategy
          },
          agreementScore: agreement.score,
          canonicalSource: canonical.source
        }
      }
    };
  }

  aggregateNumericField({
    primaryValue,
    primarySource,
    secondaryValue = null,
    secondarySource = null,
    allowAggregation = false,
    maxRelativeSpreadForAggregation = 0.25
  }) {
    if (primaryValue === null || primaryValue === undefined) {
      if (secondaryValue === null || secondaryValue === undefined) {
        return { value: null, strategy: 'missing' };
      }

      return { value: secondaryValue, strategy: secondarySource || 'secondary' };
    }

    if (secondaryValue === null || secondaryValue === undefined) {
      return { value: primaryValue, strategy: primarySource };
    }

    const base = Math.max(Math.abs(Number(primaryValue)) || 0, Math.abs(Number(secondaryValue)) || 0, 1e-9);
    const relativeSpread = Math.abs(Number(primaryValue) - Number(secondaryValue)) / base;

    if (allowAggregation && relativeSpread <= maxRelativeSpreadForAggregation) {
      return {
        value: (Number(primaryValue) + Number(secondaryValue)) / 2,
        strategy: 'aggregated'
      };
    }

    return { value: primaryValue, strategy: primarySource };
  }

  determineCalculationStatus({ succeededCount, requestedCount, agreementScore, missingFieldCount }) {
    if (succeededCount === 0) {
      return 'poor_source_calculation';
    }

    if (succeededCount < requestedCount) {
      return succeededCount === 1 ? 'partial_source_calculation' : 'poor_source_calculation';
    }

    if (missingFieldCount > 1) {
      return 'partial_source_calculation';
    }

    if (agreementScore !== null && agreementScore < 0.55) {
      return 'poor_source_calculation';
    }

    if (agreementScore !== null && agreementScore < 0.8) {
      return 'partial_source_calculation';
    }

    return 'full_source_calculation';
  }

  calculateConfidenceScore({ succeededCount, requestedCount, agreementScore, missingFieldCount, fallbackUsed = false }) {
    let score = requestedCount > 0 ? succeededCount / requestedCount : 0;

    if (agreementScore !== null) {
      score = (score * 0.6) + (agreementScore * 0.4);
    }

    score -= Math.min(0.25, missingFieldCount * 0.06);

    if (fallbackUsed) {
      score -= 0.08;
    }

    return Math.max(0.05, Math.min(1, score));
  }

  buildWarnings({ status, failed, agreement, canonicalSource }) {
    const warnings = [];

    if (failed.length > 0) {
      warnings.push('Some upstream crypto market data providers had request issues. The score uses the remaining verified data.');
    }

    if (canonicalSource !== 'binance') {
      warnings.push('Primary Binance market data was unavailable, so crypto quality used fallback source data.');
    }

    if (agreement.status === 'divergent') {
      warnings.push('Crypto data sources showed meaningful differences, so confidence in the score has been reduced.');
    }

    if (status === 'poor_source_calculation') {
      warnings.push('Poor source calculation: multiple service issues or low source agreement reduced score reliability.');
    }

    return warnings;
  }

  buildUnavailableResult(requested, failed) {
    return {
      success: false,
      requested,
      succeeded: [],
      failed,
      canonicalSource: null,
      sourceAgreement: {
        score: null,
        status: 'unavailable',
        details: []
      },
      sourceCalculationStatus: 'poor_source_calculation',
      confidenceScore: 0.05,
      warnings: [
        'Poor source calculation: no crypto market data provider returned usable data for this trade.'
      ],
      fieldUsage: {
        ohlcv: 'missing',
        trendAlignment: 'missing',
        momentum: 'missing',
        relativeVolume: 'missing',
        liquidity: 'missing',
        volatility: 'missing'
      },
      trendDeviationPct: null,
      momentumPct: null,
      relativeVolumeRatio: null,
      liquidityUsd: null,
      dailyRangePct: null,
      canonicalEntryPrice: null,
      canonicalPrevClose: null,
      canonicalSma30: null,
      sourceSummary: {
        requested,
        succeeded: [],
        failed,
        fieldUsage: {
          ohlcv: 'missing',
          trendAlignment: 'missing',
          momentum: 'missing',
          relativeVolume: 'missing',
          liquidity: 'missing',
          volatility: 'missing'
        },
        agreementScore: null,
        canonicalSource: null
      }
    };
  }
}

module.exports = new CryptoMarketDataOrchestratorService();
