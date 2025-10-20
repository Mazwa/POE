const LEAGUE_FILES = [
  { label: 'Necropolis', path: 'Necropolis.currency.csv' },
  { label: 'Settlers', path: 'Settlers.currency.csv' },
  { label: 'Phrecia', path: 'Phrecia.currency.csv' },
  { label: 'Mercenaries', path: 'Mercenaries.currency.csv' }
];

const HOLD_DURATIONS = [1, 2, 4, 8, 16, 32, 64];
const THREE_MONTHS_IN_DAYS = 92;

const DEFAULT_SELECTED_LEAGUES = new Set(['Settlers', 'Phrecia']);
const LEAGUE_COLORS = {
  Necropolis: '#38bdf8',
  Settlers: '#f97316',
  Phrecia: '#a855f7',
  Mercenaries: '#facc15'
};

const state = {
  data: null,
  investmentResults: [],
  currentWindow: { buyDay: 3, sellDay: 6 },
  chart: null,
  selectedItem: null,
  tableFilter: null,
  selectedLeagues: new Set(DEFAULT_SELECTED_LEAGUES),
  priceFilter: { min: 0, max: 99999 }
};

const resultsTableBody = document.querySelector('#results-table tbody');
const resultsTableHeadRow = document.getElementById('results-header-row');
const priceCanvas = document.getElementById('price-chart');
const screenerForm = document.getElementById('screener-form');
const buyDayInput = document.getElementById('buy-day');
const sellDayInput = document.getElementById('sell-day');
const searchInput = document.getElementById('item-search');
const minPriceInput = document.getElementById('min-buy-price');
const maxPriceInput = document.getElementById('max-buy-price');
const datalist = document.getElementById('item-options');
const chartTitle = document.getElementById('chart-title');
const chartSubtitle = document.getElementById('chart-subtitle');
const chartContainer = document.querySelector('.chart-container');
const chartEmpty = document.getElementById('chart-empty');
const leagueFilterContainer = document.getElementById('league-filters');
const chartEmptyDefaultText = chartEmpty.textContent;

async function loadData() {
  const loadedLeagues = [];

  for (const file of LEAGUE_FILES) {
    if (!file.path) continue;
    try {
      const response = await fetch(file.path);
      if (!response.ok) {
        throw new Error(`Failed to load ${file.path}`);
      }
      const text = await response.text();
      loadedLeagues.push(parseLeagueCSV(text, file.label));
    } catch (error) {
      console.warn(`Skipping ${file.label}:`, error);
    }
  }

  return buildDataset(loadedLeagues);
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

function getSelectedLeagueNames() {
  return LEAGUE_FILES
    .filter(({ label }) => state.selectedLeagues.has(label))
    .map(({ label }) => label);
}

function computeInvestmentResults(buyDay, sellDay) {
  if (buyDay >= sellDay) {
    return [];
  }

  if (!state.data) {
    return [];
  }

  const selectedLeagueNames = getSelectedLeagueNames();
  if (!selectedLeagueNames.length) {
    return [];
  }

  const results = [];
  const holdDuration = sellDay - buyDay;

  for (const [itemName, itemInfo] of Object.entries(state.data.items)) {
    const leagueMetrics = [];

    for (const leagueName of selectedLeagueNames) {
      const data = itemInfo.leagueData[leagueName];
      if (!data) continue;
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

function renderTableHeader() {
  if (!resultsTableHeadRow) return;
  const selectedLeagueNames = getSelectedLeagueNames();
  const headerCells = [];

  const createHeaderCell = (text) => {
    const th = document.createElement('th');
    th.textContent = text;
    return th;
  };

  headerCells.push(createHeaderCell('Item'));
  headerCells.push(createHeaderCell('AvgDailyROI'));
  for (const league of selectedLeagueNames) {
    headerCells.push(createHeaderCell(league));
  }
  headerCells.push(createHeaderCell('Avg Buy'));
  headerCells.push(createHeaderCell('Avg Sell'));

  resultsTableHeadRow.replaceChildren(...headerCells);
}

function renderResultsTable(results) {
  resultsTableBody.innerHTML = '';
  const selectedLeagueNames = getSelectedLeagueNames();
  renderTableHeader();

  const filteredByPrice = results.filter((result) => {
    const { min, max } = state.priceFilter;
    const avgBuy = result.avgBuy;
    if (!Number.isFinite(avgBuy)) {
      return false;
    }

    const isCollapsedRange = Math.abs(max - min) < Number.EPSILON;
    if (isCollapsedRange) {
      return Math.abs(avgBuy - min) < Number.EPSILON;
    }

    const meetsMin = min === 0 ? avgBuy >= min : avgBuy > min;
    return meetsMin && avgBuy <= max;
  });

  const isItemFilterActive = Boolean(state.tableFilter);
  const baseResults = isItemFilterActive ? results : filteredByPrice;
  const rowsToRender = isItemFilterActive
    ? baseResults.filter((result) => result.itemName === state.tableFilter)
    : baseResults.slice(0, 25);

  if (!rowsToRender.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = selectedLeagueNames.length + 4;
    if (!selectedLeagueNames.length) {
      cell.textContent = 'Select at least one league to display results.';
    } else if (!results.length) {
      cell.textContent = 'No matching historical opportunities found for this window.';
    } else if (!filteredByPrice.length) {
      cell.textContent = 'No items fall within the selected buy price range.';
    } else {
      cell.textContent = 'No matching historical opportunities found for this item.';
    }
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
    const leagueRois = selectedLeagueNames.map((leagueName) => {
      const leagueMetrics = result.leagueBreakdown?.[leagueName];
      return formatPercent(leagueMetrics ? leagueMetrics.dailyReturn : NaN);
    });

    const cells = [
      `<td class="item-name">${result.itemName}</td>`,
      `<td class="roi-cell">${avgDailyRoi}</td>`,
      ...leagueRois.map((value) => `<td>${value}</td>`),
      `<td>${avgBuyText}</td>`,
      `<td>${avgSellText}</td>`
    ];
    row.innerHTML = cells.join('');
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

function renderPriceChart(itemName, itemData, leagues) {
  if (state.chart) {
    state.chart.destroy();
  }

  const datasets = [];

  for (const leagueName of leagues) {
    const data = itemData.leagueData[leagueName];
    if (!data) continue;
    const sortedEntries = data.entries;
    const color = LEAGUE_COLORS[leagueName] || undefined;
    datasets.push({
      label: leagueName,
      data: sortedEntries.map((entry) => ({ x: entry.day, y: entry.value })),
      tension: 0.25,
      fill: false,
      borderWidth: 2,
      pointRadius: 2,
      borderColor: color,
      backgroundColor: color
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

function applyWindowChange() {
  if (!buyDayInput || !sellDayInput) {
    return;
  }

  const buyDay = Number.parseInt(buyDayInput.value, 10);
  const sellDay = Number.parseInt(sellDayInput.value, 10);
  if (!Number.isFinite(buyDay) || !Number.isFinite(sellDay)) {
    return;
  }

  state.currentWindow = { buyDay, sellDay };

  if (!state.data) {
    return;
  }

  state.investmentResults = computeInvestmentResults(buyDay, sellDay);
  renderResultsTable(state.investmentResults);
  highlightSelectedRow();
  if (state.selectedItem) {
    renderSelectedItemChart();
  }
}

function handleWindowInputChange() {
  applyWindowChange();
}

function applySearchValue(rawValue, { shouldAlert = false } = {}) {
  if (!state.data) {
    return false;
  }

  const value = rawValue.trim();
  if (!value) {
    state.tableFilter = null;
    renderResultsTable(state.investmentResults);
    highlightSelectedRow();
    if (state.selectedItem) {
      renderSelectedItemChart();
    }
    return true;
  }

  if (!state.data.items[value]) {
    if (shouldAlert) {
      alert('No historical data found for that item name.');
    }
    return false;
  }

  if (state.selectedItem === value && state.tableFilter === value) {
    return true;
  }

  focusItem(value, { updateSearch: false });
  return true;
}

function handleSearch() {
  applySearchValue(searchInput.value, { shouldAlert: true });
}

function handleSearchInputChange() {
  applySearchValue(searchInput.value);
}

function clampPriceFilterValues(minValue, maxValue) {
  const boundedMin = Math.max(0, Math.min(99999, minValue));
  const boundedMax = Math.max(boundedMin, Math.min(99999, maxValue));
  return { min: boundedMin, max: boundedMax };
}

function handlePriceFilterChange() {
  const parsedMin = Number.parseFloat(minPriceInput.value);
  const parsedMax = Number.parseFloat(maxPriceInput.value);
  const sanitizedMin = Number.isFinite(parsedMin) ? parsedMin : state.priceFilter.min;
  const sanitizedMax = Number.isFinite(parsedMax) ? parsedMax : state.priceFilter.max;
  const { min, max } = clampPriceFilterValues(sanitizedMin, sanitizedMax);

  state.priceFilter = { min, max };
  minPriceInput.value = min.toString();
  maxPriceInput.value = max.toString();

  if (state.data) {
    renderResultsTable(state.investmentResults);
    highlightSelectedRow();
  }
}

async function init() {
  renderLeagueFilters();
  try {
    state.data = await loadData();
    populateItemSearch();
    applyWindowChange();
    clearChart();
  } catch (error) {
    console.error(error);
    resultsTableBody.innerHTML = '';
    renderTableHeader();
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = getSelectedLeagueNames().length + 4;
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
  chartEmpty.textContent = chartEmptyDefaultText;
}

function renderSelectedItemChart() {
  const itemName = state.selectedItem;
  if (!itemName || !state.data?.items[itemName]) {
    clearChart();
    return;
  }

  const itemData = state.data.items[itemName];
  const selectedLeagues = getSelectedLeagueNames();
  const availableLeagues = selectedLeagues.filter((league) => itemData.leagueData[league]?.entries?.length);

  chartTitle.textContent = itemName;

  if (!availableLeagues.length) {
    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
    chartSubtitle.textContent = 'No price data available for the selected leagues.';
    chartContainer.setAttribute('data-empty', 'true');
    chartEmpty.hidden = false;
    chartEmpty.textContent = 'No price data available for the selected leagues.';
    return;
  }

  chartSubtitle.textContent = 'Chaos Orb price across leagues';
  chartContainer.setAttribute('data-empty', 'false');
  chartEmpty.hidden = true;
  chartEmpty.textContent = chartEmptyDefaultText;
  renderPriceChart(itemName, itemData, availableLeagues);
}

function handleLeagueToggle(event) {
  const checkbox = event.target;
  if (!(checkbox instanceof HTMLInputElement)) {
    return;
  }

  if (checkbox.checked) {
    state.selectedLeagues.add(checkbox.value);
  } else {
    state.selectedLeagues.delete(checkbox.value);
  }

  state.investmentResults = computeInvestmentResults(state.currentWindow.buyDay, state.currentWindow.sellDay);
  renderResultsTable(state.investmentResults);
  highlightSelectedRow();

  if (state.selectedItem) {
    renderSelectedItemChart();
  } else {
    clearChart();
  }
}

function renderLeagueFilters() {
  if (!leagueFilterContainer) return;
  leagueFilterContainer.innerHTML = '';

  for (const { label } of LEAGUE_FILES) {
    const option = document.createElement('label');
    option.className = 'checkbox-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = label;
    checkbox.checked = state.selectedLeagues.has(label);
    checkbox.addEventListener('change', handleLeagueToggle);

    const text = document.createElement('span');
    text.textContent = label;

    option.appendChild(checkbox);
    option.appendChild(text);
    leagueFilterContainer.appendChild(option);
  }
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

if (screenerForm) {
  screenerForm.addEventListener('submit', (event) => event.preventDefault());
}
if (buyDayInput) {
  buyDayInput.addEventListener('input', handleWindowInputChange);
  buyDayInput.addEventListener('change', handleWindowInputChange);
}
if (sellDayInput) {
  sellDayInput.addEventListener('input', handleWindowInputChange);
  sellDayInput.addEventListener('change', handleWindowInputChange);
}
searchInput.addEventListener('input', handleSearchInputChange);
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleSearch();
  }
});
minPriceInput.addEventListener('change', handlePriceFilterChange);
maxPriceInput.addEventListener('change', handlePriceFilterChange);

document.addEventListener('DOMContentLoaded', init);
