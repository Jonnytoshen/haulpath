export function financeInput(year = 2030) {
  return {
    boundary: 'integrated',
    years: [
      {
        year,
        scopeSource: '手算案例：已列全部运营收支，不含税费及投资',
        stationCostMode: 'annual-lines',
        lines: [
          {
            id: 'freight',
            name: '运费',
            flow: 'transport-revenue',
            basis: 'tonne',
            rate: '100',
            source: '运输合同',
            stationId: null,
          },
          {
            id: 'vehicle',
            name: '车辆运行',
            flow: 'transport-cost',
            basis: 'vehicle-km',
            rate: '1',
            source: '车辆台账',
            stationId: null,
          },
          {
            id: 'swap',
            name: '内部换电',
            flow: 'internal-swap',
            basis: 'swap',
            rate: '20',
            source: '内部结算协议',
            stationId: null,
          },
          {
            id: 'fixed',
            name: '站方固定费',
            flow: 'station-cost',
            basis: 'year',
            rate: '30',
            source: '年度预算',
            stationId: null,
          },
        ],
        electricity: [],
      },
    ],
  };
}
