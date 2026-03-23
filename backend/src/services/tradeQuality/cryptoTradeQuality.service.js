const TradeQualitySharedService = require('./tradeQualityShared.service');
const cryptoMarketDataOrchestrator = require('./cryptoMarketDataOrchestrator.service');

class CryptoTradeQualityService extends TradeQualitySharedService {
  async calculateQuality(symbol, entryTime, entryPrice, side = 'long', userId = null, newsSentiment = null, instrumentType = null) {
    const qualityWeights = await this.getUserQualityWeights(userId);

    try {
      const fusedData = await cryptoMarketDataOrchestrator.getFusedMarketData(
        symbol,
        entryTime,
        userId
      );

      const trendDeviationPct = fusedData.canonicalSma30
        ? ((entryPrice - fusedData.canonicalSma30) / Math.max(Math.abs(fusedData.canonicalSma30), 1e-9)) * 100
        : fusedData.trendDeviationPct;
      const momentumPct = fusedData.canonicalPrevClose
        ? ((entryPrice - fusedData.canonicalPrevClose) / Math.max(Math.abs(fusedData.canonicalPrevClose), 1e-9)) * 100
        : fusedData.momentumPct;
      const relativeVolumeRatio = fusedData.relativeVolumeRatio;
      const dailyRangePct = fusedData.dailyRangePct;
      const liquidityUsd = fusedData.liquidityUsd;

      const metricScores = {
        trendAlignment: this.scoreCryptoTrendAlignmentByDeviation(trendDeviationPct, side),
        momentum: this.scoreCryptoMomentum(momentumPct, side),
        relativeVolume: this.scoreCryptoRelativeVolume(relativeVolumeRatio),
        liquidity: this.scoreCryptoLiquidity(liquidityUsd),
        volatility: this.scoreCryptoVolatility(dailyRangePct)
      };

      const breakdown = this.buildCryptoBreakdown({
        weights: qualityWeights,
        metrics: metricScores,
        trendDeviationPct,
        momentumPct,
        relativeVolumeRatio,
        liquidityUsd,
        dailyRangePct
      });
      const weightedScore = this.calculateWeightedScoreFromBreakdown(breakdown);

      return {
        grade: this.scoreToGrade(weightedScore),
        score: Math.round(weightedScore * 10) / 10,
        metrics: {
          model: 'crypto',
          instrumentType: instrumentType || 'crypto',
          sourceCalculationStatus: fusedData.sourceCalculationStatus,
          confidenceScore: fusedData.confidenceScore,
          sourceSummary: fusedData.sourceSummary,
          warnings: fusedData.warnings,
          sourceAgreement: fusedData.sourceAgreement,
          trendAlignment: trendDeviationPct,
          trendAlignmentScore: metricScores.trendAlignment,
          momentum: momentumPct,
          momentumScore: metricScores.momentum,
          relativeVolume: relativeVolumeRatio,
          relativeVolumeScore: metricScores.relativeVolume,
          liquidityUsd,
          liquidityScore: metricScores.liquidity,
          volatilityPct: dailyRangePct,
          volatilityScore: metricScores.volatility,
          breakdown
        }
      };
    } catch (error) {
      console.error(`[QUALITY] Error calculating crypto quality for ${symbol}:`, error.message);
      const fallbackWeights = this.getDefaultWeights();
      const fallbackMetrics = {
        trendAlignment: 0.5,
        momentum: 0.5,
        relativeVolume: 0.5,
        liquidity: 0.5,
        volatility: 0.5
      };

      return {
        grade: 'C',
        score: 3.0,
        metrics: {
          model: 'crypto',
          instrumentType: instrumentType || 'crypto',
          sourceCalculationStatus: 'poor_source_calculation',
          confidenceScore: 0.05,
          sourceSummary: {
            requested: ['binance', 'coinbase'],
            succeeded: [],
            failed: [
              { source: 'binance', reason: 'request_failed' },
              { source: 'coinbase', reason: 'request_failed' }
            ],
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
          },
          warnings: [
            'Poor source calculation: no crypto market data provider returned usable data for this trade.'
          ],
          sourceAgreement: {
            score: null,
            status: 'unavailable',
            details: []
          },
          trendAlignment: null,
          trendAlignmentScore: 0.5,
          momentum: null,
          momentumScore: 0.5,
          relativeVolume: null,
          relativeVolumeScore: 0.5,
          liquidityUsd: null,
          liquidityScore: 0.5,
          volatilityPct: null,
          volatilityScore: 0.5,
          breakdown: this.buildCryptoBreakdown({
            weights: fallbackWeights,
            metrics: fallbackMetrics,
            trendDeviationPct: null,
            momentumPct: null,
            relativeVolumeRatio: null,
            liquidityUsd: null,
            dailyRangePct: null
          })
        }
      };
    }
  }

  scoreCryptoTrendAlignmentByDeviation(trendDeviationPct, side = 'long') {
    if (trendDeviationPct === null || trendDeviationPct === undefined) return 0.5;

    const directionalDeviation = side?.toLowerCase() === 'short'
      ? -trendDeviationPct
      : trendDeviationPct;

    if (directionalDeviation >= 2 && directionalDeviation <= 15) return 1.0;
    if (directionalDeviation >= 0.5 && directionalDeviation < 2) return 0.75;
    if (directionalDeviation > 15 && directionalDeviation <= 25) return 0.6;
    if (directionalDeviation >= -2 && directionalDeviation < 0.5) return 0.45;
    return 0.2;
  }

  scoreCryptoTrendAlignment(entryPrice, sma7, sma30, side = 'long') {
    if (!entryPrice || !sma7 || !sma30) return 0.5;

    const isShort = side?.toLowerCase() === 'short';
    const aboveFast = entryPrice >= sma7;
    const aboveSlow = entryPrice >= sma30;

    if (!isShort) {
      if (aboveFast && aboveSlow) return 1.0;
      if (aboveSlow) return 0.75;
      if (aboveFast) return 0.55;
      return 0.2;
    }

    if (!aboveFast && !aboveSlow) return 1.0;
    if (!aboveSlow) return 0.75;
    if (!aboveFast) return 0.55;
    return 0.2;
  }

  scoreCryptoMomentum(momentumPct, side = 'long') {
    if (momentumPct === null || momentumPct === undefined) return 0.5;
    const directionalMove = side?.toLowerCase() === 'short' ? -momentumPct : momentumPct;

    if (directionalMove >= 1 && directionalMove <= 8) return 1.0;
    if (directionalMove >= 0 && directionalMove < 1) return 0.75;
    if (directionalMove > 8 && directionalMove <= 15) return 0.7;
    if (directionalMove >= -2 && directionalMove < 0) return 0.45;
    if (directionalMove > 15) return 0.4;
    return 0.2;
  }

  scoreCryptoRelativeVolume(relativeVolume) {
    if (!relativeVolume || relativeVolume <= 0) return 0.5;
    if (relativeVolume >= 3.0) return 1.0;
    if (relativeVolume >= 2.0) return 0.8;
    if (relativeVolume >= 1.2) return 0.65;
    if (relativeVolume >= 0.8) return 0.5;
    if (relativeVolume >= 0.5) return 0.35;
    return 0.2;
  }

  scoreCryptoLiquidity(liquidityUsd) {
    if (!liquidityUsd || liquidityUsd <= 0) return 0.5;
    if (liquidityUsd >= 500000000) return 1.0;
    if (liquidityUsd >= 100000000) return 0.8;
    if (liquidityUsd >= 25000000) return 0.6;
    if (liquidityUsd >= 5000000) return 0.4;
    if (liquidityUsd >= 1000000) return 0.25;
    return 0.1;
  }

  scoreCryptoVolatility(rangePct) {
    if (rangePct === null || rangePct === undefined) return 0.5;
    if (rangePct >= 2 && rangePct <= 12) return 1.0;
    if (rangePct >= 1 && rangePct < 2) return 0.7;
    if (rangePct > 12 && rangePct <= 18) return 0.6;
    if (rangePct > 18 && rangePct <= 30) return 0.35;
    return 0.2;
  }
}

module.exports = new CryptoTradeQualityService();
