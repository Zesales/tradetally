const axios = require('axios');
const TradeQualitySharedService = require('./tradeQualityShared.service');

class StockTradeQualityService extends TradeQualitySharedService {
  constructor() {
    super();
    this.finnhubApiKey = process.env.FINNHUB_API_KEY;
    this.baseUrl = 'https://finnhub.io/api/v1';
  }

  async calculateQuality(symbol, entryTime, entryPrice, side = 'long', userId = null, newsSentiment = null, instrumentType = null) {
    if (!this.finnhubApiKey) {
      console.log('[QUALITY] Finnhub API key not configured, skipping stock quality calculation');
      return null;
    }

    try {
      const sentimentScore = this.convertCategoricalSentiment(newsSentiment);
      const results = await Promise.allSettled([
        this.getUserQualityWeights(userId),
        this.getStockProfile(symbol),
        this.getQuote(symbol, entryTime),
        this.getBasicFinancials(symbol)
      ]);

      const weights = results[0].status === 'fulfilled' ? results[0].value : this.getDefaultWeights();
      const profile = results[1].status === 'fulfilled' ? results[1].value : null;
      const quote = results[2].status === 'fulfilled' ? results[2].value : null;
      const financials = results[3].status === 'fulfilled' ? results[3].value : null;
      const sentiment = sentimentScore !== null ? { sentiment: sentimentScore } : null;
      const sharesOutstanding = profile?.shareOutstanding || financials?.sharesOutstanding || null;
      const gap = (quote?.previousClose && entryPrice)
        ? ((entryPrice - quote.previousClose) / quote.previousClose) * 100
        : null;
      const metrics = {
        float: this.scoreFloat(sharesOutstanding),
        relativeVolume: this.scoreRelativeVolume(quote, financials?.avgVolume10Day),
        priceRange: this.scorePriceRange(entryPrice),
        gap: this.scoreGap(gap),
        newsSentiment: this.scoreNewsSentiment(sentiment, side)
      };
      const weightedScore = this.calculateWeightedScore(metrics, weights);
      const grade = this.scoreToGrade(weightedScore);
      const actualVolume = quote?.v || null;
      const avgVolume = financials?.avgVolume10Day || null;
      const relativeVolumeRatio = (actualVolume && avgVolume && avgVolume > 0)
        ? actualVolume / (avgVolume * 1000000)
        : null;
      const breakdown = this.buildStockBreakdown({
        weights,
        metrics,
        sharesOutstanding,
        relativeVolumeRatio,
        entryPrice,
        gap,
        sentiment
      });

      return {
        grade,
        score: Math.round(weightedScore * 10) / 10,
        metrics: {
          model: 'stock',
          instrumentType: instrumentType || 'stock',
          float: sharesOutstanding,
          floatScore: metrics.float,
          relativeVolume: relativeVolumeRatio,
          relativeVolumeScore: metrics.relativeVolume,
          price: entryPrice,
          priceScore: metrics.priceRange,
          gap,
          gapScore: metrics.gap,
          newsSentiment: sentiment?.sentiment || null,
          newsSentimentScore: metrics.newsSentiment,
          breakdown
        }
      };
    } catch (error) {
      console.error(`[QUALITY] Error calculating stock quality for ${symbol}:`, error.message);
      const fallbackWeights = this.getDefaultWeights();
      const fallbackMetrics = {
        float: 0,
        relativeVolume: 0.5,
        priceRange: 0.5,
        gap: 0.5,
        newsSentiment: 0.5
      };

      return {
        grade: 'C',
        score: 3.0,
        metrics: {
          model: 'stock',
          instrumentType: instrumentType || 'stock',
          float: null,
          floatScore: 0,
          relativeVolume: null,
          relativeVolumeScore: 0.5,
          price: entryPrice,
          priceScore: 0.5,
          gap: null,
          gapScore: 0.5,
          newsSentiment: null,
          newsSentimentScore: 0.5,
          breakdown: this.buildStockBreakdown({
            weights: fallbackWeights,
            metrics: fallbackMetrics,
            sharesOutstanding: null,
            relativeVolumeRatio: null,
            entryPrice,
            gap: null,
            sentiment: null
          })
        }
      };
    }
  }

  async getStockProfile(symbol) {
    try {
      const profileResponse = await this.retryWithBackoff(() =>
        axios.get(`${this.baseUrl}/stock/profile`, {
          params: { symbol, token: this.finnhubApiKey },
          timeout: 5000
        })
      );
      return profileResponse.data;
    } catch (error) {
      try {
        const profile2Response = await this.retryWithBackoff(() =>
          axios.get(`${this.baseUrl}/stock/profile2`, {
            params: { symbol, token: this.finnhubApiKey },
            timeout: 5000
          })
        );
        return profile2Response.data;
      } catch (fallbackError) {
        console.error(`[QUALITY] Both profile endpoints failed for ${symbol}:`, fallbackError.message);
        return null;
      }
    }
  }

  async getBasicFinancials(symbol) {
    try {
      const response = await this.retryWithBackoff(() =>
        axios.get(`${this.baseUrl}/stock/metric`, {
          params: { symbol, metric: 'all', token: this.finnhubApiKey },
          timeout: 5000
        })
      );

      const metrics = response.data?.metric || {};
      return {
        avgVolume10Day: metrics['10DayAverageTradingVolume'] || null,
        sharesOutstanding: metrics.sharesOutstanding || null
      };
    } catch (error) {
      console.error(`[QUALITY] Error fetching basic financials for ${symbol}:`, error.message);
      return null;
    }
  }

  async getQuote(symbol, entryTime) {
    try {
      const entryDate = new Date(entryTime);
      const startDate = new Date(entryDate);
      startDate.setDate(startDate.getDate() - 2);
      startDate.setHours(0, 0, 0, 0);

      const endDate = new Date(entryDate);
      endDate.setHours(23, 59, 59, 999);

      const response = await this.retryWithBackoff(() =>
        axios.get(`${this.baseUrl}/stock/candle`, {
          params: {
            symbol,
            resolution: 'D',
            from: Math.floor(startDate.getTime() / 1000),
            to: Math.floor(endDate.getTime() / 1000),
            token: this.finnhubApiKey
          },
          timeout: 5000
        })
      );

      const data = response.data;
      if (!data || data.s !== 'ok' || !data.o || data.o.length === 0) {
        return null;
      }

      const lastIndex = data.o.length - 1;
      return {
        o: data.o[lastIndex],
        h: data.h[lastIndex],
        l: data.l[lastIndex],
        c: data.c[lastIndex],
        v: data.v[lastIndex],
        previousClose: lastIndex > 0 ? data.c[lastIndex - 1] : null,
        relativeVolume: null
      };
    } catch (error) {
      console.error(`[QUALITY] Error fetching historical quote for ${symbol}:`, error.message);
      return null;
    }
  }

  scoreFloat(floatShares) {
    if (!floatShares) return 0;
    if (floatShares < 1) return 1.0;
    if (floatShares < 5) return 0.7;
    if (floatShares < 10) return 0.4;
    if (floatShares < 20) return 0.2;
    return 0.1;
  }

  scoreRelativeVolume(quote, avgVolume10Day) {
    if (!quote || !quote.v || !avgVolume10Day || avgVolume10Day <= 0) {
      return 0.5;
    }

    const relativeVolume = quote.v / (avgVolume10Day * 1000000);
    if (relativeVolume >= 5.0) return 1.0;
    if (relativeVolume >= 3.0) return 0.8;
    if (relativeVolume >= 2.0) return 0.6;
    if (relativeVolume >= 1.0) return 0.4;
    if (relativeVolume >= 0.5) return 0.3;
    return 0.2;
  }

  scorePriceRange(price) {
    if (!price) return 0;
    if (price >= 2 && price <= 20) return 1.0;
    if (price >= 1 && price < 2) return 0.7;
    if (price > 20 && price <= 30) return 0.7;
    if (price > 30 && price <= 50) return 0.4;
    if (price < 1) return 0.3;
    return 0.2;
  }

  scoreGap(gap) {
    if (gap === null || gap === undefined) return 0.5;
    if (gap >= 10) return 1.0;
    if (gap >= 5) return 0.8;
    if (gap >= 2) return 0.6;
    if (gap >= 0) return 0.4;
    return 0.2;
  }

  scoreNewsSentiment(sentiment, side = 'long') {
    if (!sentiment || sentiment.sentiment === undefined || sentiment.sentiment === null) {
      return 0.5;
    }

    const score = sentiment.sentiment || 0;
    const isShort = side?.toLowerCase() === 'short';
    let qualityScore;

    if (score >= 0.7) qualityScore = 1.0;
    else if (score >= 0.4) qualityScore = 0.8;
    else if (score > 0.1) qualityScore = 0.6;
    else if (score >= -0.1) qualityScore = 0.5;
    else if (score >= -0.4) qualityScore = 0.4;
    else if (score >= -0.7) qualityScore = 0.2;
    else qualityScore = 0.1;

    if (isShort) {
      qualityScore = 1.0 - qualityScore + 0.1;
      qualityScore = Math.max(0.1, Math.min(1.0, qualityScore));
    }

    return qualityScore;
  }
}

module.exports = new StockTradeQualityService();
