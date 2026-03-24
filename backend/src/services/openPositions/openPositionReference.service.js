const POSITION_REFERENCE_FIELDS = [
  'positionId',
  'position_id',
  'positionKey',
  'position_key',
  'brokerPositionId',
  'broker_position_id',
  'sourcePositionId',
  'source_position_id'
];

class OpenPositionReferenceService {
  static parseExecutions(trade = {}) {
    if (!trade?.executions) {
      return [];
    }

    if (Array.isArray(trade.executions)) {
      return trade.executions;
    }

    if (typeof trade.executions === 'string') {
      try {
        const parsed = JSON.parse(trade.executions);
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        return [];
      }
    }

    return [];
  }

  static normalizeReferenceValue(value) {
    if (value === undefined || value === null) {
      return null;
    }

    const normalized = String(value).trim();
    return normalized ? normalized : null;
  }

  static extractReferenceFromRecord(record = {}) {
    for (const field of POSITION_REFERENCE_FIELDS) {
      const value = this.normalizeReferenceValue(record?.[field]);
      if (value) {
        return value;
      }
    }

    return null;
  }

  static extractTradePositionReferences(trade = {}) {
    const references = new Set();
    const topLevelReference = this.extractReferenceFromRecord(trade);
    if (topLevelReference) {
      references.add(topLevelReference);
    }

    for (const execution of this.parseExecutions(trade)) {
      const reference = this.extractReferenceFromRecord(execution);
      if (reference) {
        references.add(reference);
      }
    }

    return Array.from(references);
  }

  static hasTradePositionReference(trade = {}) {
    return this.extractTradePositionReferences(trade).length > 0;
  }

  static buildTradePositionGroupKey(trade = {}) {
    const references = this.extractTradePositionReferences(trade);
    if (references.length === 0) {
      return null;
    }

    const broker = String(trade?.broker || 'unknown').toLowerCase();
    return `${broker}:${references[0]}`;
  }
}

module.exports = OpenPositionReferenceService;
