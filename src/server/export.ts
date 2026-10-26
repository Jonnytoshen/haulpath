import ExcelJS from 'exceljs';
import { PLANNING_NOTICE, routeStatus, strategyLabels, type Project, type Route } from '@/lib/domain';

const overviewColumns = [
  { header: '项目名称', key: 'project', width: 24 },
  { header: '线路编号', key: 'routeId', width: 38 },
  { header: '线路名称', key: 'route', width: 28 },
  { header: '起点', key: 'origin', width: 24 },
  { header: '终点', key: 'destination', width: 24 },
  { header: '有序点位', key: 'points', width: 60 },
  { header: '总里程（km）', key: 'distance', width: 18, style: { numFmt: '0.000' } },
  { header: '规划偏好', key: 'strategy', width: 32, style: { alignment: { wrapText: true } } },
  { header: '计算时间', key: 'calculatedAt', width: 24 },
  { header: '状态', key: 'status', width: 14 },
];
const detailColumns = [
  { header: '项目名称', key: 'project', width: 24 },
  { header: '线路编号', key: 'routeId', width: 38 },
  { header: '线路名称', key: 'route', width: 28 },
  { header: '区间序号', key: 'index', width: 14 },
  { header: '区间起点', key: 'origin', width: 24 },
  { header: '区间终点', key: 'destination', width: 24 },
  { header: '区间里程（km）', key: 'distance', width: 18, style: { numFmt: '0.000' } },
  { header: '累计里程（km）', key: 'cumulativeDistance', width: 18, style: { numFmt: '0.000' } },
];

function addSheet(workbook: ExcelJS.Workbook, name: string, columns: Partial<ExcelJS.Column>[]) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 2 }] });
  sheet.columns = columns.map(({ header: _header, ...column }) => column);
  sheet.mergeCells(1, 1, 1, columns.length);
  sheet.getCell('A1').value = PLANNING_NOTICE;
  sheet.getRow(1).height = 28;
  sheet.getCell('A1').font = { bold: true, color: { argb: 'FF9A3412' } };
  sheet.getCell('A1').alignment = { vertical: 'middle' };
  const headers = sheet.getRow(2);
  headers.values = columns.map((column) => column.header as string);
  headers.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headers.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  headers.height = 24;
  sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: columns.length } };
  return sheet;
}

function shanghaiTime(timestamp: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

export async function exportWorkbook(project: Project, routes: Route[]): Promise<Uint8Array<ArrayBuffer>> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '重途';
  const overview = addSheet(workbook, '线路总览', overviewColumns);
  const details = addSheet(workbook, '区间明细', detailColumns);
  for (const route of routes) {
    const status = routeStatus(route);
    const snapshot = status === '已规划' ? route.snapshot : null;
    overview.addRow({
      project: project.name, routeId: route.id, route: route.name,
      origin: route.points.at(0)?.name ?? null, destination: route.points.at(-1)?.name ?? null,
      points: route.points.length ? route.points.map((point) => point.name).join(' → ') : null,
      distance: snapshot ? snapshot.totalDistanceMeters / 1000 : null,
      strategy: strategyLabels[route.strategy], calculatedAt: snapshot ? shanghaiTime(snapshot.calculatedAt) : null, status,
    });
    if (snapshot) {
      let cumulativeMeters = 0;
      for (const leg of snapshot.legs) {
        cumulativeMeters += leg.distanceMeters;
        details.addRow({
          project: project.name, routeId: route.id, route: route.name, index: leg.index,
          origin: leg.from.name, destination: leg.to.name, distance: leg.distanceMeters / 1000,
          cumulativeDistance: cumulativeMeters / 1000,
        });
      }
    }
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
