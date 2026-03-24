<template>
  <div class="content-wrapper py-8">
    <div v-if="loading" class="flex items-center justify-center py-16">
      <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
    </div>

    <div
      v-else-if="error"
      class="bg-red-50 dark:bg-red-900/20 rounded-lg p-6 text-center"
    >
      <p class="text-red-700 dark:text-red-400">{{ error }}</p>
      <button @click="loadPosition" class="mt-4 btn-primary">
        Try Again
      </button>
    </div>

    <div v-else-if="position" class="space-y-6">
      <div class="flex items-start justify-between gap-4">
        <div>
          <button
            @click="router.push(buildPositionsListRoute())"
            class="flex items-center text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 mb-4"
          >
            <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>
            </svg>
            Back to Positions
          </button>

          <div class="flex items-center gap-4">
            <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary-500/20 via-primary-400/10 to-emerald-400/20 border border-primary-200/60 dark:border-primary-700/40 flex items-center justify-center">
              <span class="text-xl font-bold text-primary-700 dark:text-primary-300">
                {{ position.symbol.slice(0, 3) }}
              </span>
            </div>
            <div>
              <div class="flex items-center gap-3">
                <h1 class="heading-page mb-0">{{ position.symbol }}</h1>
                <span
                  class="px-2.5 py-1 text-xs font-semibold rounded-full"
                  :class="position.side === 'long'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300'
                    : 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-300'"
                >
                  {{ position.side }}
                </span>
                <span class="px-2.5 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                  {{ position.isClosed ? 'Closed Position' : 'Open Position' }}
                </span>
              </div>
              <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {{ position.isClosed ? 'Position view for closed broker-linked positions.' : 'Separate view for live trade-based positions, without lots/dividends investment logic.' }}
              </p>
            </div>
          </div>
        </div>

        <button
          @click="router.push(buildPositionsListRoute({ symbol: position.symbol }))"
          class="btn-secondary"
        >
          View All Symbol Positions
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-4">
          <p class="text-sm text-gray-500 dark:text-gray-400">Shares Held</p>
          <p class="text-2xl font-bold text-gray-900 dark:text-white mt-1">
            {{ formatQuantity(position.totalShares) }}
          </p>
          <p class="text-xs text-gray-400 mt-1">
            {{ formatQuantity(position.totalSharesTraded) }} traded
          </p>
        </div>

        <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-4">
          <p class="text-sm text-gray-500 dark:text-gray-400">Average Entry</p>
          <p class="text-2xl font-bold text-gray-900 dark:text-white mt-1">
            {{ formatCurrency(position.averageCostBasis) }}
          </p>
          <p class="text-xs text-gray-400 mt-1">
            Cost basis {{ formatCurrency(position.totalCostBasis) }}
          </p>
        </div>

        <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-4">
          <p class="text-sm text-gray-500 dark:text-gray-400">Current Value</p>
          <p class="text-2xl font-bold text-gray-900 dark:text-white mt-1">
            {{ formatCurrency(position.currentValue) }}
          </p>
          <p class="text-xs text-gray-400 mt-1">
            {{ position.currentPrice !== null ? `@ ${formatCurrency(position.currentPrice)}` : 'No live price' }}
          </p>
        </div>

        <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-4">
          <p class="text-sm text-gray-500 dark:text-gray-400">Unrealized P&L</p>
          <p
            class="text-2xl font-bold mt-1"
            :class="(position.unrealizedPnl || 0) >= 0 ? 'text-green-600' : 'text-red-600'"
          >
            {{ formatSignedCurrency(position.unrealizedPnl) }}
          </p>
          <p
            class="text-xs mt-1"
            :class="(position.unrealizedPnl || 0) >= 0 ? 'text-green-500' : 'text-red-500'"
          >
            {{ formatSignedPercent(position.unrealizedPnlPercent) }}
          </p>
        </div>

        <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-4">
          <p class="text-sm text-gray-500 dark:text-gray-400">Realized P&L</p>
          <p
            class="text-2xl font-bold mt-1"
            :class="realizedPnl >= 0 ? 'text-green-600' : 'text-red-600'"
          >
            {{ formatSignedCurrency(realizedPnl) }}
          </p>
          <p class="text-xs mt-1 text-gray-400">
            {{ realizedExitCount === 0 ? '0 exits yet' : `${realizedExitCount} realized exit${realizedExitCount === 1 ? '' : 's'}` }}
          </p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-6">
        <section class="bg-white dark:bg-gray-800 rounded-xl shadow-sm overflow-hidden">
          <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h2 class="text-lg font-semibold text-gray-900 dark:text-white">Position Timeline</h2>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {{ position.isClosed ? 'Executions that built this closed position.' : 'Executions that build the currently open position.' }}
            </p>
          </div>

          <div v-if="timelineRows.length === 0" class="px-6 py-10 text-sm text-gray-500 dark:text-gray-400">
            No execution details available for this position yet.
          </div>

          <div v-else class="divide-y divide-gray-200 dark:divide-gray-700">
            <div
              v-for="row in timelineRows"
              :key="row.id"
              class="px-6 py-4 flex items-start justify-between gap-4 border-l-4"
              :class="row.type === 'exit'
                ? 'border-red-400 bg-red-50/20 dark:border-red-500/80 dark:bg-red-950/10'
                : 'border-emerald-400 bg-emerald-50/20 dark:border-emerald-500/80 dark:bg-emerald-950/10'"
            >
              <div class="space-y-1">
                <div class="flex items-center gap-3">
                  <span
                    class="text-sm font-semibold"
                    :class="row.type === 'exit' ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-300'"
                  >
                    {{ row.label }}
                  </span>
                  <span class="px-2 py-0.5 rounded-full text-[11px] font-medium"
                    :class="position.side === 'long'
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300'
                      : 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-300'">
                    {{ position.side }}
                  </span>
                </div>
                <div class="text-sm text-gray-700 dark:text-gray-300">
                  <span
                    class="font-semibold"
                    :class="row.type === 'exit' ? 'text-red-500 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'"
                  >
                    {{ formatSignedQuantity(row.signedQuantity) }}
                  </span>
                  <span v-if="row.price !== null"> @ {{ formatCurrency(row.price) }}</span>
                  <span class="text-gray-400"> · {{ formatQuantity(row.runningQuantity) }} held</span>
                </div>
                <div class="text-xs text-gray-400">
                  {{ formatDateTime(row.tradeDate) }}
                </div>
              </div>

              <div class="text-right">
                <div
                  class="text-sm font-semibold"
                  :class="row.totalCost < 0 ? 'text-red-500 dark:text-red-400' : 'text-gray-900 dark:text-white'"
                >
                  {{ formatSignedCurrency(row.totalCost) }}
                </div>
                <button
                  v-if="row.tradeId"
                  @click="router.push({ name: 'trade-detail', params: { id: row.tradeId } })"
                  class="mt-2 text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300"
                >
                  Open trade
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useInvestmentsStore } from '@/stores/investments'
import api from '@/services/api'
import { toInternalPositionId, toPositionRouteId } from '@/utils/positionRoute'
import {
  buildPositionTimelineRows,
  calculateRealizedPositionStats,
  normalizeTradeExecutions
} from '@/utils/positionExecutions'
import { buildPositionsListRoute } from '@/utils/positionsView'
const route = useRoute()
const router = useRouter()
const investmentsStore = useInvestmentsStore()

const loading = ref(false)
const error = ref(null)
const position = ref(null)
const relatedTrades = ref([])

const timelineRows = computed(() => {
  return buildPositionTimelineRows(relatedTrades.value)
})

const realizedStats = computed(() => {
  const side = position.value?.side === 'short' ? 'short' : 'long'
  return calculateRealizedPositionStats(relatedTrades.value, side)
})

const realizedPnl = computed(() => realizedStats.value.realizedPnl)
const realizedExitCount = computed(() => realizedStats.value.realizedExitCount)

onMounted(loadPosition)
watch(() => route.params.id, loadPosition)

async function loadPosition() {
  const id = normalizePositionRouteId(route.params.id)
  if (!id) return

  loading.value = true
  error.value = null

  try {
    const openPosition = await loadOpenPosition(id)
    if (openPosition) {
      position.value = openPosition.position
      relatedTrades.value = openPosition.trades
      return
    }

    let holding = null

    try {
      holding = await investmentsStore.getHolding(id)
    } catch (holdingError) {
      const message = holdingError?.response?.data?.error || holdingError?.message || ''
      const isNotFound = holdingError?.response?.status === 404 || /holding not found/i.test(message)
      if (!isNotFound) {
        throw holdingError
      }
    }

    if (holding && holding.source === 'trades') {
      if (holding.id && holding.id !== id) {
        await router.replace({
          name: 'position-detail',
          params: { id: toPositionRouteId(holding.id) }
        })
      }

      position.value = holding
      relatedTrades.value = Array.isArray(holding.linkedTrades) ? holding.linkedTrades : []
      return
    }

    const positionRecord = await loadPositionRecord(id)
    if (!positionRecord) {
      throw new Error('Position not found')
    }

    position.value = positionRecord.position
    relatedTrades.value = positionRecord.trades
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || 'Failed to load position'
  } finally {
    loading.value = false
  }
}

async function loadOpenPosition(positionId) {
  const response = await api.get('/trades/open-positions-quotes', {
    params: { skipQuotes: 'false' }
  })

  const positions = Array.isArray(response.data?.positions) ? response.data.positions : []
  const matchedPosition = positions.find(item =>
    item?.id === positionId
    || item?.legacyId === positionId
    || toInternalPositionId(item?.id) === positionId
  )

  if (!matchedPosition) {
    return null
  }

  return {
    position: {
      id: matchedPosition.id,
      legacyId: matchedPosition.legacyId || null,
      symbol: matchedPosition.symbol,
      side: matchedPosition.side || 'long',
      source: 'trades',
      isClosed: false,
      totalShares: matchedPosition.totalQuantity || 0,
      totalSharesTraded: matchedPosition.totalSharesTraded || matchedPosition.totalQuantity || 0,
      averageCostBasis: matchedPosition.avgPrice ?? null,
      totalCostBasis: matchedPosition.totalCost || 0,
      currentPrice: matchedPosition.currentPrice ?? null,
      currentValue: matchedPosition.currentValue ?? null,
      unrealizedPnl: matchedPosition.unrealizedPnL ?? null,
      unrealizedPnlPercent: matchedPosition.unrealizedPnLPercent ?? null,
      realizedPnl: 0
    },
    trades: Array.isArray(matchedPosition.trades) ? matchedPosition.trades : []
  }
}

async function loadPositionRecord(positionId) {
  const positionResponse = await api.get(`/trades/positions/${encodeURIComponent(positionId)}`, {
    params: {}
  })

  const matchedPosition = positionResponse.data?.position || null

  if (!matchedPosition) {
    return null
  }

  const trades = Array.isArray(matchedPosition.linkedTrades)
    ? matchedPosition.linkedTrades
    : []

  if (trades.length === 0) {
    return null
  }

  const firstTrade = trades[0]
  const symbol = String(matchedPosition.symbol || firstTrade.symbol || route.query.symbol || '').toUpperCase()
  const side = firstTrade.side === 'short' ? 'short' : 'long'
  const executionEvents = trades
    .flatMap(trade => normalizeTradeExecutions(trade))
    .sort((a, b) => new Date(a.datetime || 0) - new Date(b.datetime || 0))

  let totalEntryQuantity = 0
  let totalEntryCost = 0
  let realizedPnlTotal = 0

  for (const execution of executionEvents) {
    if (execution.type === 'entry' && Number.isFinite(execution.price)) {
      totalEntryQuantity += execution.quantity
      totalEntryCost += execution.quantity * execution.price
      continue
    }

    if (execution.type === 'exit') {
      const explicitRealized = parseFloat(execution.realizedPnl ?? execution.realizedPNL ?? execution.pnl)
      if (Number.isFinite(explicitRealized)) {
        realizedPnlTotal += explicitRealized
      }
    }
  }

  if (!Number.isFinite(realizedPnlTotal) || realizedPnlTotal === 0) {
    realizedPnlTotal = trades.reduce((sum, trade) => sum + (parseFloat(trade.pnl) || 0), 0)
  }

  return {
    position: {
      id: positionId,
      symbol,
      side,
      source: 'trades',
      isClosed: true,
      totalShares: 0,
      totalSharesTraded: totalEntryQuantity,
      averageCostBasis: totalEntryQuantity > 0 ? totalEntryCost / totalEntryQuantity : null,
      totalCostBasis: totalEntryCost,
      currentPrice: null,
      currentValue: 0,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      realizedPnl: realizedPnlTotal
    },
    trades
  }
}

function normalizePositionRouteId(value) {
  return toInternalPositionId(value)
}

function formatCurrency(value) {
  const numeric = parseFloat(value)
  if (!Number.isFinite(numeric)) return '-'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: numeric >= 1000 ? 2 : 2,
    maximumFractionDigits: numeric >= 1000 ? 2 : 4
  }).format(numeric)
}

function formatQuantity(value) {
  const numeric = parseFloat(value)
  if (!Number.isFinite(numeric)) return '-'
  if (Math.abs(numeric) >= 100) return numeric.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (Math.abs(numeric) >= 1) return numeric.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return numeric.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

function formatSignedQuantity(value) {
  const numeric = parseFloat(value)
  if (!Number.isFinite(numeric)) return '-'
  return `${numeric >= 0 ? '+' : '-'}${formatQuantity(Math.abs(numeric))}`
}

function formatSignedCurrency(value) {
  const numeric = parseFloat(value)
  if (!Number.isFinite(numeric)) return '-'
  return `${numeric >= 0 ? '+' : '-'}${formatCurrency(Math.abs(numeric))}`
}

function formatSignedPercent(value) {
  const numeric = parseFloat(value)
  if (!Number.isFinite(numeric)) return '-'
  return `${numeric >= 0 ? '+' : '-'}${Math.abs(numeric).toFixed(2)}%`
}

function formatDateTime(value) {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}
</script>
