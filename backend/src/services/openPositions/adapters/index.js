const BitunixOpenPositionAdapter = require('./bitunixOpenPositionAdapter');

const OPEN_POSITION_BROKER_ADAPTERS = {
  bitunix: BitunixOpenPositionAdapter
};

class OpenPositionBrokerAdapterRegistry {
  static getAdapter(broker) {
    return OPEN_POSITION_BROKER_ADAPTERS[String(broker || '').toLowerCase()] || null;
  }
}

module.exports = OpenPositionBrokerAdapterRegistry;
