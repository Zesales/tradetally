class OpenPositionBrokerPolicyService {
  static getPositionBrokers(position = {}) {
    return [...new Set(
      (Array.isArray(position?.trades) ? position.trades : [])
        .map(trade => String(trade?.broker || '').toLowerCase())
        .filter(Boolean)
    )];
  }

  static shouldExposeAsHolding(position = {}) {
    const brokers = this.getPositionBrokers(position);

    if (brokers.includes('bitunix')) {
      // Bitunix sync currently uses the futures API only. Until spot holdings are imported
      // separately, keep Bitunix trade-based positions out of Holdings/Investments so
      // leveraged futures are not mistaken for owned spot assets such as BTC spot.
      return false;
    }

    return true;
  }
}

module.exports = OpenPositionBrokerPolicyService;
