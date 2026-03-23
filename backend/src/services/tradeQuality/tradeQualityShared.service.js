const db = require('../../config/database');

class TradeQualitySharedService {
  async getUserQualityWeights(userId) {
    try {
      const defaultWeights = this.getDefaultWeights();

      if (!userId) {
        console.log('[QUALITY] No userId provided, using default weights');
        return defaultWeights;
      }

      const query = `
        SELECT
          quality_weight_news,
          quality_weight_gap,
          quality_weight_relative_volume,
          quality_weight_float,
          quality_weight_price_range
        FROM users
        WHERE id = $1
      `;

      const result = await db.query(query, [userId]);
      if (!result.rows || result.rows.length === 0) {
        console.log(`[QUALITY] User ${userId} not found, using default weights`);
        return defaultWeights;
      }

      const userWeights = result.rows[0];
      return {
        newsSentiment: (userWeights.quality_weight_news || 30) / 100,
        gap: (userWeights.quality_weight_gap || 20) / 100,
        relativeVolume: (userWeights.quality_weight_relative_volume || 20) / 100,
        float: (userWeights.quality_weight_float || 15) / 100,
        priceRange: (userWeights.quality_weight_price_range || 15) / 100
      };
    } catch (error) {
      console.error('[QUALITY] Error fetching user quality weights:', error.message);
      return this.getDefaultWeights();
    }
  }

  getDefaultWeights() {
    return {
      newsSentiment: 0.30,
      gap: 0.20,
      relativeVolume: 0.20,
      float: 0.15,
      priceRange: 0.15
    };
  }

  async retryWithBackoff(apiCall, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error) {
        const is429 = error.response?.status === 429 ||
          error.message?.includes('429') ||
          error.message?.includes('rate limit');

        if (attempt === maxRetries || !is429) {
          throw error;
        }

        const delay = Math.pow(2, attempt) * 1000;
        console.log(`[QUALITY] Rate limit hit (attempt ${attempt + 1}/${maxRetries + 1}), waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  convertCategoricalSentiment(sentiment) {
    if (!sentiment) return null;

    switch (String(sentiment).toLowerCase()) {
      case 'positive':
        return 0.7;
      case 'negative':
        return -0.7;
      case 'neutral':
      case 'mixed':
        return 0.0;
      default:
        console.log(`[QUALITY] Unknown sentiment value: ${sentiment}, treating as neutral`);
        return 0.0;
    }
  }

  calculateWeightedScore(metrics, weights = null) {
    const finalWeights = weights || this.getDefaultWeights();
    const score =
      metrics.newsSentiment * finalWeights.newsSentiment +
      metrics.float * finalWeights.float +
      metrics.relativeVolume * finalWeights.relativeVolume +
      metrics.priceRange * finalWeights.priceRange +
      metrics.gap * finalWeights.gap;

    return score * 5;
  }

  calculateWeightedScoreFromBreakdown(breakdown = []) {
    const weightedSum = breakdown.reduce((sum, item) => {
      return sum + ((Number(item.score) || 0) * (Number(item.weight) || 0));
    }, 0);

    return weightedSum * 5;
  }

  scoreToGrade(score) {
    if (score >= 4.5) return 'A';
    if (score >= 3.5) return 'B';
    if (score >= 2.5) return 'C';
    if (score >= 1.5) return 'D';
    return 'F';
  }

  buildMetricBreakdownItem({ key, label, weight, score, value, format, subtitle }) {
    return {
      key,
      label,
      weight,
      score,
      value,
      format,
      subtitle: subtitle || `Weight: ${Math.round((weight || 0) * 100)}%`
    };
  }

  buildStockBreakdown({ weights, metrics, sharesOutstanding, relativeVolumeRatio, entryPrice, gap, sentiment }) {
    return [
      this.buildMetricBreakdownItem({
        key: 'newsSentiment',
        label: 'News Sentiment',
        weight: weights.newsSentiment,
        score: metrics.newsSentiment,
        value: sentiment?.sentiment ?? null,
        format: 'number_2',
        subtitle: `Weight: ${Math.round(weights.newsSentiment * 100)}% (Highest)`
      }),
      this.buildMetricBreakdownItem({
        key: 'gap',
        label: 'Gap from Previous Close',
        weight: weights.gap,
        score: metrics.gap,
        value: gap,
        format: 'signed_percent_2',
        subtitle: `Weight: ${Math.round(weights.gap * 100)}% (Previous close to entry price)`
      }),
      this.buildMetricBreakdownItem({
        key: 'relativeVolume',
        label: 'Relative Volume',
        weight: weights.relativeVolume,
        score: metrics.relativeVolume,
        value: relativeVolumeRatio,
        format: 'multiple_1'
      }),
      this.buildMetricBreakdownItem({
        key: 'float',
        label: 'Float (Shares Outstanding)',
        weight: weights.float,
        score: metrics.float,
        value: sharesOutstanding,
        format: 'millions_2'
      }),
      this.buildMetricBreakdownItem({
        key: 'price',
        label: 'Price Range',
        weight: weights.priceRange,
        score: metrics.priceRange,
        value: entryPrice,
        format: 'currency_2'
      })
    ];
  }

  buildCryptoBreakdown({ weights, metrics, trendDeviationPct, momentumPct, relativeVolumeRatio, liquidityUsd, dailyRangePct }) {
    return [
      this.buildMetricBreakdownItem({
        key: 'trendAlignment',
        label: 'Trend Alignment',
        weight: weights.newsSentiment,
        score: metrics.trendAlignment,
        value: trendDeviationPct,
        format: 'signed_percent_2',
        subtitle: `Weight: ${Math.round(weights.newsSentiment * 100)}% (Entry vs 30D trend)`
      }),
      this.buildMetricBreakdownItem({
        key: 'momentum',
        label: '24h Momentum',
        weight: weights.gap,
        score: metrics.momentum,
        value: momentumPct,
        format: 'signed_percent_2',
        subtitle: `Weight: ${Math.round(weights.gap * 100)}% (Previous close to entry)`
      }),
      this.buildMetricBreakdownItem({
        key: 'relativeVolume',
        label: 'Relative Volume',
        weight: weights.relativeVolume,
        score: metrics.relativeVolume,
        value: relativeVolumeRatio,
        format: 'multiple_1',
        subtitle: `Weight: ${Math.round(weights.relativeVolume * 100)}% (vs 7-day average)`
      }),
      this.buildMetricBreakdownItem({
        key: 'liquidity',
        label: 'Dollar Liquidity',
        weight: weights.float,
        score: metrics.liquidity,
        value: liquidityUsd,
        format: 'currency_compact',
        subtitle: `Weight: ${Math.round(weights.float * 100)}% (Daily dollar volume)`
      }),
      this.buildMetricBreakdownItem({
        key: 'volatility',
        label: 'Daily Volatility',
        weight: weights.priceRange,
        score: metrics.volatility,
        value: dailyRangePct,
        format: 'unsigned_percent_2',
        subtitle: `Weight: ${Math.round(weights.priceRange * 100)}% (High-low range)`
      })
    ];
  }

  normalizeCandleSeries(candles) {
    if (!candles || !Array.isArray(candles.t)) {
      return [];
    }

    return candles.t.map((time, index) => ({
      time: Number(time) || 0,
      open: Number(candles.o?.[index]) || 0,
      high: Number(candles.h?.[index]) || 0,
      low: Number(candles.l?.[index]) || 0,
      close: Number(candles.c?.[index]) || 0,
      volume: Number(candles.v?.[index]) || 0
    })).filter(candle => candle.time > 0);
  }

  calculateSimpleMovingAverage(values = [], period = 0) {
    if (!Array.isArray(values) || values.length < period || period <= 0) {
      return null;
    }

    const window = values.slice(-period).map(value => Number(value) || 0);
    return this.calculateAverage(window);
  }

  calculateAverage(values = []) {
    if (!Array.isArray(values) || values.length === 0) {
      return null;
    }

    const sum = values.reduce((total, value) => total + (Number(value) || 0), 0);
    return sum / values.length;
  }
}

module.exports = TradeQualitySharedService;
