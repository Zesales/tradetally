const OpenPositionIdentityService = require('./openPositionIdentity.service');
const OpenPositionReferenceService = require('./openPositionReference.service');

class OpenPositionTradeTransformerService {
  static parseTradeExecutions(trades = []) {
    trades.forEach(trade => {
      trade.executions = OpenPositionReferenceService.parseExecutions(trade);
    });

    return trades;
  }

  static enrichTradeWithPositionMetadata(trade = {}) {
    const positionKey = OpenPositionReferenceService.buildTradePositionGroupKey(trade);
    const positionReferences = OpenPositionReferenceService.extractTradePositionReferences(trade);

    if (!positionKey) {
      trade.positionKey = null;
      trade.positionRouteId = null;
      trade.positionReferences = positionReferences;
      return trade;
    }

    trade.positionKey = positionKey;
    trade.positionReferences = positionReferences;
    trade.positionRouteId = OpenPositionIdentityService.buildPositionId({
      positionKey,
      symbol: trade.symbol,
      side: trade.side,
      instrumentType: trade.instrument_type || trade.instrumentType || 'stock'
    });

    return trade;
  }

  static normalizeTradeForApi(trade = {}) {
    if (trade.contract_month !== undefined) trade.contractMonth = trade.contract_month;
    if (trade.contract_year !== undefined) trade.contractYear = trade.contract_year;
    if (trade.underlying_asset !== undefined) trade.underlyingAsset = trade.underlying_asset;
    if (trade.instrument_type !== undefined) trade.instrumentType = trade.instrument_type;
    if (trade.strike_price !== undefined) trade.strikePrice = trade.strike_price;
    if (trade.expiration_date !== undefined) trade.expirationDate = trade.expiration_date;
    if (trade.option_type !== undefined) trade.optionType = trade.option_type;
    if (trade.contract_size !== undefined) trade.contractSize = trade.contract_size;
    if (trade.underlying_symbol !== undefined) trade.underlyingSymbol = trade.underlying_symbol;
    if (trade.point_value !== undefined) trade.pointValue = trade.point_value;
    if (trade.tick_size !== undefined) trade.tickSize = trade.tick_size;
    if (trade.stop_loss !== undefined) trade.stopLoss = trade.stop_loss;
    if (trade.take_profit !== undefined) trade.takeProfit = trade.take_profit;
    if (trade.r_value !== undefined) trade.rValue = trade.r_value;
    if (trade.quality_grade !== undefined) trade.qualityGrade = trade.quality_grade;
    if (trade.quality_score !== undefined) trade.qualityScore = trade.quality_score;
    if (trade.quality_metrics !== undefined) trade.qualityMetrics = trade.quality_metrics;

    return this.enrichTradeWithPositionMetadata(trade);
  }

  static normalizeTradesForApi(trades = []) {
    return trades.map(trade => this.normalizeTradeForApi(trade));
  }
}

module.exports = OpenPositionTradeTransformerService;
