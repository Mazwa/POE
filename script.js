const LEAGUE_FILES = [
  { label: 'Necropolis', path: 'Necropolis.currency.csv' },
  { label: 'Settlers', path: 'Settlers.currency.csv' },
  { label: 'Phrecia', path: 'Phrecia.currency.csv' }
];

const HOLD_DURATIONS = [1, 2, 4, 8, 16, 32, 64];
const LEAGUE_NAMES = LEAGUE_FILES.map(({ label }) => label);
const THREE_MONTHS_IN_DAYS = 92;

const state = {
  data: null,
  investmentResults: [],
  currentWindow: { buyDay: 3, sellDay: 6 },
  chart: null,
  selectedItem: null,
  tableFilter: null
};

const resultsTableBody = document.querySelector('#results-table tbody');
const priceCanvas = document.getElementById('price-chart');
const searchInput = document.getElementById('item-search');
const searchButton = document.getElementById('item-search-btn');
const datalist = document.getElementById('item-options');
const chartTitle = document.getElementById('chart-title');
const chartSubtitle = document.getElementById('chart-subtitle');
const chartContainer = document.querySelector('.chart-container');
const chartEmpty = document.getElementById('chart-empty');

async function loadData() {
  const leaguePromises = LEAGUE_FILES.map(async (file) => {
    const response = await fetch(file.path);
    if (!response.ok) {
      throw new Error(`Failed to load ${file.path}`);
    }
    const text = await response.text();
    return parseLeagueCSV(text, file.label);
  });

  const leagueData = await Promise.all(leaguePromises);
  return buildDataset(leagueData);
}

function parseLeagueCSV(text, expectedLeagueName) {
  const rows = text.trim().split(/\r?\n/);
  const header = rows.shift();
  if (!header || !header.includes(';')) {
    throw new Error(`Unexpected header for ${expectedLeagueName}`);
  }

  const entries = [];
  for (const row of rows) {
    if (!row.trim()) continue;
    const [league, dateStr, get, pay, valueStr, confidence] = row.split(';');
    if (league !== expectedLeagueName) continue;
    if (pay !== 'Chaos Orb') continue;
    const value = Number.parseFloat(valueStr);
    if (!Number.isFinite(value)) continue;
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) continue;
    entries.push({ league, date, item: get, value, confidence });
  }
  return { league: expectedLeagueName, entries };
}

function buildDataset(leagueData) {
  const dataset = {
    leagues: {},
    items: {},
    itemNames: new Set()
  };

  for (const { league, entries } of leagueData) {
    if (!entries.length) continue;
    const startDate = entries.reduce((min, entry) => entry.date < min ? entry.date : min, entries[0].date);
    const cutoff = new Date(startDate);
    cutoff.setDate(cutoff.getDate() + THREE_MONTHS_IN_DAYS);

    const items = {};
    for (const entry of entries) {
      if (entry.date > cutoff) continue;
      const day = Math.round((entry.date - startDate) / (1000 * 60 * 60 * 24));
      if (day < 0) continue;
      if (!items[entry.item]) {
        items[entry.item] = [];
      }
      items[entry.item].push({ ...entry, day });
      dataset.itemNames.add(entry.item);
    }

    for (const itemName of Object.keys(items)) {
      items[itemName].sort((a, b) => a.day - b.day);
      const dayIndex = Object.fromEntries(items[itemName].map((entry) => [entry.day, entry.value]));
      items[itemName] = { entries: items[itemName], dayIndex };
    }

    dataset.leagues[league] = { startDate, items };
  }

  // Build inverted index for items
  for (const [leagueName, leagueInfo] of Object.entries(dataset.leagues)) {
    for (const [itemName, itemData] of Object.entries(leagueInfo.items)) {
      if (!dataset.items[itemName]) {
        dataset.items[itemName] = { leagueData: {} };
      }
      dataset.items[itemName].leagueData[leagueName] = itemData;
    }
  }

  dataset.itemNames = Array.from(dataset.itemNames).sort((a, b) => a.localeCompare(b));
  return dataset;
}

function computeInvestmentResults(buyDay, sellDay) {
  if (buyDay >= sellDay) {
    return [];
  }

  const results = [];
  const holdDuration = sellDay - buyDay;

  for (const [itemName, itemInfo] of Object.entries(state.data.items)) {
    const leagueMetrics = [];

    for (const [leagueName, data] of Object.entries(itemInfo.leagueData)) {
      const buyPrice = data.dayIndex[buyDay];
      const sellPrice = data.dayIndex[sellDay];
      if (!Number.isFinite(buyPrice) || !Number.isFinite(sellPrice) || buyPrice <= 0) {
        continue;
      }
      const growthFactor = sellPrice / buyPrice;
      if (!Number.isFinite(growthFactor) || growthFactor <= 0) {
        continue;
      }
      const compoundReturn = growthFactor - 1;
      const dailyReturn = Math.pow(growthFactor, 1 / holdDuration) - 1;
      leagueMetrics.push({ leagueName, buyPrice, sellPrice, compoundReturn, dailyReturn });
    }

    if (!leagueMetrics.length) continue;

    const avgBuy = average(leagueMetrics.map((m) => m.buyPrice));
    const avgSell = average(leagueMetrics.map((m) => m.sellPrice));
    const avgDailyReturn = average(leagueMetrics.map((m) => m.dailyReturn));
    const leagueBreakdown = Object.fromEntries(
      leagueMetrics.map((metric) => [metric.leagueName, {
        buyPrice: metric.buyPrice,
        sellPrice: metric.sellPrice,
        compoundReturn: metric.compoundReturn,
        dailyReturn: metric.dailyReturn
      }])
    );

    results.push({
      itemName,
      avgBuy,
      avgSell,
      avgDailyReturn,
      leagueBreakdown
    });
  }

  return results
    .filter((result) => Number.isFinite(result.avgDailyReturn))
    .sort((a, b) => b.avgDailyReturn - a.avgDailyReturn);
}

function average(values) {
  if (!values.length) return NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatChaos(value) {
  if (!Number.isFinite(value)) return '–';
  if (value >= 10) return value.toFixed(1);
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '–';
  const percentage = value * 100;
  const formatted = percentage.toFixed(Math.abs(percentage) < 10 ? 2 : 1);
  return `${percentage >= 0 ? '+' : ''}${formatted}%`;
}

function renderResultsTable(results) {
  resultsTableBody.innerHTML = '';

  const rowsToRender = state.tableFilter
    ? results.filter((result) => result.itemName === state.tableFilter)
    : results.slice(0, 25);

  if (!rowsToRender.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.textContent = 'No matching historical opportunities found for this window.';
    row.appendChild(cell);
    resultsTableBody.appendChild(row);
    return;
  }

  for (const result of rowsToRender) {
    const row = document.createElement('tr');
    row.dataset.itemName = result.itemName;

    const avgBuyText = formatChaos(result.avgBuy);
    const avgSellText = formatChaos(result.avgSell);
    const avgDailyRoi = formatPercent(result.avgDailyReturn);
    const leagueRois = LEAGUE_NAMES.map((leagueName) => {
      const leagueMetrics = result.leagueBreakdown?.[leagueName];
      return formatPercent(leagueMetrics ? leagueMetrics.dailyReturn : NaN);
    });

    row.innerHTML = [
      `<td class="item-name">${result.itemName}</td>`,
      `<td class="roi-cell">${avgDailyRoi}</td>`,
      ...leagueRois.map((value) => `<td>${value}</td>`),
      `<td>${avgBuyText}</td>`,
      `<td>${avgSellText}</td>`
    ].join('');
    row.addEventListener('click', () => focusItem(result.itemName, { updateSearch: true }));
    resultsTableBody.appendChild(row);
  }
}

function populateItemSearch() {
  datalist.innerHTML = '';
  for (const name of state.data.itemNames) {
    const option = document.createElement('option');
    option.value = name;
    datalist.appendChild(option);
  }
}

function renderPriceChart(itemName, itemData) {
  if (state.chart) {
    state.chart.destroy();
  }

  const datasets = [];

  for (const [leagueName, data] of Object.entries(itemData.leagueData)) {
    const sortedEntries = data.entries;
    datasets.push({
      label: leagueName,
      data: sortedEntries.map((entry) => ({ x: entry.day, y: entry.value })),
      tension: 0.25,
      fill: false,
      borderWidth: 2,
      pointRadius: 2
    });
  }

  state.chart = new Chart(priceCanvas, {
    type: 'line',
    data: {
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          top: 6,
          bottom: 6,
          left: 8,
          right: 12
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: {
            display: true,
            text: 'League Day'
          },
          ticks: {
            precision: 0
          }
        },
        y: {
          title: {
            display: true,
            text: 'Chaos Orb Value'
          }
        }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label(context) {
              const { dataset, raw } = context;
              return `${dataset.label}: Day ${raw.x} → ${formatChaos(raw.y)}c`;
            }
          }
        },
        legend: {
          position: 'bottom',
          labels: {
            boxWidth: 12,
            padding: 10,
            font: {
              size: 11
            }
          }
        }
      }
    }
  });
}

function handleFormSubmit(event) {
  event.preventDefault();
  const buyDay = Number.parseInt(event.target['buy-day'].value, 10);
  const sellDay = Number.parseInt(event.target['sell-day'].value, 10);
  if (!Number.isFinite(buyDay) || !Number.isFinite(sellDay)) return;
  state.currentWindow = { buyDay, sellDay };
  state.investmentResults = computeInvestmentResults(buyDay, sellDay);
  renderResultsTable(state.investmentResults);
  highlightSelectedRow();
  if (state.selectedItem) {
    renderSelectedItemChart();
  }
}

function handleSearch() {
  const value = searchInput.value.trim();
  if (!value) {
    state.tableFilter = null;
    renderResultsTable(state.investmentResults);
    highlightSelectedRow();
    if (state.selectedItem) {
      renderSelectedItemChart();
    }
    return;
  }

  if (!state.data.items[value]) {
    alert('No historical data found for that item name.');
    return;
  }

  state.tableFilter = value;
  focusItem(value, { updateSearch: true });
}

function handleSearchInputChange() {
  if (searchInput.value.trim()) {
    return;
  }
  state.tableFilter = null;
  renderResultsTable(state.investmentResults);
  highlightSelectedRow();
  if (state.selectedItem) {
    renderSelectedItemChart();
  }
}

async function init() {
  try {
    state.data = await loadData();
    populateItemSearch();
    state.investmentResults = computeInvestmentResults(state.currentWindow.buyDay, state.currentWindow.sellDay);
    renderResultsTable(state.investmentResults);
    highlightSelectedRow();
    clearChart();
  } catch (error) {
    console.error(error);
    resultsTableBody.innerHTML = '';
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.textContent = 'Failed to load data. Please refresh the page.';
    row.appendChild(cell);
    resultsTableBody.appendChild(row);
  }
}

function highlightSelectedRow() {
  const rows = Array.from(resultsTableBody.querySelectorAll('tr'));
  for (const row of rows) {
    const isSelected = row.dataset.itemName === state.selectedItem;
    row.classList.toggle('is-active', isSelected);
  }
}

function clearChart() {
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
  chartTitle.textContent = 'Select an item to view price history';
  chartSubtitle.textContent = 'Choose an item from the table or search to plot its price across leagues.';
  chartContainer.setAttribute('data-empty', 'true');
  chartEmpty.hidden = false;
}

function renderSelectedItemChart() {
  const itemName = state.selectedItem;
  if (!itemName || !state.data?.items[itemName]) {
    clearChart();
    return;
  }

  const itemData = state.data.items[itemName];
  chartTitle.textContent = itemName;
  chartSubtitle.textContent = 'Chaos Orb price across leagues';
  chartContainer.setAttribute('data-empty', 'false');
  chartEmpty.hidden = true;
  renderPriceChart(itemName, itemData);
}

function focusItem(itemName, { updateSearch } = {}) {
  if (!state.data?.items[itemName]) {
    return;
  }
  state.selectedItem = itemName;
  state.tableFilter = itemName;
  if (updateSearch) {
    searchInput.value = itemName;
  }
  renderResultsTable(state.investmentResults);
  renderSelectedItemChart();
  highlightSelectedRow();
}

document.getElementById('screener-form').addEventListener('submit', handleFormSubmit);
searchButton.addEventListener('click', handleSearch);
searchInput.addEventListener('input', handleSearchInputChange);
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleSearch();
  }
});

document.addEventListener('DOMContentLoaded', init);
