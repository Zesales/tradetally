const finnhub = require('../../utils/finnhub');
const stockTradeQualityService = require('./stockTradeQuality.service');
const cryptoTradeQualityService = require('./cryptoTradeQuality.service');

class TradeQualityControllerService {
  resolveQualityModel(symbol, instrumentType = null) {
    const normalizedInstrumentType = String(instrumentType || '').trim().toLowerCase();
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();

    if (
      normalizedInstrumentType === 'crypto' ||
      finnhub.isCryptoSymbol(normalizedSymbol) ||
      finnhub.isCryptoPairSymbol(normalizedSymbol)
    ) {
      return 'crypto';
    }

    if (['future', 'futures'].includes(normalizedInstrumentType)) {
      return 'unsupported';
    }

    return 'stock';
  }

  getServiceForTrade(symbol, instrumentType = null) {
    const model = this.resolveQualityModel(symbol, instrumentType);

    if (model === 'crypto') {
      return cryptoTradeQualityService;
    }

    if (model === 'stock') {
      return stockTradeQualityService;
    }

    return null;
  }

  async calculateQuality(symbol, entryTime, entryPrice, side = 'long', userId = null, newsSentiment = null, instrumentType = null) {
    const service = this.getServiceForTrade(symbol, instrumentType);
    if (!service) {
      console.log(`[QUALITY] Skipping unsupported instrument for quality grading: ${symbol} (${instrumentType || 'unknown'})`);
      return null;
    }

    return service.calculateQuality(symbol, entryTime, entryPrice, side, userId, newsSentiment, instrumentType);
  }

  async calculateBatchQuality(trades) {
    const results = [];

    for (const trade of trades) {
      const quality = await this.calculateQuality(
        trade.symbol,
        trade.entry_time,
        trade.entry_price,
        trade.side || 'long',
        trade.user_id,
        trade.news_sentiment || null,
        trade.instrument_type || null
      );

      results.push({
        tradeId: trade.id,
        quality
      });

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return results;
  }
}

module.exports = new TradeQualityControllerService();
